const mongoose = require('mongoose');


// ApiProfile Schema
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
  limitQuota:{
    type: Number,
    default: 10000
  },
  status: {
    type: String,
    enum: ["exceeded", "not exceeded"],
    default: "not exceeded"
  },
  exceededAt: {
    type: Date,
    default: null // Timestamp when quota was exceeded
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

// Update `updatedAt` field before saving
ApiProfileSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

// Update `updatedAt` field before updating
ApiProfileSchema.pre('findOneAndUpdate', function (next) {
  this.set({ updatedAt: Date.now() });
  next();
});


const ApiProfile = mongoose.model('ApiProfile', ApiProfileSchema);
module.exports = ApiProfile;
