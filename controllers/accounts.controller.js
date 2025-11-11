const { YouTubeAccountModel } = require('../models/youtube-account.model');
const { ProxyModel } = require('../models/proxy.model');
const { refreshTokenIfNeeded, getYouTubeClient } = require('../services/youtube.service');
const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const { UserModel } = require('../models/user.model');
const ApiProfile = require('../models/ApiProfile');
const axios = require('axios');

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
 * Get all YouTube accounts for the authenticated user
 */
const getAllAccounts = async (req, res, next) => {
  try {
    const accounts = await YouTubeAccountModel.find({ 
      user: req.user.id 
    })
    .populate('proxy', 'host port protocol status')
    .populate('google.profileId', 'name clientId');

    res.json({ accounts });
  } catch (error) {
    next(error);
  }
};


/**
 * Get a specific YouTube account by ID
 */
const getAccountById = async (req, res, next) => {
  try {
    const account = await YouTubeAccountModel.findOne({
      _id: req.params.id,
      user: req.user.id
    }).populate('proxy');
    
    if (!account) {
      return res.status(404).json({ message: 'Account not found' });
    }
    
    res.json({ account });
  } catch (error) {
    next(error);
  }
};

/**
 * Update a YouTube account
 */
const updateAccount = async (req, res, next) => {
  try {
    const { status, proxy } = req.body;
    console.log('Incoming status:', status);

    const account = await YouTubeAccountModel.findOne({
      _id: req.params.id,
      user: req.user.id
    });

    if (!account) {
      return res.status(404).json({ message: 'Account not found' });
    }

    // Update status if provided (even if it's a falsy value like "", false, or "0")
    if (typeof status !== 'undefined') {
      account.set('status', status);
      account.markModified('status'); // ensure Mongoose picks it up
      console.log('Updated status to:', account.status);
    }

    // Update proxy if provided
    if (proxy) {
      let proxyObj = await ProxyModel.findOne({
        proxy: proxy,
        user: req.user.id
      });

      // If proxy doesn't exist, create a new one
      if (!proxyObj) {
        const proxyParts = proxy.split(':');

        if (proxyParts.length < 2) {
          return res.status(400).json({ 
            message: 'Invalid proxy format. Expected host:port or host:port:username:password.' 
          });
        }

        const [host, port] = proxyParts;
        const username = proxyParts.length >= 3 ? proxyParts[2] : null;
        const password = proxyParts.length >= 4 ? proxyParts[3] : null;

        if (!host || !port || isNaN(parseInt(port, 10))) {
          return res.status(400).json({ 
            message: 'Invalid proxy format. Host and port (must be a number) are required.' 
          });
        }

        proxyObj = new ProxyModel({
          proxy: proxy,
          host: host.trim(),
          port: parseInt(port, 10),
          username: username ? username.trim() : null,
          password: password ? password.trim() : null,
          user: req.user.id
        });

        await proxyObj.save();
        console.log('Created new proxy:', proxyObj);
      }

      account.proxy = proxyObj._id;
    }

    console.log('Saving account with status:', account.status);
    await account.save();

    const refetched = await YouTubeAccountModel.findById(account._id);
    console.log('Refetched status from DB:', refetched.status);

    res.json({ 
      message: 'Account updated successfully',
      account: refetched
    });
  } catch (error) {
    next(error);
  }
};


/**
 * Delete a YouTube account
 */
const deleteAccount = async (req, res, next) => {
  try {
    const result = await YouTubeAccountModel.deleteOne({
      _id: req.params.id,
      user: req.user.id
    });
    
    if (result.deletedCount === 0) {
      return res.status(404).json({ message: 'Account not found' });
    }
    
    res.json({ message: 'Account deleted successfully' });
  } catch (error) {
    next(error);
  }
};

/**
 * Force refresh OAuth token for an account
 */
