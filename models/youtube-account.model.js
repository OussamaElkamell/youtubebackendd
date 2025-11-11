const mongoose = require('mongoose');

const YouTubeAccountSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true
  },
  status: {
    type: String,
    enum: ['active', 'inactive', 'limited', 'banned'],
    default: 'active'
  },
  channelId: String,
  channelTitle: String,
  thumbnailUrl: String,
  proxy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Proxy',
    default:null
  },
  lastUsed: Date,
  dailyUsage: {
    date: {
      type: Date,
      default: () => new Date().setHours(0, 0, 0, 0) // Start of current day
    },
    commentCount: {
      type: Number,
      default: 0,
      min: 0
    },
    likeCount: {
      type: Number,
      default: 0,
      min: 0
    }
  },
  google: {
    id: String,
    accessToken: String,
    refreshToken: {
      type: String,
      required: true
    },
    tokenExpiry: Date,
    // Added profile association fields
    clientId: {
      type: String,
      required: true
    },
    clientSecret: {
      type: String,
      required: true
    },
    redirectUri: {
      type: String,
      required: true
    },
    profileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ApiProfile',
      required: true
    }
  },
  lastMessage: String,
  createdAt: {
    type: Date,
    default: Date.now
  },
  connectedDate: {
    type: Date,
    default: Date.now
  },
  isPosting: {
  type: Boolean,
  default: false
},
  proxyErrorCount: {
    type: Number,
    default: 0,
    min: 0
  },
  duplicationCount:{
    type: Number,
    default: 0,
    min: 0
  },
  proxyErrorThreshold: {
    type: Number,
    default: 3
  },
 

}, {
  timestamps: true, // Adds createdAt and updatedAt automatically
});

// Method to check if token needs refresh
YouTubeAccountSchema.methods.needsTokenRefresh = function() {
  if (!this.google.tokenExpiry) return true;
  return new Date() >= new Date(this.google.tokenExpiry);
};

// Method to refresh access token
YouTubeAccountSchema.methods.refreshToken = async function() {
  const { OAuth2Client } = require('google-auth-library');
  
  try {
    const oauth2Client = new OAuth2Client(
      this.google.clientId,
      this.google.clientSecret,
      this.google.redirectUri
    );

    oauth2Client.setCredentials({
      refresh_token: this.google.refreshToken
    });

    const { token, res } = await oauth2Client.getAccessToken();
    if (!token) {
      throw new Error('Failed to obtain access token');
    }

    this.google.accessToken = token;
    this.google.tokenExpiry = new Date(Date.now() + (res.data.expires_in * 1000));
    await this.save();

    return oauth2Client;
  } catch (error) {
    console.error(`Token refresh failed for account ${this._id}:`, error);
    throw error;
  }
};

// Static method to find active accounts
YouTubeAccountSchema.statics.findActiveAccounts = function(userId) {
  return this.find({
    user: userId,
    status: 'active'
  });
};

// Daily usage reset middleware
YouTubeAccountSchema.pre('save', function(next) {
  const now = new Date();
  const currentDay = new Date(now.setHours(0, 0, 0, 0)).getTime();
  const lastUsageDay = this.dailyUsage.date.getTime();

  if (currentDay > lastUsageDay) {
    this.dailyUsage = {
      date: now,
      commentCount: 0,
      likeCount: 0
    };
  }

  // 👇 Only override if the status is not being updated manually
  if (
    this.proxyErrorCount >= this.proxyErrorThreshold &&
    this.isModified('proxyErrorCount') &&
    !this.isModified('status') // allow manual override
  ) {
    this.status = 'inactive';
  }

  next();
});


const YouTubeAccountModel = mongoose.model('YouTubeAccount', YouTubeAccountSchema);

module.exports = { YouTubeAccountModel };
