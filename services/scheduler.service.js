const { Queue, Worker, QueueEvents } = require('bullmq');
const { createClient } = require('redis');
const cron = require('node-cron');
const mongoose = require('mongoose');
const { ScheduleModel } = require('../models/schedule.model');
const { CommentModel } = require('../models/comment.model');
const { YouTubeAccountModel } = require('../models/youtube-account.model');
const ApiProfile = require('../models/ApiProfile');
const { postComment } = require('./youtube.service');
const { assignRandomProxy } = require('./proxy.service');

// Redis connection with optimized configuration
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
let redisClient;

// BullMQ queues with optimized settings
const commentQueue = new Queue('comment-posting', { 
  connection: { 
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
    username: 'default',
    password:process.env.REDIS_PASSWORD,
    tls:{}
    
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 3000
    },
    removeOnComplete: true,
    removeOnFail: 1000
  }
});

const scheduleQueue = new Queue('schedule-processing', {
  connection: {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    maxRetriesPerRequest: null,
    username: 'default',
    password: process.env.REDIS_PASSWORD,
    tls:{}
  }
});

// Active jobs tracker
const activeJobs = new Map();

// Optimized delay calculation
function calculateOptimizedDelay(delays) {
  if (!delays || typeof delays.minDelay !== 'number' || typeof delays.maxDelay !== 'number') {
    return 1000; // Default 1 second delay
  }

  const max = Math.min(delays.maxDelay, 30);
  const min = Math.max(delays.minDelay, 1);
  
  // Logarithmic distribution for more short delays
  return Math.floor(
    Math.pow(10, Math.random() * Math.log10(max - min + 1)) + min - 1
  ) * 1000;
}

// Redis initialization with better error handling
async function initRedis() {
  try {
    redisClient = createClient({
      url : process.env.REDIS_URL,
      
      socket: {
        tls: true,
        reconnectStrategy: (retries) => Math.min(retries * 100, 5000)
      }
    });

    redisClient.on('error', (err) => console.error('Redis Client Error:', err));
    await redisClient.connect();
    console.log('Redis client connected successfully');
    return true;
  } catch (error) {
    console.error('Failed to connect to Redis:', error);
    return false;
  }
}

// Optimized scheduler setup
async function setupScheduler() {
  try {
    console.log('Setting up optimized scheduler...');
    
    // Parallel initialization
    const [redisReady] = await Promise.all([
      initRedis(),
      mongoose.connection
    ]);

    if (!redisReady) throw new Error('Redis connection failed');
    
    setupWorkers();
    
    // Batch process active schedules
    const activeSchedules = await ScheduleModel.find({ status: 'active' }).lean();
    console.log(`Found ${activeSchedules.length} active schedules`);
    
    await Promise.all(
      activeSchedules.map(schedule => setupScheduleJob(schedule._id))
    );
    
    setupImmediateCommentsProcessor();
    setupMaintenanceJob();
    setupQueueMonitoring();
    
    console.log('Optimized scheduler setup complete');
    return true;
  } catch (error) {
    console.error('Error setting up scheduler:', error);
    return false;
  }
}

