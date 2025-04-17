const mongoose = require('mongoose');
const { Queue, Worker, QueueScheduler } = require('bullmq');
const Redis = require('ioredis');

// Set up the Redis connection using the provided connection object
const redisClient = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  username: 'default',
  password: process.env.REDIS_PASSWORD,
  tls: {}  // Add any necessary TLS options here
});

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

// Create a BullMQ Queue for resetting quotas
const resetQuotaQueue = new Queue('resetQuotaQueue', {
  connection: {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    username: 'default',
    password: process.env.REDIS_PASSWORD,
    tls: {}  // Add any necessary TLS options here
  }
});

// Define the worker that will process the reset quota job
const worker = new Worker('resetQuotaQueue', async job => {
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
}, {
  connection: {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    username: 'default',
    password: process.env.REDIS_PASSWORD,
    tls: {}  // Add any necessary TLS options here
  }
});


// Add a job to the queue to reset quotas every 24 hours (86400 seconds)
async function addResetQuotaJob() {
  await resetQuotaQueue.add('resetQuota', {}, {
    repeat: { every: 24 * 60 * 60 * 1000 }, // Repeat every 24 hours
    jobId: 'resetQuotaJob'  // Unique job identifier
  });
}

// Start the job to reset quotas
addResetQuotaJob().catch(console.error);

const ApiProfile = mongoose.model('ApiProfile', ApiProfileSchema);
module.exports = ApiProfile;
