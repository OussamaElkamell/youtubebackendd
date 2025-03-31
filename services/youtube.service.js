
const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const { YouTubeAccountModel } = require('../models/youtube-account.model');
const { CommentModel } = require('../models/comment.model');
const { createProxyAgent } = require('./proxy.service');

const ApiProfile = require('../models/ApiProfile');

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
  // Helper function to try with a specific profile
  const tryWithProfile = async (profile) => {
    const oauth2Client = new OAuth2Client(
      profile.clientId,
      profile.clientSecret,
      profile.redirectUri
    );

    oauth2Client.setCredentials({ 
      refresh_token: account.google.refreshToken 
    });

    const { token } = await oauth2Client.getAccessToken();
    if (!token) {
      throw new Error('Failed to obtain access token');
    }

    // Update account with new token and profile info
    account.google = {
      ...account.google,
      accessToken: token,
      clientId: profile.clientId,
      clientSecret: profile.clientSecret,
      redirectUri: profile.redirectUri
    };
    await account.save();

    return oauth2Client;
  };

  try {
    if (!account.google?.refreshToken) {
      throw new Error('No refresh token available. User needs to re-authenticate.');
    }

    // First try with active profile
    try {
      const activeProfile = await ApiProfile.findOne({ isActive: true });
      if (!activeProfile) {
        throw new Error('No active profile found');
      }
      return await tryWithProfile(activeProfile);
    } catch (activeProfileError) {
      console.warn('Active profile failed, trying others...', activeProfileError.message);
      
      // If active profile fails, try all profiles in order
      const allProfiles = await ApiProfile.find().sort({ createdAt: -1 });
      if (allProfiles.length === 0) {
        throw new Error('No API profiles available');
      }

      for (const profile of allProfiles) {
        try {
          return await tryWithProfile(profile);
        } catch (profileError) {
          console.warn(`Failed with profile ${profile._id}:`, profileError.message);
          continue;
        }
      }

      throw new Error('All profile attempts failed');
    }
  } catch (error) {
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

/**
 * Post a comment to YouTube
 * @param {String} commentId MongoDB ID of the comment
 */
async function postComment(commentId) {
  try {
    const allProfiles = await ApiProfile.find().sort({ isActive: -1, createdAt: -1 });
    if (allProfiles.length === 0) {
      console.warn('No API profiles available');
      return;
    }

    // 2. Track if we need to switch profiles
 

    // Get comment from database
    const comment = await CommentModel.findById(commentId)
      .populate({
        path: "youtubeAccount",
        populate: { path: "proxy" },
      });

    if (!comment) {
      throw new Error("Comment not found");
    }


    const account = comment.youtubeAccount;
 

    // Check account status
    if (account.status !== "active") {
      console.warn(`YouTube account is not active: ${account.status}`);
      throw new Error(`YouTube account is ${account.status}`);
    }

    // Refresh token if needed

    const oauth2Client = await refreshTokenIfNeeded(account);
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
   


    if (!comment.content || comment.content.trim() === '') {
      throw new Error("Comment content is empty");
    }
    let sanitizedContent = comment.content.trim();
    sanitizedContent = addRandomEmojis(sanitizedContent);
    if (!sanitizedContent) {
      throw new Error("Comment content is empty after trimming");
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

    
    // Add parent ID for replies if available
    if (comment.parentId) {
      commentData.snippet.parentId = comment.parentId;
      console.log("Posting a reply to parentId:", comment.parentId);
    } else {
      console.log("Posting a top-level comment to videoId:", comment.videoId);
    }
    

    const response = await youtube.commentThreads.insert({
      part: "snippet",
      requestBody: commentData,
      Comments:  sanitizedContent
    });


    // Update comment with ID from YouTube
    const commentThread = response.data;
    const youtubeCommentId = commentThread.id;



    await updateDailyUsage(account._id, "commentCount");

    let activeProfile = allProfiles.find(p => p.isActive) || allProfiles[0];

    const updatedProfile = await ApiProfile.findByIdAndUpdate(
      activeProfile._id,
      {
        $inc: { usedQuota: 50 }, // Increment usedQuota by 50

      },
      { new: true, upsert: true } // Create the document if it doesn't exist
    );
    

    return {
      success: true,
      commentId: youtubeCommentId,
      message: "Comment posted successfully",
    };
  } catch (error) {
    console.error("Error posting comment:", error);

    // Check for quota exceeded error
    if (
      error.message.includes("quotaExceeded") ||
      error.message.includes("dailyLimitExceeded")
    ) {
      console.warn("Quota exceeded or daily limit reached. Updating account status...");
      try {
        const account = comment.youtubeAccount;
        account.status = "limited";
        await account.save();
        console.log("Account status updated to 'limited'.");
      } catch (updateError) {
        console.error("Error updating account status:", updateError);
      }
    }

    return {
      success: false,
      error: error.message || "Failed to post comment",
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
  getYouTubeClient,
  getRandomUserAgent
};
