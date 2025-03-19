
const mongoose = require('mongoose');

const ScheduleSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  name: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['active', 'paused', 'completed', 'error'],
    default: 'active'
  },
  commentTemplates: [{
    type: String,
    required: true
  }],
  targetVideos: [{
    videoId: String,
    channelId: String,
    title: String,
    thumbnailUrl: String
  }],
  targetChannels: [{
    channelId: String,
    name: String,
    thumbnailUrl: String,
    latestOnly: {
      type: Boolean,
      default: false
    }
  }],
  accountSelection: {
    type: String,
    enum: ['specific', 'random', 'round-robin'],
    default: 'specific'
  },
  selectedAccounts: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'YouTubeAccount'
  }],
  schedule: {
    type: {
      type: String,
      enum: ['immediate', 'once', 'recurring', 'interval'],
      default: 'immediate'
    },
    startDate: Date,
    endDate: Date,
    cronExpression: String, // For recurring schedules
    interval: {
      value: Number,
      unit: {
        type: String,
        enum: ['minutes', 'hours', 'days'],
        default: 'minutes'
      }
    }
  },
  delays: {
    minDelay: {
      type: Number,
      default: 0
    },
    maxDelay: {
      type: Number,
      default: 0
    },
    betweenAccounts: {
      type: Number,
      default: 0
    }
  },
  progress: {
    totalComments: {
      type: Number,
      default: 0
    },
    postedComments: {
      type: Number,
      default: 0
    },
    failedComments: {
      type: Number,
      default: 0
    }
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

const ScheduleModel = mongoose.model('Schedule', ScheduleSchema);

module.exports = { ScheduleModel };
