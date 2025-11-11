
const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const { YouTubeAccountModel } = require('../models/youtube-account.model');
const { CommentModel } = require('../models/comment.model');

const { createProxyAgent } = require('./proxy.service');
const axios = require('axios');


const ApiProfile = require('../models/ApiProfile');
const { ScheduleModel } = require('../models/schedule.model');


async function getActiveProfile() {
  try {
    const profile = await ApiProfile.findOne({ isActive: true });
    if (!profile) {
      throw new Error('No active profile found');
    }
    return profile;
  } catch (err) {
    throw new Error(`Failed to get active profile: ${err.message}`);
  }
}


/**
 * Refresh an OAuth2 token if needed
 * @param {Object} account YouTube account from the database
 * @param {Boolean} force Force token refresh even if not expired
 */



async function refreshTokenIfNeeded(account) {
  const tryWithGoogleCredentials = async (googleCredentials) => {
    const oauth2Client = new OAuth2Client(
      googleCredentials.clientId,
      googleCredentials.clientSecret,
      googleCredentials.redirectUri
    );

    oauth2Client.setCredentials({
      refresh_token: googleCredentials.refreshToken
    });

    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      if (!credentials.access_token) {
        account.status = 'inactive';
        await account.save();
        throw new Error('Failed to obtain access token');
      }

      // Ensure we have a valid expiry time
      const expiresInMillis = (credentials.expiry_date || 
                              (credentials.expires_in ? (credentials.expires_in * 1000) : 3600 * 1000));
      const tokenExpiry = new Date(Date.now() + expiresInMillis);

      if (isNaN(tokenExpiry.getTime())) {
        throw new Error('Invalid token expiry date calculation');
      }

      // Update account with new access token and expiry time
      account.google.accessToken = credentials.access_token;
      account.google.tokenExpiry = tokenExpiry;
      await account.save();

      return oauth2Client;
    } catch (error) {
      account.status = 'inactive';
      await account.save();
      console.error(`Token refresh failed for account ${account._id}:`, error);
      throw error;
    }
  };

  try {
    if (!account.google?.refreshToken) {
      account.status = 'inactive';
      await account.save();
      throw new Error('No refresh token available. User needs to re-authenticate.');
    }

    return await tryWithGoogleCredentials(account.google);
  } catch (error) {
    account.status = 'inactive';
    await account.save();
    console.error('Token refresh failed:', error);
    throw new Error(error.message || 'Failed to refresh token');
  }
}


function addRandomEmojis(text) {
  const emojis = ['🎉', '🔥', '🚀', '💯', '✨', '😎', '👍', '🤩', '🥳'];
  const randomEmojis = Array.from({ length: 3 }, () => 
    emojis[Math.floor(Math.random() * emojis.length)]
  ).join('');

  return `${text} ${randomEmojis}`;
}
function randomizeSiParamInYoutubeUrl(content) {
  const regex = /https:\/\/youtu\.be\/[^\s?]+\?si=([a-zA-Z0-9_-]+)/g;
  return content.replace(regex, (match, oldSi) => {
    const newSi = generateRandomString(16); // 16-character string
    return match.replace(`?si=${oldSi}`, `?si=${newSi}`);
  });
}

function generateRandomString(length) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

/**
 * Post a comment to YouTube
 * @param {String} commentId MongoDB ID of the comment
 */