// Optimized schedule job setup
async function setupScheduleJob(scheduleId) {
  try {
    // Stop existing job if it exists
    if (activeJobs.has(scheduleId)) {
      activeJobs.get(scheduleId).stop();
      activeJobs.delete(scheduleId);
    }
    
    const schedule = await ScheduleModel.findById(scheduleId).lean();
    if (!schedule || schedule.status !== 'active') return false;

    // Cache schedule info with pipeline
    await redisClient.set(`schedule:${scheduleId}`, JSON.stringify({
      id: schedule._id.toString(),
      status: schedule.status,
      type: schedule.schedule.type,
      user: schedule.user.toString()
    }), { EX: 86400 });

    // Process schedule type
    switch (schedule.schedule.type) {
      case 'immediate':
        await scheduleQueue.add('process-schedule', { scheduleId }, {
          priority: 1
        });
        break;
        
      case 'once':
        const delayMs = Math.max(0, new Date(schedule.schedule.startDate) - Date.now());
        await scheduleQueue.add('process-schedule', { scheduleId }, { delay: delayMs });
        break;
        
      case 'recurring':
        if (schedule.schedule.cronExpression) {
          const job = cron.schedule(schedule.schedule.cronExpression, async () => {
            await scheduleQueue.add('process-schedule', { scheduleId });
          });
          activeJobs.set(scheduleId, job);
        }
        break;
        
      case 'interval':
        if (schedule.schedule.interval?.value > 0) {
          const intervalMs = calculateIntervalMs(schedule.schedule.interval);
          const jobId = `recurring-${scheduleId}`;
          
          await scheduleQueue.add('process-schedule', { scheduleId }, {
            repeat: { every: intervalMs },
            jobId
          });
          
          activeJobs.set(scheduleId, {
            stop: async () => {
              const jobs = await scheduleQueue.getRepeatableJobs();
              const job = jobs.find(j => j.id === jobId);
              if (job) await scheduleQueue.removeRepeatableByKey(job.key);
            }
          });
        }
        break;
    }
    
    return true;
  } catch (error) {
    console.error(`Error setting up schedule job ${scheduleId}:`, error);
    return false;
  }
}

