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

// Function to automatically reset exceeded quotas every 24 hours
async function resetExceededQuotas() {
  const now = new Date();
  const profiles = await ApiProfile.find({ status: "exceeded" });

  for (let profile of profiles) {
    if (profile.exceededAt && (now - profile.exceededAt) >= 24 * 60 * 60 * 1000) {
      console.log(`Resetting quota for profile: ${profile.name}`);
      await ApiProfile.findByIdAndUpdate(profile._id, {
        usedQuota: 0,
        status: "not exceeded",
        exceededAt: null
      });
    }
  }
}

// Run quota reset check every 10 minutes
setInterval(resetExceededQuotas, 10 * 60 * 1000);

const ApiProfile = mongoose.model('ApiProfile', ApiProfileSchema);
module.exports = ApiProfile;
