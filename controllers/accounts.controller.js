const { YouTubeAccountModel } = require('../models/youtube-account.model');
const { ProxyModel } = require('../models/proxy.model');
const { refreshTokenIfNeeded, getYouTubeClient } = require('../services/youtube.service');
const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');

/**
 * Get all YouTube accounts for the authenticated user
 */
const getAllAccounts = async (req, res, next) => {
  try {
    const accounts = await YouTubeAccountModel.find({ user: req.user.id })
      .populate('proxy', 'host port protocol status');
    
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
    
    const account = await YouTubeAccountModel.findOne({
      _id: req.params.id,
      user: req.user.id
    });
    
    if (!account) {
      return res.status(404).json({ message: 'Account not found' });
    }
    
    // Update status if provided
    if (status) {
      account.status = status;
    }
    
    // Update proxy if provided
    if (proxy) {
      const proxyObj = await ProxyModel.findOne({
        _id: proxy,
        user: req.user.id
      });
      
      if (!proxyObj) {
        return res.status(404).json({ message: 'Proxy not found' });
      }
      
      account.proxy = proxyObj._id;
    }
    
    await account.save();
    
    res.json({ 
      message: 'Account updated successfully',
      account 
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
    const { credential, proxy } = req.body;
    
    if (!credential) {
      return res.status(400).json({ message: 'Missing required credential' });
    }
    
    // Verify the token with Google
    const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
    
    // Verify the token and get user info
    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID
    });
    
    const payload = ticket.getPayload();
    if (!payload) {
      return res.status(400).json({ message: 'Invalid credential' });
    }
    
    const { email, sub: googleId, name, picture } = payload;
    
    // Check if account already exists for this user
    const existingAccount = await YouTubeAccountModel.findOne({
      user: req.user.id,
      email
    });
    
    if (existingAccount) {
      // Update the existing account with new info
      existingAccount.status = 'active';
      existingAccount.google.id = googleId;
      await existingAccount.save();
      
      return res.json({
        message: 'Account updated successfully',
        account: existingAccount
      });
    }
    
    // Handle proxy association if provided
    let proxyId = null;
    if (proxy) {
      const proxyObj = await ProxyModel.findOne({
        _id: proxy,
        user: req.user.id
      });
      
      if (proxyObj) {
        proxyId = proxyObj._id;
      }
    }
    
    // Create new account with what we know from ID token
    const newAccount = await YouTubeAccountModel.create({
      user: req.user.id,
      email,
      status: 'active',
      channelTitle: name || email,
      thumbnailUrl: picture || '',
      proxy: proxyId,
      google: {
        id: googleId,
        tokenExpiry: new Date(Date.now() + 3600 * 1000) // 1 hour
      },
      connectedDate: new Date()
    });
    
    // Add to user's YouTube accounts
    await UserModel.updateOne(
      { _id: req.user.id },
      { $push: { youtubeAccounts: newAccount._id } }
    );
    
    
    res.status(201).json({
      message: 'Account added successfully',
      account: newAccount
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
  verifyAccount,
  addAccount
};