// Worker setup with higher concurrency
function setupWorkers() {
  // Schedule worker
  const scheduleWorker = new Worker('schedule-processing', async (job) => {
    const { scheduleId } = job.data;
    try {
      await optimizedProcessSchedule(scheduleId);
      return { success: true, scheduleId };
    } catch (error) {
      console.error(`Error processing schedule ${scheduleId}:`, error);
      throw error;
    }
  }, {
    connection: { 
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
      username: 'default',
    password: process.env.REDIS_PASSWORD,
    tls:{}
    },
    concurrency: 30,
    limiter: {
      max: 100,
      duration: 1000
    }
  });

  // Comment worker
  const commentWorker = new Worker('comment-posting', async (job) => {
    const { commentId,scheduleId } = job.data;
  
    try {
      const comment = await getCommentWithRetry(commentId);
      if (!comment) throw new Error(`Comment ${commentId} not found`);
  
      if (!comment.youtubeAccount || comment.youtubeAccount.status !== 'active') {
        await CommentModel.updateOne(
          { _id: commentId },
          { status: 'failed', errorMessage: 'Invalid or inactive account' }
        );
  
          // Update the schedule's progress for failed comments
          await ScheduleModel.updateOne(
            { _id: scheduleId }, // Use the passed scheduleId
            { $inc: { 'progress.failedComments': 1 } }
          );
  
        return { success: false, message: 'Invalid or inactive account' };
      }
  
      const result = await postComment(commentId);
 
 
      const quotaExceeded =
      result.error?.includes("quota") ||
      result.error?.includes("dailyLimitExceeded")
      // Update the schedule's progress based on the result
      const updateProgress = result.success
        ? { $inc: { 'progress.postedComments': 1 } }
        : { $inc: { 'progress.failedComments': 1 } };
      
      await ScheduleModel.updateOne(
        { _id: scheduleId }, // Use the passed scheduleId
        updateProgress
      );
      
      // Save the result to the YouTube account
      if (comment.youtubeAccount._id) {
        await YouTubeAccountModel.updateOne(
          { _id: comment.youtubeAccount._id },
          {
            $set: {
              lastMessage: result.success
                ? 'Comment posted successfully'
                : result.error || 'Unknown error', // Save the success or error message
              status: result.success ? 'active' : 'inactive', // Update status based on success/failure
            },
          }
        );
      }
      if(quotaExceeded){
        console.log("yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyeeeeeeeeeeeeeessssssssssss");
        
      }else{
        console.log ("nooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooo");
       
      }

      if (result.success) {
        console.log('Iddddddddd',comment.youtubeAccount.google.profileId);
        
        await updateProfileQuota(comment.youtubeAccount._id);
      }else if (quotaExceeded) {
await handleQuotaExceeded(comment.youtubeAccount.google.profileId);
}        
      // Mark account as inactive on failure
      if (!result.success && comment.youtubeAccount._id) {
        await YouTubeAccountModel.updateOne(
          { _id: comment.youtubeAccount._id },
          { status: 'inactive' } // Ensure account is inactive on failure
        );
      }
       
    
      await Promise.all([
   
        updateCommentStatus(commentId, result)
      ]);
      
      return result;
      
    } catch (error) {
      console.error(`Error processing comment ${commentId}:`, error);
      await handleCommentError(commentId, error);
  
     
  
      throw error;
    }
  }
  , {
    connection: { 
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
      username: 'default',
      password: process.env.REDIS_PASSWORD,
      tls:{}
    },
    concurrency: 30,
    limiter: {
      max: 100,
      duration: 1000
    }
  });

  const resetQuotaWorker = new Worker('resetQuotaQueue', async job => {
    try {
      // Find all profiles that used quota or are marked as "exceeded"
      const profiles = await ApiProfile.find({
        $or: [
          { usedQuota: { $gt: 0 } },
          { status: "exceeded" }
        ]
      });
  
      for (const profile of profiles) {
        console.log(`Resetting quota for profile: ${profile.name}`);
  
        // Reset profile
        await ApiProfile.findByIdAndUpdate(profile._id, {
          usedQuota: 0,
          status: "not exceeded",
          exceededAt: null
        });
  
        // Activate related YouTube accounts
        const updatedAccounts = await YouTubeAccountModel.updateMany(
          { 'google.profileId': profile._id },
          { $set: { status: 'active' } }
        );
  
        console.log(`Updated ${updatedAccounts.modifiedCount} YouTube accounts for profile ${profile.name}`);
      }
    } catch (err) {
      console.error(`Error during quota reset job:`, err);
    }
  }, {
    connection: {
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
      username: 'default',
      password: process.env.REDIS_PASSWORD,
      tls: {}
    }
  });
  

  // Worker event handlers
  scheduleWorker.on('completed', (job, result) => {
    console.log(`Schedule job ${job.id} completed`, result);
  });

  scheduleWorker.on('failed', (job, error) => {
    console.error(`Schedule job ${job.id} failed:`, error);
  });

  commentWorker.on('completed', (job, result) => {
    console.log(`Comment job ${job.id} completed`, result);
  });

  commentWorker.on('failed', (job, error) => {
    console.error(`Comment job ${job.id} failed:`, error);
  });
  resetQuotaWorker.on('completed', (job, result) => {
    console.log(`ResetQuota job ${job.id} completed`, result);
  });
  
  resetQuotaWorker.on('failed', (job, error) => {
    console.error(`ResetQuota job ${job.id} failed:`, error);
  });
}

async function scheduleQuotaReset() {
  const resetQuotaQueue = new Queue('resetQuotaQueue', {
    connection: {
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
      username: 'default',
      password: process.env.REDIS_PASSWORD, // Optional, only if password is set
      tls: {}, // Optional, if you use Redis with TLS/SSL
    },
  });

  // Schedule the reset to run daily at midnight PT (08:00 UTC)
  await resetQuotaQueue.add('dailyReset', {}, {
    repeat: {
      cron: '0 8 * * *', // 08:00 UTC = Midnight PT
      tz: 'America/Los_Angeles',
    },
    removeOnComplete: true,
    removeOnFail: { count: 3 },
  });

  console.log('Quota reset scheduled successfully.');
}

