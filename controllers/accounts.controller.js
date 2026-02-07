const prisma = require('../services/prisma.service');
const { refreshTokenIfNeeded, getYouTubeClient } = require('../services/youtube.service');
const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
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
 * Get all YouTube accounts for the authenticated user
 */
const getAllAccounts = async (req, res, next) => {
  try {
    const accounts = await prisma.youTubeAccount.findMany({
      where: {
        userId: req.user.id
      },
      include: {
        proxy: true
      }
    });

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
    const account = await prisma.youTubeAccount.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id
      },
      include: {
        proxy: true
      }
    });

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
    console.log('Update Account ID:', req.params.id);
    console.log('Incoming status:', status);
    console.log('Incoming proxy:', proxy);
    console.log('Request body:', req.body);

    const account = await prisma.youTubeAccount.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id
      }
    });

    if (!account) {
      return res.status(404).json({ message: 'Account not found' });
    }

    const updateData = {};

    // Update status if provided
    if (typeof status !== 'undefined') {
      updateData.status = status;
    }

    // Update proxy if provided
    if (proxy !== undefined) {
      console.log('Processing proxy update...');
      if (proxy === null || proxy === '') {
        console.log('Removing proxy assignment');
        updateData.proxyId = null;
      } else {
        console.log('Searching for existing proxy:', proxy);
        let proxyObj = await prisma.proxy.findFirst({
          where: {
            proxy: proxy,
            userId: req.user.id
          }
        });

        // If proxy doesn't exist, create a new one
        if (!proxyObj) {
          console.log('Proxy not found, creating new one...');
          const proxyParts = proxy.split(':');

          if (proxyParts.length < 2) {
            console.warn('Invalid proxy format received:', proxy);
            return res.status(400).json({
              message: 'Invalid proxy format. Expected host:port or host:port:username:password.'
            });
          }

          const [host, port] = proxyParts;
          const username = proxyParts.length >= 3 ? proxyParts[2] : null;
          const password = proxyParts.length >= 4 ? proxyParts[3] : null;

          if (!host || !port || isNaN(parseInt(port, 10))) {
            console.warn('Invalid host or port:', host, port);
            return res.status(400).json({
              message: 'Invalid proxy format. Host and port (must be a number) are required.'
            });
          }

          proxyObj = await prisma.proxy.create({
            data: {
              proxy: proxy,
              host: host.trim(),
              port: parseInt(port, 10),
              username: username ? username.trim() : null,
              password: password ? password.trim() : null,
              userId: req.user.id,
              status: 'active'
            }
          });
          console.log('Created new proxy with ID:', proxyObj.id);
        } else {
          console.log('Found existing proxy with ID:', proxyObj.id);
        }

        updateData.proxyId = proxyObj.id;
        console.log('Assigned proxyId to updateData:', updateData.proxyId);
      }
    }

    const updatedAccount = await prisma.youTubeAccount.update({
      where: { id: account.id },
      data: updateData,
      include: { proxy: true }
    });

    res.json({
      message: 'Account updated successfully',
      account: updatedAccount
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
    const account = await prisma.youTubeAccount.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id
      }
    });

    if (!account) {
      return res.status(404).json({ message: 'Account not found' });
    }

    await prisma.youTubeAccount.delete({
      where: { id: req.params.id }
    });

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
    const account = await prisma.youTubeAccount.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id
      }
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

    // Refresh tokens are updated inside refreshTokenIfNeeded using prisma
    const updatedAccount = await prisma.youTubeAccount.findUnique({
      where: { id: req.params.id }
    });

    res.json({
      message: 'Token refreshed successfully',
      expiresAt: updatedAccount.googleTokenExpiry
    });
  } catch (error) {
    next(error);
  }
};

