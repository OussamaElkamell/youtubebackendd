
const mongoose = require('mongoose');

const YouTubeAccountSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  email: {
    type: String,
    required: true
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
    default: null
  },
  lastUsed: Date,
  dailyUsage: {
    date: Date,
    commentCount: {
      type: Number,
      default: 0
    },
    likeCount: {
      type: Number,
      default: 0
    }
  },
  google: {
    id: String,
    accessToken: String,
    refreshToken: String,
    tokenExpiry: Date
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  connectedDate: {
    type: Date,
    default: Date.now
  }
});

// Method to check if token needs refresh
YouTubeAccountSchema.methods.needsTokenRefresh = function() {
  if (!this.google.tokenExpiry) return true;
  return new Date() >= this.google.tokenExpiry;
};

const YouTubeAccountModel = mongoose.model('YouTubeAccount', YouTubeAccountSchema);

module.exports = { YouTubeAccountModel };