// Call the function to schedule the job
scheduleQuotaReset().catch((err) => {
  console.error('Error scheduling quota reset:', err);
});
async function handleQuotaExceeded(profileId) {
  try {
    // Mark the profile as exceeded (only if not already)
    const updateResult = await ApiProfile.updateOne(
      { _id: profileId, status: { $ne: 'exceeded' } },
      {
        $set: {
          status: 'exceeded',
          exceededAt: new Date(),
          usedQuota: 10000
        }
      }
    );

    if (updateResult.modifiedCount === 0) {
      console.log(`Profile ${profileId} is already marked as exceeded.`);
    } else {
      console.log(`Profile ${profileId} marked as exceeded.`);
    }

    // No need to schedule a specific reset job here anymore,
    // because the global reset worker runs daily at midnight PT.
    console.log(`Quota reset will be handled by global daily reset job.`);

  } catch (error) {
    console.error(`Error handling quota exceed for profile ${profileId}:`, error);
  }
}




// Optimized schedule processing
async function optimizedProcessSchedule(scheduleId) {
  try {
    const [cachedSchedule, schedule] = await Promise.all([
      redisClient.get(`schedule:${scheduleId}`),
      ScheduleModel.findById(scheduleId).populate('selectedAccounts').lean()
    ]);

    if (cachedSchedule) {
      const parsed = JSON.parse(cachedSchedule);
      if (parsed.status !== 'active') {
        console.log(`Cached schedule ${scheduleId} is not active`);
        return false;
      }
    }

    if (!schedule || schedule.status !== 'active') {
      console.log(`Schedule ${scheduleId} is no longer active`);
      if (schedule) {
        await redisClient.set(`schedule:${scheduleId}`, JSON.stringify({
          id: schedule._id.toString(),
          status: schedule.status,
          type: schedule.schedule.type,
          user: schedule.user.toString()
        }), { EX: 86400 });
      }
      return false;
    }

    const now = new Date();
    if (schedule.schedule.endDate && new Date(schedule.schedule.endDate) < now) {
      console.log(`Schedule ${scheduleId} has ended`);
      await Promise.all([
        ScheduleModel.updateOne({ _id: scheduleId }, { status: 'completed' }),
        redisClient.set(`schedule:${scheduleId}`, JSON.stringify({
          id: schedule._id.toString(),
          status: 'completed',
          type: schedule.schedule.type,
          user: schedule.user.toString()
        }), { EX: 86400 }),
        activeJobs.has(scheduleId) ? activeJobs.get(scheduleId).stop() : Promise.resolve()
      ]);
      activeJobs.delete(scheduleId);
      return false;
    }

    const targetVideos = [...schedule.targetVideos];
    if ((targetVideos.length === 0 && schedule.targetChannels.length === 0) ||
        schedule.commentTemplates.length === 0) {
      console.log(`Schedule ${scheduleId} has no valid targets or templates`);
      return false;
    }

    await optimizedAccountProcessing(schedule, targetVideos);
    return true;
  } catch (error) {
    console.error(`Error processing schedule ${scheduleId}:`, error);
    await handleScheduleError(scheduleId, error);
    return false;
  }
}

// Optimized account processing
async function optimizedAccountProcessing(schedule, targetVideos) {
  const accounts = getAccountsByStrategy(schedule);
  if (accounts.length === 0) {
    console.log(`Schedule ${schedule._id} has no active accounts`);
    await ScheduleModel.updateOne(
      { _id: schedule._id },
      { status: 'paused', errorMessage: 'No active accounts available' }
    );
    return false;
  }

  await Promise.all([
    assignProxiesToAccounts(accounts, schedule.user),
    processCommentsForAccounts(accounts, targetVideos, schedule)
  ]);
}

function getAccountsByStrategy(schedule) {
  const activeAccounts = schedule.selectedAccounts.filter(a => a.status === 'active');
  if (activeAccounts.length === 0) return [];

  switch (schedule.accountSelection) {
    case 'specific': return activeAccounts;
    case 'random': return [activeAccounts[Math.floor(Math.random() * activeAccounts.length)]];
    case 'round-robin': 
      return [...activeAccounts].sort((a, b) => 
        (a.lastUsed || 0) - (b.lastUsed || 0));
    default: return [];
  }
}

async function assignProxiesToAccounts(accounts, userId) {
  await Promise.all(accounts.map(account => 
    !account.proxy ? assignRandomProxy(userId, account._id) : Promise.resolve()
  ));
}

