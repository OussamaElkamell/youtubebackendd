const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const prisma = require('./prisma.service');
const { createProxyAgent } = require('./proxy.service');
const axios = require('axios');

async function getActiveProfile() {
  try {
    const profile = await prisma.apiProfile.findFirst({
      where: { isActive: true }
    });
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
 */
async function refreshTokenIfNeeded(account) {
  const tryWithGoogleCredentials = async (account) => {
    const oauth2Client = new OAuth2Client(
      account.clientId,
      account.clientSecret,
      account.redirectUri
    );

    oauth2Client.setCredentials({
      refresh_token: account.refreshToken
    });

    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      if (!credentials.access_token) {
        await prisma.youTubeAccount.update({
          where: { id: account.id },
          data: { status: 'inactive' }
        });
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
      await prisma.youTubeAccount.update({
        where: { id: account.id },
        data: {
          accessToken: credentials.access_token,
          tokenExpiry: tokenExpiry,
          status: 'active'
        }
      });

      return oauth2Client;
    } catch (error) {
      await prisma.youTubeAccount.update({
        where: { id: account.id },
        data: { status: 'inactive' }
      });
      console.error(`Token refresh failed for account ${account.id}:`, error);
      throw error;
    }
  };

  try {
    if (!account.refreshToken) {
      await prisma.youTubeAccount.update({
        where: { id: account.id },
        data: { status: 'inactive' }
      });
      throw new Error('No refresh token available. User needs to re-authenticate.');
    }

    return await tryWithGoogleCredentials(account);
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
 * Like a video using the YouTube Data API
 * @param {string} videoId - The YouTube video ID
 * @param {string} accountId - The YouTube account ID to use for liking
 * @param {Object} proxyOverride - Optional proxy to use for this request
 */
async function likeVideo(videoId, accountId, proxyOverride = null) {
  try {
    const account = await prisma.youTubeAccount.findUnique({
      where: { id: accountId }
    });

    if (!account || account.status !== 'active') {
      throw new Error(`Account ${accountId} is not active or not found`);
    }

    const youtube = await getYouTubeClient(account, proxyOverride);

    console.log(`[YouTubeService] Attempting to like video ${videoId} with account ${account.email}`);

    await youtube.videos.rate({
      id: videoId,
      rating: 'like'
    });

    // Verification check
    try {
      const ratingResponse = await youtube.videos.getRating({
        id: videoId
      });
      const rating = ratingResponse.data.items?.[0]?.rating;
      console.log(`[YouTubeService] Verified rating for ${videoId}: ${rating}`);
    } catch (verifyError) {
      console.warn(`[YouTubeService] Could not verify rating: ${verifyError.message}`);
    }

    await updateDailyUsage(accountId, 'likeCount');
    console.log(`[YouTubeService] Successfully liked video ${videoId} with account ${account.email}`);

    return { success: true };
  } catch (error) {
    console.error(`[YouTubeService] Failed to like video ${videoId}:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Post a comment to YouTube
 * @param {String} commentId ID of the comment
 */
async function postComment(commentId) {
  try {
    // Get the comment with included YouTube account and proxy
    const comment = await prisma.comment.findUnique({
      where: { id: commentId },
      include: {
        youtubeAccount: {
          include: { proxy: true }
        }
      }
    });

    if (!comment) throw new Error("Comment not found");

    const account = comment.youtubeAccount;
    if (!account || account.status === null) {
      console.warn("Account status is null, deleting comment...");
      await prisma.comment.delete({ where: { id: commentId } });
      return {
        success: false,
        message: "Comment deleted due to invalid account or status",
        error: null,
      };
    }

    if (account.status !== "active") {
      throw new Error(`YouTube account is ${account.status}`);
    }

    const schedule = await prisma.schedule.findUnique({
      where: { id: comment.scheduleId }
    });
    const includeEmojis = schedule?.includeEmojis === true;

    const proxy = account.proxy;
    if (!proxy) {
      throw new Error("No proxy assigned to account");
    }

    // Use proxy agent
    const agent = await createProxyAgent(proxy);

    if (!agent) {
      throw new Error(`Failed to create proxy agent for ${proxy.host}:${proxy.port}`);
    }

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
    await updateDailyUsage(account.id, "commentCount");
    await prisma.schedule.update({
      where: { id: comment.scheduleId },
      data: { lastUsedAccountId: account.id }
    });

    return {
      success: true,
      youtubeCommentId,
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
        const comment = await prisma.comment.findUnique({
          where: { id: commentId },
          include: { youtubeAccount: true }
        });
        if (comment?.youtubeAccount) {
          await prisma.youTubeAccount.update({
            where: { id: comment.youtubeAccount.id },
            data: { status: 'limited' }
          });
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
    const comment = await prisma.comment.findUnique({
      where: { id: commentId },
      include: {
        youtubeAccount: {
          include: { proxy: true }
        }
      }
    });

    if (!comment) throw new Error("Comment not found");

    const account = comment.youtubeAccount;
    const proxy = account?.proxy;

    if (!account || account.status === null) {
      console.warn("Invalid account, deleting comment...");
      await prisma.comment.delete({ where: { id: commentId } });
      return {
        success: false,
        message: "Comment deleted due to invalid account",
        error: null,
      };
    }

    if (account.status !== "active") {
      throw new Error(`YouTube account is ${account.status}`);
    }

    const schedule = await prisma.schedule.findUnique({
      where: { id: comment.scheduleId }
    });
    const includeEmojis = schedule?.includeEmojis === true;

    let content = comment.content?.trim();
    if (!content) throw new Error("Comment content is empty");

    if (includeEmojis) content = addRandomEmojis(content);
    content = randomizeSiParamInYoutubeUrl(content);

    if (!content) throw new Error("Comment content empty after processing");

    // Simulate posting the comment
    console.log("📢 Simulated Comment Post:");
    console.log(`👤 Account: ${account.channelTitle || account.id}`);
    console.log(`🎯 Video ID: ${comment.videoId}`);
    console.log(`💬 Content: ${content}`);
    if (comment.parentId) console.log(`↪️ Replying to: ${comment.parentId}`);
    if (proxy) console.log(`🌐 Proxy: ${proxy.host}:${proxy.port}`);

    // Simulate updating usage
    await prisma.schedule.update({
      where: { id: comment.scheduleId },
      data: { lastUsedAccountId: account.id }
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
    const account = await prisma.youTubeAccount.findUnique({
      where: { id: accountId }
    });

    if (!account) {
      return false;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const updateData = { lastUsed: new Date() };

    // Reset counter if it's a new day
    if (!account.dailyUsageDate || new Date(account.dailyUsageDate).setHours(0, 0, 0, 0) !== today.getTime()) {
      updateData.dailyUsageDate = today;
      updateData.commentCount = type === 'commentCount' ? 1 : 0;
      updateData.likeCount = type === 'likeCount' ? 1 : 0;
    } else {
      // Increment the specified counter
      if (type === 'commentCount') {
        updateData.commentCount = { increment: 1 };
      } else if (type === 'likeCount') {
        updateData.likeCount = { increment: 1 };
      }
    }

    await prisma.youTubeAccount.update({
      where: { id: accountId },
      data: updateData
    });

    return true;
  } catch (error) {
    console.error('Error updating daily usage:', error);
    return false;
  }
}

/**
 * Get a YouTube API client for a specific account
 * @param {Object} account YouTube account from database
 * @param {Object} proxyOverride Optional proxy to override account proxy
 */
async function getYouTubeClient(account, proxyOverride = null) {
  // Use refreshTokenIfNeeded to get a fresh client
  const oauth2Client = await refreshTokenIfNeeded(account);

  // Create YouTube client with auth
  const youtube = google.youtube({
    version: 'v3',
    auth: oauth2Client
  });

  // Set up proxy agent if needed
  const proxyToUse = proxyOverride || account.proxy;

  if (proxyToUse) {
    const proxyAgent = await createProxyAgent(proxyToUse);
    if (proxyAgent) {
      // Inject proxy agent into Google API context
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
  likeVideo,
  updateDailyUsage,
  postCommentToConsole,
  getYouTubeClient,
  getRandomUserAgent
};