const getQuota = async (req, res) => {
  try {
    const profiles = await prisma.apiProfile.findMany({});
    if (!profiles || profiles.length === 0) {
      return res.status(404).json({ message: 'No profiles found' });
    }

    const usedQuota = profiles.reduce((sum, profile) => sum + (profile.usedQuota || 0), 0);
    const totalQuota = profiles.reduce(
      (sum, profile) => sum + (profile.limitQuota || 10000),
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
    console.error("Error fetching quota:", error.message);
    return res.status(500).json({
      message: "Failed to retrieve quota",
      error: error.message
    });
  }
};

const verifyAccount = async (req, res, next) => {
  try {
    const account = await prisma.youTubeAccount.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id
      },
      include: { proxy: true }
    });

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

    // Get updated account after refresh
    const updatedAccount = await prisma.youTubeAccount.findUnique({
      where: { id: account.id },
      include: { proxy: true }
    });

    // Get YouTube client (with proxy if available)
    const youtube = await getYouTubeClient(updatedAccount);

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
    const finalAccount = await prisma.youTubeAccount.update({
      where: { id: account.id },
      data: {
        channelId: channel.id,
        channelTitle: channel.snippet.title,
        thumbnailUrl: channel.snippet.thumbnails.default.url,
        status: 'active'
      }
    });

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
        await prisma.youTubeAccount.update({
          where: { id: req.params.id },
          data: { status: 'inactive' }
        });
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

    if (!credential || !access_token || !refresh_token) {
      return res.status(400).json({ message: 'Missing required credentials' });
    }

    // Get active profile first
    const activeProfile = await prisma.apiProfile.findFirst({
      where: { isActive: true }
    });
    if (!activeProfile) {
      return res.status(400).json({ message: 'No active API profile configured' });
    }

    // Verify the ID token with Google using active profile's credentials
    const client = new OAuth2Client(
      activeProfile.clientId,
      activeProfile.clientSecret,
      activeProfile.redirectUri
    );

    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: activeProfile.clientId,
    });

    const payload = ticket.getPayload();
    if (!payload) {
      return res.status(400).json({ message: 'Invalid credential' });
    }

    const { email, sub: googleId, name, picture } = payload;

    // Check if account already exists for this user
    const existingAccount = await prisma.youTubeAccount.findFirst({
      where: {
        userId: req.user.id,
        email,
      }
    });

    if (existingAccount) {
      // Update the existing account
      const updatedAccount = await prisma.youTubeAccount.update({
        where: { id: existingAccount.id },
        data: {
          status: 'active',
          accessToken: access_token,
          refreshToken: refresh_token,
          tokenExpiry: new Date(Date.now() + 3600 * 1000),
          clientId: activeProfile.clientId,
          clientSecret: activeProfile.clientSecret,
          redirectUri: activeProfile.redirectUri,
          apiProfileId: activeProfile.id
        }
      });

      return res.json({
        message: 'Account updated successfully',
        account: updatedAccount,
      });
    }

    // Handle proxy association if provided
    let proxyId = null;
    if (proxy) {
      const proxyObj = await prisma.proxy.findFirst({
        where: {
          host: proxy.split(':')[0],
          port: parseInt(proxy.split(':')[1]),
          userId: req.user.id
        }
      });

      if (proxyObj) {
        proxyId = proxyObj.id;
      }
    }

    // Create new account
    const newAccount = await prisma.youTubeAccount.create({
      data: {
        userId: req.user.id,
        email,
        status: 'active',
        channelTitle: name || email,
        thumbnailUrl: picture || '',
        proxyId: proxyId,

        // OAuth tokens
        accessToken: access_token,
        refreshToken: refresh_token,
        tokenExpiry: new Date(Date.now() + 3600 * 1000),

        // OAuth credentials from active profile
        clientId: activeProfile.clientId,
        clientSecret: activeProfile.clientSecret,
        redirectUri: activeProfile.redirectUri,

        // Profile association
        apiProfileId: activeProfile.id,
        connectedDate: new Date()
      }
    });

    res.status(201).json({
      message: 'Account added successfully',
      account: newAccount,
      profileId: activeProfile.id
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
