
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
    cronExpression: String, 
    errorMessage: String,
   
    interval: {
      type: {
        value: { type: Number, required: false },
        min:{ type: Number, required: false },
        max:{ type: Number, required: false },
        unit: { type: String, required: false }
      },
      required: false
    }
  },
  useAI: {
  type: Boolean,

}
,
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
    },
       limitComments: {
    value: { type: Number, default: 0 },
    min:  { type: Number, default: 0 },
    max:  { type: Number, default: 0 }
    },
          delayofsleep: {
      type: Number,
      default: 0
    },
    delayStartTime: {
      type: Date,
      default:null

    },
    
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
  },
  includeEmojis:{
    type:Boolean,

  },
  lastUsedAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'YoutubeAccount' },
  
  // Account rotation fields
  accountCategories: {
    principal: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'YouTubeAccount'
    }],
    secondary: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'YouTubeAccount'
    }]
  },
  accountRotation: {
    enabled: {
      type: Boolean,
      default: false
    },
    currentlyActive: {
      type: String,
      enum: ['principal', 'secondary'],
      default: 'principal'
    },
    lastRotatedAt: Date,
    rotatedPrincipalIds: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'YouTubeAccount'
    }],
    rotatedSecondaryIds: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'YouTubeAccount'
    }]
  }
});

const ScheduleModel = mongoose.model('Schedule', ScheduleSchema);

module.exports = { ScheduleModel };