async function processCommentsForAccounts(accounts, targetVideos, schedule) {
  const comments = accounts.flatMap(account => 
    targetVideos.map(video => ({
      user: schedule.user,
      youtubeAccount: account._id,
      videoId: video.videoId,
      content: getRandomTemplate(schedule.commentTemplates),
      status: 'pending',
      metadata: { scheduleId: schedule._id }
    })
  ));

  const [createdComments] = await Promise.all([
    CommentModel.insertMany(comments),
    YouTubeAccountModel.updateMany(
      { _id: { $in: accounts.map(a => a._id) } },
      { lastUsed: new Date() }
    ),
    ScheduleModel.updateOne(
      { _id: schedule._id },
      { $inc: { 'progress.totalComments': comments.length } }
    )
    
  ]);

  const jobs = createdComments.map(comment => ({
    name: 'post-comment',
    data: { commentId: comment._id , scheduleId: schedule._id  },
    opts: {
      delay: calculateOptimizedDelay(schedule.delays),
      attempts: 3,
      backoff: { type: 'exponential', delay: 3000 }
    }
  }));

  await commentQueue.addBulk(jobs);
}

// Helper functions
function getRandomTemplate(templates) {
  return templates[Math.floor(Math.random() * templates.length)];
}

async function getCommentWithRetry(commentId, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const comment = await CommentModel.findById(commentId)
      .populate({
        path: 'youtubeAccount',
        populate: { path: 'proxy' }
      });
    if (comment) return comment;
    if (attempt < maxAttempts) await new Promise(r => setTimeout(r, attempt * 500));
  }
  return null;
}

async function updateCommentStatus(commentId, result) {
  const update = result.success
    ? {
        status: 'posted',
        postedAt: new Date(),
        externalId: result.youtubeCommentId
      }
      
    : {
        status: 'failed',
        errorMessage: result.error?.substring(0, 500),
        $inc: { retryCount: 1 }
      };
  await CommentModel.updateOne({ _id: commentId }, update);
}

async function handleCommentError(commentId, error) {
  await CommentModel.updateOne(
    { _id: commentId },
    { 
      status: 'failed',
      errorMessage: error.message?.substring(0, 500),
      $inc: { retryCount: 1 }
    }
  );
}

async function handleScheduleError(scheduleId, error) {
  try {
    const schedule = await ScheduleModel.findById(scheduleId);
    if (!schedule) return;

    const update = {
      status: 'error',
      errorMessage: error.message?.substring(0, 500) || 'Unknown error'
    };

    await Promise.all([
      schedule.save(update),
      redisClient.set(`schedule:${scheduleId}`, JSON.stringify({
        id: schedule._id.toString(),
        status: 'error',
        type: schedule.schedule.type,
        user: schedule.user.toString(),
        error: update.errorMessage
      }), { EX: 86400 })
    ]);
  } catch (updateError) {
    console.error(`Error updating schedule status for ${scheduleId}:`, updateError);
  }
}

function calculateIntervalMs(interval) {
  const value = interval.value;
  switch (interval.unit) {
    case 'minutes': return value * 60 * 1000;
    case 'hours': return value * 60 * 60 * 1000;
    case 'days': return value * 24 * 60 * 60 * 1000;
    default: return value * 60 * 1000;
  }
}

// Immediate comments processor
function setupImmediateCommentsProcessor() {
  const job = cron.schedule('* * * * *', async () => {
    try {
      const pendingComments = await CommentModel.find({
        status: 'pending',
        scheduledFor: null
      }).populate('youtubeAccount').limit(50); // Increased limit
      
      await Promise.all(pendingComments.map(async (comment) => {
        if (!comment.youtubeAccount || comment.youtubeAccount.status !== 'active') {
          await CommentModel.updateOne(
            { _id: comment._id },
            { status: 'failed', errorMessage: 'Invalid or inactive account' }
          );
          return;
        }

        await commentQueue.add('post-immediate-comment', {
          commentId: comment._id.toString()
        }, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 3000 }
        });
      }));
    } catch (error) {
      console.error('Error processing immediate comments:', error);
    }
  });
  
  activeJobs.set('immediate-processor', job);
}