async function postComment(commentId) {
  try {
    // Get the comment with populated YouTube account and proxy
    const comment = await CommentModel.findById(commentId)
      .populate({
        path: "youtubeAccount",
        populate: { path: "proxy" },
      })
      .exec();

    if (!comment) throw new Error("Comment not found");

    const account = comment.youtubeAccount;
    if (!account || account.status === null) {
      console.warn("Account status is null, deleting comment...");
      await comment.deleteOne();
      return {
        success: false,
        message: "Comment deleted due to invalid account or status",
        error: null,
      };
    }

    if (account.status !== "active") {
      throw new Error(`YouTube account is ${account.status}`);
    }

    const schedule = await ScheduleModel.findById(comment.scheduleId).exec();
    const includeEmojis = schedule?.includeEmojis === true;

    const proxy = account.proxy;
    if (!proxy) {
      throw new Error("No proxy assigned to account");
    }

    // Use proxy agent
    const agent = await createProxyAgent(proxy);
    const oauth2Client = await refreshTokenIfNeeded(account);
    const youtube = google.youtube({ version: "v3", auth: oauth2Client });

    youtube.request = axios.create({
      httpsAgent: agent,
      httpAgent: agent,
    });

    // Validate comment content
    if (!comment.content || comment.content.trim() === "") {
      throw new Error("Comment content is empty");
    }

    let sanitizedContent = comment.content.trim();
    if (includeEmojis) {
      sanitizedContent = addRandomEmojis(sanitizedContent);
    }
    sanitizedContent = randomizeSiParamInYoutubeUrl(sanitizedContent);

    if (!sanitizedContent) {
      throw new Error("Comment content is empty after processing");
    }

    const commentData = {
      snippet: {
        videoId: comment.videoId,
        topLevelComment: {
          snippet: {
            textOriginal: sanitizedContent,
          },
        },
      },
    };

    if (comment.parentId) {
      commentData.snippet.parentId = comment.parentId;
      console.log("Posting reply to parentId:", comment.parentId);
    } else {
      console.log("Posting top-level comment to videoId:", comment.videoId);
    }

    const response = await youtube.commentThreads.insert({
      part: "snippet",
      requestBody: commentData,
    });

    const youtubeCommentId = response.data.id;

    // Update usage and schedule
    await updateDailyUsage(account._id, "commentCount");
    await ScheduleModel.findByIdAndUpdate(comment.scheduleId, {
      lastUsedAccount: account._id,
    });

    return {
      success: true,
      commentId: youtubeCommentId,
      message: "Comment posted successfully",
      error: null,
    };
  } catch (error) {
    console.error("Error posting comment:", error.message);

    // Quota exceeded handling
    if (
      error.message.includes("quotaExceeded") ||
      error.message.includes("dailyLimitExceeded")
    ) {
      try {
        const comment = await CommentModel.findById(commentId).populate("youtubeAccount");
        if (comment?.youtubeAccount) {
          comment.youtubeAccount.status = "limited";
          await comment.youtubeAccount.save();
          console.log("Account status updated to 'limited'.");
        }
      } catch (updateError) {
        console.error("Error updating account status:", updateError);
      }
    }

    return {
      success: false,
      message: error.message,
      error: error.message || "Unknown error",
    };
  }
}
async function postCommentToConsole(commentId) {
  try {
    const comment = await CommentModel.findById(commentId)
      .populate({
        path: "youtubeAccount",
        populate: { path: "proxy" },
      })
      .exec();

    if (!comment) throw new Error("Comment not found");

    const account = comment.youtubeAccount;
    const proxy = account?.proxy;

    if (!account || account.status === null) {
      console.warn("Invalid account, deleting comment...");
      await comment.deleteOne();
      return {
        success: false,
        message: "Comment deleted due to invalid account",
        error: null,
      };
    }

    if (account.status !== "active") {
      throw new Error(`YouTube account is ${account.status}`);
    }

    const schedule = await ScheduleModel.findById(comment.scheduleId).exec();
    const includeEmojis = schedule?.includeEmojis === true;

    let content = comment.content?.trim();
    if (!content) throw new Error("Comment content is empty");

    if (includeEmojis) content = addRandomEmojis(content);
    content = randomizeSiParamInYoutubeUrl(content);

    if (!content) throw new Error("Comment content empty after processing");

    // Simulate posting the comment
    console.log("📢 Simulated Comment Post:");
    console.log(`👤 Account: ${account.username || account._id}`);
    console.log(`🎯 Video ID: ${comment.videoId}`);
    console.log(`💬 Content: ${content}`);
    if (comment.parentId) console.log(`↪️ Replying to: ${comment.parentId}`);
    if (proxy) console.log(`🌐 Proxy: ${proxy.ip}:${proxy.port}`);

    // Simulate updating usage
    await ScheduleModel.findByIdAndUpdate(comment.scheduleId, {
      lastUsedAccount: account._id,
    });

    return {
      success: true,
      message: "Comment simulated and logged to console",
      error: null,
    };
  } catch (error) {
    console.error("❌ Error simulating comment post:", error.message);
    return {
      success: false,
      message: error.message,
      error: error.stack,
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
  const activeProfile = await getActiveProfile();
  const oauth2Client = new OAuth2Client(
    activeProfile.clientId,
    activeProfile.clientSecret,
    activeProfile.redirectUri
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
   postCommentToConsole,
  getYouTubeClient,
  getRandomUserAgent
};