const refreshToken = async (req, res, next) => {
  try {
    const account = await YouTubeAccountModel.findOne({
      _id: req.params.id,
      user: req.user.id
    });
    
    if (!account) {
      return res.status(404).json({ message: 'Account not found' });
    }
    
    const refreshed = await refreshTokenIfNeeded(account, true);
    
    if (!refreshed.success) {
      return res.status(400).json({ 
        message: 'Failed to refresh token', 
        error: refreshed.error 
      });
    }
    
    res.json({ 
      message: 'Token refreshed successfully',
      expiresAt: account.google.tokenExpiry
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Verify account is working by making a test API call
 */





const getQuota = async (req, res) => {
  try {
    const profiles = await ApiProfile.find({});
    if (!profiles || profiles.length === 0) {
      return res.status(404).json({ message: 'No profiles found' });
    }

    const usedQuota = profiles.reduce((sum, profile) => sum + (profile.usedQuota || 0), 0);
    
    // Sum each profile's individual quota limit (fallback to 10_000 if missing)
    const totalQuota = profiles.reduce(
      (sum, profile) => sum + (profile.limitQuota || 10_000),
      0
    );

    const remainingQuota = totalQuota - usedQuota;

    return res.json({
      quota: {
        totalQuota,
        usedQuota,
        remainingQuota,
        profilesCount: profiles.length,
      },
    });

  } catch (error) {
    console.error("Error fetching quota:", error.response?.data || error.message);
    return res.status(500).json({ 
      message: "Failed to retrieve quota", 
      error: error.response?.data || error.message 
    });
  }
};








const verifyAccount = async (req, res, next) => {
  try {
    const account = await YouTubeAccountModel.findOne({
      _id: req.params.id,
      user: req.user.id
    }).populate('proxy');
    
    if (!account) {
      return res.status(404).json({ message: 'Account not found' });
    }
    
    // Refresh token if needed
    const refreshed = await refreshTokenIfNeeded(account);
    if (!refreshed.success) {
      return res.status(400).json({ 
        message: 'Failed to refresh token', 
        error: refreshed.error 
      });
    }
    
    // Get YouTube client (with proxy if available)
    const youtube = await getYouTubeClient(account);
    
    // Test the API connection by getting channel info
    const response = await youtube.channels.list({
      part: 'snippet,contentDetails,statistics',
      mine: true
    });
    
    if (!response.data.items || response.data.items.length === 0) {
      return res.status(400).json({ message: 'No channel found for this account' });
    }
    
    // Update account with real channel details
    const channel = response.data.items[0];
    account.channelId = channel.id;
    account.channelTitle = channel.snippet.title;
    account.thumbnailUrl = channel.snippet.thumbnails.default.url;
    account.status = 'active';
    await account.save();
    
    res.json({ 
      message: 'Account verified successfully',
      channel: {
        id: channel.id,
        title: channel.snippet.title,
        subscribers: channel.statistics.subscriberCount,
        views: channel.statistics.viewCount,
        videos: channel.statistics.videoCount
      }
    });
  } catch (error) {
    console.error('Error verifying account:', error);
    
    // Update account status if authentication error
    if (error.code === 401 || error.code === 403) {
      try {
        const account = await YouTubeAccountModel.findById(req.params.id);
        if (account) {
          account.status = 'inactive';
          await account.save();
        }
      } catch (updateError) {
        console.error('Error updating account status:', updateError);
      }
    }
    
    next(error);
  }
};

/**
 * Add a new YouTube account via OAuth
 */
const addAccount = async (req, res, next) => {
  try {
    const { credential, proxy, access_token, refresh_token } = req.body;
    console.log("req.body", req.body);

    if (!credential || !access_token || !refresh_token) {
      return res.status(400).json({ message: 'Missing required credentials' });
    }

    // Get active profile first
    const activeProfile = await ApiProfile.findOne({ isActive: true });
    if (!activeProfile) {
      return res.status(400).json({ message: 'No active API profile configured' });
    }
    console.log("Active Profile Id",activeProfile._id);
    
    // Verify the ID token with Google using active profile's credentials
    const client = new OAuth2Client(
      activeProfile.clientId,
      activeProfile.clientSecret,
      activeProfile.redirectUri
    );

    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: activeProfile.clientId, // Use profile's client ID as audience
    });

    const payload = ticket.getPayload();
    if (!payload) {
      return res.status(400).json({ message: 'Invalid credential' });
    }

    const { email, sub: googleId, name, picture } = payload;

    // Check if account already exists for this user
    const existingAccount = await YouTubeAccountModel.findOne({
      user: req.user.id,
      email,
    });

    if (existingAccount) {
      // Update the existing account with new info and active profile credentials
      existingAccount.status = 'active';
      existingAccount.google = {
        id: googleId,
        accessToken: access_token,
        refreshToken: refresh_token,
        tokenExpiry: new Date(Date.now() + 3600 * 1000), // 1 hour expiry
        clientId: activeProfile.clientId,
        clientSecret: activeProfile.clientSecret,
        redirectUri: activeProfile.redirectUri
      };
      await existingAccount.save();

      return res.json({
        message: 'Account updated successfully',
        account: existingAccount,
      });
    }

    // Handle proxy association if provided
    let proxyId = null;
    if (proxy) {
      const proxyObj = await ProxyModel.findOne({
        proxy: proxy,
        user: req.user.id
      });
      
      if (proxyObj) {
        proxyId = proxyObj._id;
      }
    }

    // Create new account with the provided tokens and active profile credentials
    const newAccount = await YouTubeAccountModel.create({
      user: req.user.id,
      email,
      status: 'active',
      channelTitle: name || email,
      thumbnailUrl: picture || '',
      proxy: proxyId,
      google: {
        id: googleId,
        accessToken: access_token,
        refreshToken: refresh_token,
        tokenExpiry: new Date(Date.now() + 3600 * 1000), // 1 hour expiry
        clientId: activeProfile.clientId,
        clientSecret: activeProfile.clientSecret,
        redirectUri: activeProfile.redirectUri,
        profileId: activeProfile._id,  // Ensure this is being passed correctly
      },
      connectedDate: new Date(),
    });
    

    // Add to user's YouTube accounts
    await UserModel.updateOne(
      { _id: req.user.id },
      { $push: { youtubeAccounts: newAccount._id } }
    );

    res.status(201).json({
      message: 'Account added successfully',
      account: newAccount,
      profileId: activeProfile._id // Return the profile ID used
    });
  } catch (error) {
    console.error('Error adding account:', error);
    next(error);
  }
};

module.exports = {
  getAllAccounts,
  getAccountById,
  updateAccount,
  deleteAccount,
  refreshToken,
  getActiveProfile,
  verifyAccount,
  addAccount,
  getQuota
};