// Queue monitoring
function setupQueueMonitoring() {
  const scheduleQueueEvents = new QueueEvents('schedule-processing', {
    connection: { 
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
      username: 'default',
    password: process.env.REDIS_PASSWORD,
    tls:{}
    }
  });
  
  const commentQueueEvents = new QueueEvents('comment-posting', {
    connection: { 
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
      username: 'default',
      password: process.env.REDIS_PASSWORD,
      tls:{}
    }
  });
  
  scheduleQueueEvents.on('stalled', ({ jobId }) => {
    console.warn(`Schedule job ${jobId} is stalled`);
  });
  
  commentQueueEvents.on('stalled', ({ jobId }) => {
    console.warn(`Comment job ${jobId} is stalled`);
  });
}

// Maintenance job
function setupMaintenanceJob() {
  const job = cron.schedule('0 0 * * *', async () => {
    try {
      console.log('Running maintenance tasks...');
      
      // Clean orphaned jobs
      const comments = await CommentModel.find({ status: 'pending' });
      const commentIds = comments.map(c => c._id.toString());
      
      const jobs = await commentQueue.getJobs(['waiting', 'delayed']);
      await Promise.all(jobs.map(async (job) => {
        if (!commentIds.includes(job.data.commentId)) {
          await job.remove();
        }
      }));

      // Clean completed/failed jobs
      await Promise.all([
        commentQueue.clean(1000, 'completed'),
        commentQueue.clean(1000, 'failed'),
        scheduleQueue.clean(1000, 'completed'),
        scheduleQueue.clean(1000, 'failed')
      ]);

      console.log('Maintenance tasks completed');
    } catch (error) {
      console.error('Maintenance job failed:', error);
    }
  });
  
  activeJobs.set('maintenance', job);
}

// Profile quota management
async function updateProfileQuota(youtubeAccountId) {
  try {
    const account = await YouTubeAccountModel.findById(youtubeAccountId);
    if (!account || !account.google.profileId) {
      console.warn(`Account ${youtubeAccountId} or associated profile not found`);
      return;
    }

    const profile = await ApiProfile.findById(account.google.profileId);
    if (!profile) {
      console.warn(`Profile ${account.google.profileId} not found`);
      return;
    }

    // Increment the usedQuota by 50
    profile.usedQuota += 50;
    await profile.save();

    console.log(`Profile ${profile._id} usedQuota updated. New value: ${profile.usedQuota}`);
  } catch (error) {
    console.error('Error updating profile quota:', error);
  }
}


// Graceful shutdown
async function shutdown() {
  try {
    console.log('Gracefully shutting down scheduler service...');
    
    // Stop all active cron jobs
    await Promise.all(
      Array.from(activeJobs.entries()).map(([id, job]) => 
        job?.stop ? job.stop() : Promise.resolve()
      )
    );
    activeJobs.clear();
    
    // Close queue connections
    await Promise.all([
      commentQueue.close(),
      scheduleQueue.close()
    ]);
    
    // Close Redis connection
    if (redisClient?.isOpen) {
      await redisClient.quit();
    }
    
    console.log('Scheduler service shutdown complete');
  } catch (error) {
    console.error('Error during scheduler shutdown:', error);
  }
}

// Clean scheduler data
async function cleanSchedulerData() {
  try {
    const keys = await redisClient.keys('*');
    if (keys.length > 0) {
      await redisClient.del(keys);
    }
    console.log(`Cleaned ${keys.length} Redis keys`);
    return true;
  } catch (error) {
    console.error('Error cleaning Redis:', error);
    return false;
  }
}

module.exports = {
  setupScheduler,
  setupScheduleJob,
  processSchedule: optimizedProcessSchedule,
  cleanSchedulerData,
  shutdown
};