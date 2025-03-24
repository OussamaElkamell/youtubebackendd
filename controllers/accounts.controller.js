const { YouTubeAccountModel } = require('../models/youtube-account.model');
const { ProxyModel } = require('../models/proxy.model');
const { refreshTokenIfNeeded, getYouTubeClient } = require('../services/youtube.service');
const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const { UserModel } = require('../models/user.model');

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
      let proxyObj = await ProxyModel.findOne({
        proxy: proxy,
        user: req.user.id
      });
      
      // If proxy doesn't exist, create a new one
      if (!proxyObj) {
        const [host, port] = proxy.split(':'); // Assuming the proxy format is 'host:port'

        // Ensure valid host and port
        if (!host || !port) {
          return res.status(400).json({ message: 'Invalid proxy format. Expected host:port.' });
        }

        // Create a new Proxy object
        proxyObj = new ProxyModel({
          proxy: proxy,
          host: host,        // Set extracted host
          port: parseInt(port, 10),  // Set extracted port (convert to number)
          user: req.user.id
        });
        await proxyObj.save(); // Save the new proxy to the database
      }
      
      // Assign the proxy ID to the account
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


const PROJECT_ID = process.env.GCP_PROJECT_ID; // Your Google Cloud Project ID
const API_KEY = process.env.YOUTUBE_API_KEY; // YouTube API Key
const axios = require('axios');

let usedQuota = 0; // Track the number of requests made (manually)

const getQuota = async (req, res) => {
  try {
    // Sample API request (this costs 1 unit)
    const response = await axios.get("https://www.googleapis.com/youtube/v3/videos", {
      params: {
        part: "snippet",
        chart: "mostPopular",
        regionCode: "US",
        maxResults: 5,
        key: API_KEY
      }
    });

    // Log the response data for debugging
    console.log('API Response:', response.data);

    // Increment the usedQuota as 1 request is made
    usedQuota += 1;

    // Calculate the remaining quota
    const totalQuota = 10_000; // YouTube API default daily quota limit
    const remainingQuota = totalQuota - usedQuota;

    res.json({
      quota: {
        totalQuota: totalQuota,
        usedQuota: usedQuota,
        remainingQuota: remainingQuota
      }
    });

  } catch (error) {
    // Log the detailed error response for troubleshooting
    console.error("Error fetching quota:", error.response?.data || error.message);
    res.status(500).json({ message: "Failed to retrieve quota", error: error.response?.data || error.message });
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

    // Verify the ID token with Google
    const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
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
      // Update the existing account with new info
      existingAccount.status = 'active';
      existingAccount.google.id = googleId;
      existingAccount.google.accessToken = access_token;
      existingAccount.google.refreshToken = refresh_token;
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

    // Create new account with the provided tokens
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
        tokenExpiry: new Date(Date.now() + 3600 * 1000), // Set initial expiry (1 hour)
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
  addAccount,
  getQuota
};
