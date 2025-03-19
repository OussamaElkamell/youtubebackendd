
const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const { YouTubeAccountModel } = require('../models/youtube-account.model');
const { CommentModel } = require('../models/comment.model');
const { createProxyAgent } = require('./proxy.service');

/**
 * Refresh an OAuth2 token if needed
 * @param {Object} account YouTube account from the database
 * @param {Boolean} force Force token refresh even if not expired
 */
async function refreshTokenIfNeeded(account, force = false) {
  try {
    // Check if token needs refresh
    if (!force && !account.needsTokenRefresh()) {
      return { success: true, message: 'Token still valid' };
    }
    
    if (!account.google.refreshToken) {
      return { 
        success: false, 
        error: 'No refresh token available. User needs to re-authenticate.' 
      };
    }
    
    // Set up OAuth2 client
    const oauth2Client = new OAuth2Client(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    
    // Set refresh token
    oauth2Client.setCredentials({
      refresh_token: account.google.refreshToken
    });
    
    // Get new access token
    const response = await oauth2Client.refreshAccessToken();
    const tokens = response.credentials;
    
    // Update account with new tokens
    account.google.accessToken = tokens.access_token;
    account.google.tokenExpiry = new Date(tokens.expiry_date);
    await account.save();
    
    return { success: true, message: 'Token refreshed successfully' };
  } catch (error) {
    console.error('Error refreshing token:', error);
    
    // Mark account as inactive if refresh fails
    account.status = 'inactive';
    await account.save();
    
    return { 
      success: false, 
      error: error.message || 'Failed to refresh token' 
    };
  }
}

/**
 * Post a comment to YouTube
 * @param {String} commentId MongoDB ID of the comment
 */
async function postComment(commentId) {
  try {
    // Get comment from database
    const comment = await CommentModel.findById(commentId)
      .populate({
        path: 'youtubeAccount',
        populate: { path: 'proxy' }
      });
    
    if (!comment) {
      throw new Error('Comment not found');
    }
    
    const account = comment.youtubeAccount;
    
    // Check account status
    if (account.status !== 'active') {
      throw new Error(`YouTube account is ${account.status}`);
    }
    
    // Refresh token if needed
    const refreshResult = await refreshTokenIfNeeded(account);
    if (!refreshResult.success) {
      throw new Error(refreshResult.error);
    }
    
    // Set up YouTube API client with proxy if available
    const youtube = await getYouTubeClient(account);
    
    // Prepare comment data
    const commentData = {
      snippet: {
        videoId: comment.videoId,
        textOriginal: comment.content
      }
    };
    
    // Add parent ID for replies
    if (comment.parentId) {
      commentData.snippet.parentId = comment.parentId;
    }
    
    // Post the comment
    const response = await youtube.commentThreads.insert({
      part: 'snippet',
      requestBody: commentData
    });
    
    // Update comment with ID from YouTube
    const commentThread = response.data;
    const youtubeCommentId = commentThread.id;
    
    // Update daily usage counter
    await updateDailyUsage(account._id, 'commentCount');
    
    return { 
      success: true, 
      commentId: youtubeCommentId,
      message: 'Comment posted successfully' 
    };
  } catch (error) {
    console.error('Error posting comment:', error);
    
    // Check for quota exceeded error
    if (error.message.includes('quotaExceeded') || 
        error.message.includes('dailyLimitExceeded')) {
      try {
        const account = comment.youtubeAccount;
        account.status = 'limited';
        await account.save();
      } catch (updateError) {
        console.error('Error updating account status:', updateError);
      }
    }
    
    return { 
      success: false, 
      error: error.message || 'Failed to post comment' 
    };
  }
}

/**
 * Update daily usage counter for a YouTube account
 * @param {String} accountId YouTube account ID
 * @param {String} type Type of action (commentCount, likeCount)
 */
async function updateDailyUsage(accountId, type) {
  try {
    const account = await YouTubeAccountModel.findById(accountId);
    
    if (!account) {
      return false;
    }
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Reset counter if it's a new day
    if (!account.dailyUsage.date || new Date(account.dailyUsage.date).getTime() !== today.getTime()) {
      account.dailyUsage = {
        date: today,
        commentCount: 0,
        likeCount: 0
      };
    }
    
    // Increment the specified counter
    if (type === 'commentCount') {
      account.dailyUsage.commentCount += 1;
    } else if (type === 'likeCount') {
      account.dailyUsage.likeCount += 1;
    }
    
    // Update lastUsed timestamp
    account.lastUsed = new Date();
    
    await account.save();
    return true;
  } catch (error) {
    console.error('Error updating daily usage:', error);
    return false;
  }
}

/**
 * Get a YouTube API client for a specific account
 * @param {Object} account YouTube account from database
 */
async function getYouTubeClient(account) {
  // Set up OAuth2 client
  const oauth2Client = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  
  // Set credentials
  oauth2Client.setCredentials({
    access_token: account.google.accessToken,
    refresh_token: account.google.refreshToken
  });
  
  // Create YouTube client
  const youtube = google.youtube('v3');
  
  // Set up proxy agent if account has a proxy
  if (account.proxy) {
    const proxyAgent = await createProxyAgent(account.proxy);
    if (proxyAgent) {
      oauth2Client.getRequestHeaders = function(url) {
        return {
          'User-Agent': getRandomUserAgent(),
          ...this.credentials
        };
      };
      
      // Inject proxy agent into Axios instance
      youtube.context._options = {
        ...youtube.context._options,
        httpAgent: proxyAgent,
        httpsAgent: proxyAgent
      };
    }
  }
  
  return youtube;
}

/**
 * Get a random User-Agent string to mimic real browsers
 */
function getRandomUserAgent() {
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36'
  ];
  
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

module.exports = {
  refreshTokenIfNeeded,
  postComment,
  updateDailyUsage,
  getYouTubeClient,
  getRandomUserAgent
};
