const mongoose = require('mongoose');

const ApiProfileSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  clientId: {
    type: String,
    required: true,
    trim: true
  },
  clientSecret: {
    type: String,
    required: true,
    trim: true
  },
  apiKey: {
    type: String,
    required: true,
    trim: true
  },
  redirectUri: {
    type: String,
    required: true,
    trim: true
  },
  isActive: {
    type: Boolean,
    default: false
  },
  usedQuota: {
    type: Number,
    default: 0 // Tracks the API quota usage
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Update the `updatedAt` field before saving
ApiProfileSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

const ApiProfile = mongoose.model('ApiProfile', ApiProfileSchema);
module.exports = ApiProfile;
