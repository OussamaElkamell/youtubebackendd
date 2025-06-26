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

// Configuration constants
const REDIS_CONFIG = {
host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
      username: 'default',
    password: process.env.REDIS_PASSWORD,
    tls:{}

};

const QUEUE_CONFIG = {
  connection: REDIS_CONFIG,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: true,
    removeOnFail: 1000
  }
};

// Redis client singleton
let redisClient;

// BullMQ queues
const commentQueue = new Queue('comment-posting', QUEUE_CONFIG);
const scheduleQueue = new Queue('schedule-processing', QUEUE_CONFIG);

// Active jobs tracker
const activeJobs = new Map();

// Round-robin account selector state
let lastUsedIndex = -1;

/**
 * Initialize Redis connection with optimized settings
 */
async function initRedis() {
  try {
    if (redisClient?.isOpen) return true;

    redisClient = createClient({
      url: process.env.REDIS_URL,
      socket: {
        tls: process.env.NODE_ENV === 'production',
        reconnectStrategy: (retries) => Math.min(retries * 100, 5000)
      },
      commandsQueueMaxLength: 1000,
      disableClientInfo: true,
      disableOfflineQueue: true,
      legacyMode: false
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

/**
 * Calculate optimized delay with logarithmic distribution
 */
function calculateOptimizedDelay(delays = {}) {
  if (!delays || !delays.maxDelay) return 1000;

  const max = Math.min(delays.maxDelay, 30);
  const min = Math.max(delays.minDelay || 1, 1);
  
  return Math.floor(
    Math.pow(10, Math.random() * Math.log10(max - min + 1)) + min - 1
  ) * 1000;
}

/**
 * Main scheduler setup function
 */
async function setupScheduler() {
  try {
    console.log('Setting up optimized scheduler...');
    
    const [redisReady] = await Promise.all([
      initRedis(),
      mongoose.connection
    ]);

    if (!redisReady) throw new Error('Redis connection failed');
  
    setupWorkers();
    
    const activeSchedules = await ScheduleModel.find({ status: 'active' }).lean();
    console.log(`Found ${activeSchedules.length} active schedules`);
       setupQueueMonitoring();
    await Promise.all(
      activeSchedules.map(schedule => setupScheduleJob(schedule._id))
    );
   
    setupImmediateCommentsProcessor();
    setupMaintenanceJob();
    setupMaintenanceSheduler()
    scheduleQuotaReset();
    // scheduleFrequentStatusReset();
    resetRedis()
    console.log('Optimized scheduler setup complete');
    return true;
  } catch (error) {
    console.error('Error setting up scheduler:', error);
    return false;
  }
}

/**
 * Setup schedule job based on type
 */
async function setupScheduleJob(scheduleId) {
  try {
    // Stop existing job if it exists
    if (activeJobs.has(scheduleId)) {
      await activeJobs.get(scheduleId).stop();
      activeJobs.delete(scheduleId);
    }
    
    const schedule = await ScheduleModel.findById(scheduleId).lean();
    if (!schedule || schedule.status !== 'active') return false;

    // Cache schedule info
    await redisClient.set(`schedule:${scheduleId}`, JSON.stringify({
      id: schedule._id.toString(),
      status: schedule.status,
      type: schedule.schedule.type,
      user: schedule.user.toString()
    }), { EX: 86400 });

    // Process schedule type
    switch (schedule.schedule.type) {
      case 'immediate':
        await scheduleQueue.add('process-schedule', { scheduleId }, { priority: 1 });
        break;
        
      case 'once':
        const delayMs = Math.max(0, new Date(schedule.schedule.startDate) - Date.now());
        await scheduleQueue.add('process-schedule', { scheduleId }, { delay: delayMs });
        break;
        
      case 'recurring':
        if (schedule.schedule.cronExpression) {
          const job = cron.schedule(schedule.schedule.cronExpression, async () => {
            await scheduleQueue.add('process-schedule', { scheduleId });
          }, { timezone: 'America/Los_Angeles' });
          activeJobs.set(scheduleId, job);
        }
        break;
        
      case 'interval':
        
        if (schedule.schedule.interval?.value > 0) {
          const intervalMs = schedule.delays?.delayofsleep > 0 
            ? schedule.delays.delayofsleep * 60 * 1000
            : calculateIntervalMs(schedule.schedule.interval);
          
          const jobId = `interval-${scheduleId}`;
          
          await scheduleQueue.add('process-schedule', { scheduleId }, {
            repeat: { every: intervalMs },
            jobId,
            removeOnComplete: true,
            removeOnFail: true
          });
            console.log('Check');
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

/**
 * Handle interval schedule with delay logic
 */
async function handleIntervalSchedule(schedule, scheduleId) {
  if (!schedule.schedule.interval?.value > 0) return;

  try {
    const currentSchedule = await ScheduleModel.findById(scheduleId).lean();
    if (!currentSchedule) return;

    // Calculate interval
    let intervalMs;
    const postedComments = currentSchedule.progress?.postedComments || 0;
    const limitComments = currentSchedule.delays?.limitComments || 0;
    
    if (limitComments > 0 && postedComments % limitComments === 0 && postedComments > 0) {
      const minDelay = currentSchedule.delays.minDelay || 1;
      const maxDelay = currentSchedule.delays.maxDelay || 30;
      const randomDelay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
      intervalMs = randomDelay * 60 * 1000;
      console.log(`[Schedule ${scheduleId}] Applying random delay of ${randomDelay} minutes`);
      
      await ScheduleModel.updateOne(
        { _id: schedule._id },
        { 
          $set: { 
            'delays.delayofsleep': randomDelay,
            'delays.delayStartTime': new Date()
          } 
        }
      );
      
      // Remove any existing job
      const jobId = `interval-${scheduleId}`;
      const jobs = await scheduleQueue.getRepeatableJobs();
      const existingJob = jobs.find(j => j.id === jobId);
      if (existingJob) await scheduleQueue.removeRepeatableByKey(existingJob.key);
      
      // Create new job with the updated delay
      await scheduleQueue.add('process-schedule', { scheduleId }, {
        repeat: { every: intervalMs },
        jobId,
        removeOnComplete: true,
        removeOnFail: true
      });

      return;
    }

    // If no special delay is needed, use the normal interval
    intervalMs = calculateIntervalMs(currentSchedule.schedule.interval);
    await ScheduleModel.updateOne(
      { _id: schedule._id },
      { 
        $set: { 
          'delays.delayofsleep': 0,
          'delays.delayStartTime': null
        } 
      }
    );

    // Manage the job
    const jobId = `interval-${scheduleId}`;
    const jobs = await scheduleQueue.getRepeatableJobs();
    const existingJob = jobs.find(j => j.id === jobId);
    if (existingJob) await scheduleQueue.removeRepeatableByKey(existingJob.key);
    
    await scheduleQueue.add('process-schedule', { scheduleId }, {
      repeat: { every: intervalMs },
      jobId,
      removeOnComplete: true,
      removeOnFail: true
    });

    activeJobs.set(scheduleId, {
      stop: async () => {
        const jobs = await scheduleQueue.getRepeatableJobs();
        const job = jobs.find(j => j.id === jobId);
        if (job) await scheduleQueue.removeRepeatableByKey(job.key);
      }
    });

  } catch (error) {
    console.error(`[Schedule ${scheduleId}] Error handling interval:`, error);
    throw error;
  }
}
async function fetchNextComment(scheduleId) {
  const now = new Date();
  const schedule = await ScheduleModel.findById(scheduleId).exec();

  const query = {
    status: 'scheduled',
    scheduledFor: { $lte: now },
    scheduleId: scheduleId,
  };

  // 🔥 Filter out last used account
  if (schedule?.lastUsedAccount) {
    query.youtubeAccount = { $ne: schedule.lastUsedAccount };
  }

  const comment = await CommentModel.findOne(query)
    .populate({
      path: "youtubeAccount",
      populate: { path: "proxy" },
    })
    .exec();

  return comment;
}

/**
 * Setup workers for processing queues
 */
function setupWorkers() {
  // Schedule worker
const scheduleWorker = new Worker('schedule-processing', async (job) => {
  console.log(`Processing schedule job ${job.id} with data:`, job.data);
  const { scheduleId } = job.data;
  try {
    await optimizedProcessSchedule(scheduleId);
  } catch (error) {
    console.error(`Error processing schedule ${scheduleId}:`, error);
    throw error;
  }
}, {
  connection: REDIS_CONFIG,
  concurrency: 5
});

scheduleWorker.on('completed', (job) => {
  console.log(`Schedule job ${job.id} completed`);
});

scheduleWorker.on('failed', (job, err) => {
  console.error(`Schedule job ${job.id} failed:`, err);
});
  // Comment worker
  const commentWorker = new Worker('comment-posting', async (job) => {
    const { commentId, scheduleId } = job.data;
    console.log("hello");
    
    try {
      const comment = await getCommentWithRetry(commentId);
      if (!comment) throw new Error(`Comment ${commentId} not found`);
  
      if (!comment.youtubeAccount || comment.youtubeAccount.status !== 'active') {
        await CommentModel.updateOne(
          { _id: commentId },
          { status: 'failed', errorMessage: 'Invalid or inactive account' }
        );
  
        await ScheduleModel.updateOne(
          { _id: scheduleId },
          { $inc: { 'progress.failedComments': 1 } }
        );
  
        return { success: false, message: 'Invalid or inactive account' };
      }
      
      const result = await postComment(commentId);
  
      const quotaExceeded = result.error?.includes("quota") || result.error?.includes("dailyLimitExceeded");
      const proxyError = result.error?.includes("proxy") || result.error?.includes("invalid proxy") || result.error === "invalid proxy";
      const duplication= result.message?.includes("No available accounts. Comment delayed for retry.") || result.error?.includes("Comment delayed for retry")
      console.log("result.error",result.message);
      const updateProgress = result.success
        ? { $inc: { 'progress.postedComments': 1 } }
        : { $inc: { 'progress.failedComments': 1 } };
  
      await ScheduleModel.updateOne({ _id: scheduleId }, updateProgress);
  
      let updateFields = {
        lastMessage: result.success ? 'Comment posted successfully' : result.message || result.error|| 'Unknown error',
      };
  
      if (result.success) {
        updateFields.status = 'active';
        updateFields.proxyErrorCount = 0;
        const schedule = await ScheduleModel.findById(scheduleId);
        if (schedule?.schedule?.type === 'interval') {
          await handleIntervalSchedule(schedule, scheduleId);
        }
      } else if (proxyError) {
        const currentAccount = await YouTubeAccountModel.findById(comment.youtubeAccount._id);
        const newCount = (currentAccount?.proxyErrorCount || 0) + 1;
        updateFields.proxyErrorCount = newCount;
        updateFields.status = newCount >= 3 ? 'inactive' : 'active';
          } else if (duplication) {
        const currentAccount = await YouTubeAccountModel.findById(comment.youtubeAccount._id);
        const newCount = (currentAccount?.duplicationCount || 0) + 1;
        updateFields.duplicationCount = newCount;
        updateFields.status = 'active';
      } else {
        updateFields.proxyErrorCount = 0;
        updateFields.status = 'inactive';
      }
  
      if (comment.youtubeAccount._id) {
        await YouTubeAccountModel.updateOne(
          { _id: comment.youtubeAccount._id },
          { $set: updateFields }
        );
      }
  
      if (quotaExceeded) {
        await handleQuotaExceeded(comment.youtubeAccount.google.profileId);
      }
  
      if (result.success) {
        await updateProfileQuota(comment.youtubeAccount._id);
      }
  
      await updateCommentStatus(commentId, result);
      return result;
  
    } catch (error) {
      console.error(`Error processing comment ${commentId}:`, error);
      await handleCommentError(commentId, error);
      throw error;
    }
  }, {
    connection: REDIS_CONFIG,
    concurrency: 30,
    limiter: { max: 100, duration: 1000 }
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
}

/**
 * Optimized schedule processing
 */
async function optimizedProcessSchedule(scheduleId) {
  try {
    // Ensure Redis connection
    if (!redisClient.isOpen) await redisClient.connect();

    // Check Redis cache
    let cachedSchedule;
    try {
      const cachedData = await redisClient.get(`schedule:${scheduleId}`);
      cachedSchedule = cachedData ? JSON.parse(cachedData) : null;
      if (cachedSchedule?.status === 'error') cachedSchedule = null;
    } catch (cacheError) {
      console.error(`[Schedule ${scheduleId}] Error reading cache:`, cacheError);
      cachedSchedule = null;
    }

    // Get fresh data from DB
    const schedule = await ScheduleModel.findById(scheduleId)
      .populate('selectedAccounts')
      .populate('user')
      .lean();

    if (!schedule) {
      console.log(`[Schedule ${scheduleId}] Not found in database`);
      await redisClient.del(`schedule:${scheduleId}`);
      return false;
    }

    // Check for active delay period
    if (schedule?.delays?.delayofsleep > 0 && schedule?.delays?.delayStartTime) {
      const delayStartTime = new Date(schedule.delays.delayStartTime);
      const delayEndTime = new Date(delayStartTime);
      delayEndTime.setMinutes(delayEndTime.getMinutes() + schedule.delays.delayofsleep);
      
      if (new Date() < delayEndTime) {
        console.log(`[Schedule ${scheduleId}] Skipping processing - active delay period (${schedule.delays.delayofsleep} minutes) until ${delayEndTime}`);
        return false;
      } else {
        // Delay period has ended - clear it
        await ScheduleModel.updateOne(
          { _id: scheduleId },
          { 
            $set: { 
              'delays.delayofsleep': 0,
              'delays.delayStartTime': null
            } 
          }
        );
        console.log(`[Schedule ${scheduleId}] Delay period ended - resuming normal processing`);
      }
    }

    // Update cache with fresh data
    if (!cachedSchedule || cachedSchedule.status !== schedule.status) {
      await redisClient.set(`schedule:${scheduleId}`, JSON.stringify({
        id: schedule._id.toString(),
        status: schedule.status,
        type: schedule.schedule.type,
        user: schedule.user.toString()
      }), { 
        EX: schedule.status === 'error' ? 3600 : 86400
      });
    }

    // Check schedule status
    if (schedule.status !== 'active') {
      console.log(`[Schedule ${scheduleId}] Status is ${schedule.status} in database`);
      return false;
    }

    // Check end date
    const now = new Date();
    if (schedule.schedule.endDate && new Date(schedule.schedule.endDate) < now) {
      console.log(`[Schedule ${scheduleId}] Schedule has ended`);
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

    // Validate targets and templates
    const targetVideos = [...schedule.targetVideos];
    if ((targetVideos.length === 0 && schedule.targetChannels.length === 0) ||
        schedule.commentTemplates.length === 0) {
      console.log(`[Schedule ${scheduleId}] No valid targets or templates`);
      await ScheduleModel.updateOne(
        { _id: scheduleId },
        { 
          status: 'requires_review',
          errorMessage: 'No valid targets or templates'
        }
      );
      return false;
    }

    // Update last processed time and reset error count
    await ScheduleModel.updateOne(
      { _id: scheduleId },
      { 
        $set: { 
          lastProcessedAt: new Date(),
          errorMessage: null,
          status: 'active'
        },
        $unset: { errorCount: "" }
      }
    );

    // Process accounts and create comments
    await optimizedAccountProcessing(schedule, targetVideos);

    return true;

  } catch (error) {
    console.error(`[Schedule ${scheduleId}] Error processing schedule:`, error);
    
    try {
      const currentStatus = await ScheduleModel.findById(scheduleId).select('status').lean();
      
      if (currentStatus?.status === 'active') {
        const errorCount = (currentStatus.errorCount || 0) + 1;
        const newStatus = errorCount >= 3 ? 'requires_review' : 'error';
        
        await ScheduleModel.updateOne(
          { _id: scheduleId },
          { 
            status: newStatus,
            errorMessage: error.message?.substring(0, 500) || 'Unknown error',
            errorCount
          }
        );
        
        await redisClient.set(`schedule:${scheduleId}`, JSON.stringify({
          id: scheduleId,
          status: newStatus,
          type: 'unknown',
          user: 'unknown'
        }), { EX: 3600 });
      }
    } catch (updateError) {
      console.error(`[Schedule ${scheduleId}] Error updating error status:`, updateError);
    }
    
    return false;
  }
}

/**
 * Process accounts for a schedule
 */
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
    processCommentsForAccounts(accounts, targetVideos, schedule)
  ]);
}

/**
 * Select accounts based on strategy
 */
function getAccountsByStrategy(schedule) {
  const activeAccounts = schedule.selectedAccounts.filter(a => a.status === 'active');
  if (activeAccounts.length === 0) return [];

  switch (schedule.accountSelection) {
    case 'specific': return activeAccounts;
    case 'random': return [activeAccounts[Math.floor(Math.random() * activeAccounts.length)]];
    case 'round-robin': 
      return activeAccounts.length > 0 ? [selectRoundRobinAccount(activeAccounts)] : [];
    default: return [];
  }
}

/**
 * Round-robin account selection
 */
function selectRoundRobinAccount(accounts) {
  if (!accounts || accounts.length === 0) return null;
  if (accounts.length === 1) {
    lastUsedIndex = 0;
    return accounts[0];
  }

  const nextIndex = (lastUsedIndex + 1) % accounts.length;
  lastUsedIndex = nextIndex;
  return accounts[nextIndex];
}

/**
 * Process comments for accounts
 */
async function processCommentsForAccounts(accounts, targetVideos, schedule) {
  if (schedule.delays?.delayofsleep > 0) {
    console.log(`[Schedule ${schedule._id}] Skipping comment creation - delay of ${schedule.delays.delayofsleep} minutes active`);
    return;
  }
  const filteredAccounts = schedule.lastUsedAccount
    ? accounts.filter(acc => acc._id.toString() !== schedule.lastUsedAccount.toString())
    : accounts;

  if (filteredAccounts.length === 0) {
    console.log(`[Schedule ${schedule._id}] No available accounts after excluding lastUsedAccount`);
    // Optionally handle resetting lastUsedAccount or fallback logic here
    return;
  }
  const comments = filteredAccounts.map(account => {
    const randomVideo = targetVideos[Math.floor(Math.random() * targetVideos.length)];
    
    return {
      user: schedule.user,
      youtubeAccount: account._id,
      videoId: randomVideo.videoId,
      scheduleId: schedule._id,
      content: getRandomTemplate(schedule.commentTemplates),
      status: 'pending',
      metadata: { scheduleId: schedule._id }
    };
  });

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
    data: { commentId: comment._id, scheduleId: schedule._id },
    opts: {
      delay: calculateOptimizedDelay(schedule.delays),
      attempts: 3,
      backoff: { type: 'exponential', delay: 3000 }
    }
  }));

  console.log(`Queuing ${jobs.length} comments with random video selection`);
  await commentQueue.addBulk(jobs);
}

/**
 * Get random comment template
 */
function getRandomTemplate(templates) {
  return templates[Math.floor(Math.random() * templates.length)];
}

/**
 * Get comment with retry logic
 */
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
async function fetchNextComment(scheduleId) {
  const now = new Date();
  const schedule = await ScheduleModel.findById(scheduleId).exec();

  const query = {
    status: 'scheduled',
    scheduledFor: { $lte: now },
    scheduleId: scheduleId,
  };

  // 🔥 Filter out last used account
  if (schedule?.lastUsedAccount) {
    query.youtubeAccount = { $ne: schedule.lastUsedAccount };
  }

  const comment = await CommentModel.findOne(query)
    .populate({
      path: "youtubeAccount",
      populate: { path: "proxy" },
    })
    .exec();

  return comment;
}

/**
 * Update comment status after processing
 */
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

/**
 * Handle comment processing errors
 */
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

/**
 * Handle quota exceeded scenario
 */
async function handleQuotaExceeded(profileId) {
  try {
    const updateResult = await ApiProfile.updateOne(
      { _id: profileId, status: { $ne: 'exceeded' } },
      {
        $set: {
          status: 'exceeded',
          exceededAt: new Date()
        }
      }
    );

    if (updateResult.modifiedCount === 0) {
      console.log(`Profile ${profileId} is already marked as exceeded.`);
    } else {
      console.log(`Profile ${profileId} marked as exceeded.`);
    }

    console.log(`Quota reset will be handled by global daily reset job.`);
  } catch (error) {
    console.error(`Error handling quota exceed for profile ${profileId}:`, error);
  }
}

/**
 * Update profile quota usage
 */
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

    profile.usedQuota += 50;
    await profile.save();
    console.log(`Profile ${profile._id} usedQuota updated. New value: ${profile.usedQuota}`);
  } catch (error) {
    console.error('Error updating profile quota:', error);
  }
}

/**
 * Calculate interval in milliseconds
 */
function calculateIntervalMs(interval) {
  const value = interval.value;
  switch (interval.unit) {
    case 'minutes': return value * 60 * 1000;
    case 'hours': return value * 60 * 60 * 1000;
    case 'days': return value * 24 * 60 * 60 * 1000;
    default: return value * 60 * 1000;
  }
}

/**
 * Schedule daily quota reset
 */
function scheduleQuotaReset() {
  cron.schedule('0 0 * * *', async () => {
    try {
      const [updatedYT, updatedAPI, updatedSchedules] = await Promise.all([
        YouTubeAccountModel.updateMany({}, { $set: { status: 'active' } }),
        ApiProfile.updateMany({}, { $set: { usedQuota: 0, status: 'not exceeded', exceededAt: null } }),
        ScheduleModel.updateMany({}, { $set: { status: 'active' } })
      ]);

      console.log(
        `Quota reset complete at ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}: ` +
        `${updatedYT.modifiedCount} YT accounts, ` +
        `${updatedAPI.modifiedCount} API profiles, ` +
        `${updatedSchedules.modifiedCount} schedules updated.`
      );
    } catch (error) {
      console.error('Error during daily quota reset:', error);
    }
  }, { timezone: 'America/Los_Angeles' });

  console.log('Daily quota reset cron job scheduled for 00:00 PT.');
}

/**
 * Schedule frequent status reset (every 15 seconds)
 */
function scheduleFrequentStatusReset() {
  cron.schedule('*/15 * * * * *', async () => {
    try {
      const [updatedYT, updatedSchedules] = await Promise.all([
        YouTubeAccountModel.updateMany({}, { $set: { status: 'active' } }),
        ScheduleModel.updateMany({}, { $set: { status: 'active' } })
      ]);

      console.log(`[${new Date().toISOString()}] Frequent reset: ${updatedYT.modifiedCount} YouTube accounts, ${updatedSchedules.modifiedCount} schedules updated.`);
    } catch (error) {
      console.error('Error during frequent status reset:', error);
    }
  }, { timezone: 'America/Los_Angeles' });
}

/**
 * Setup immediate comments processor
 */
function setupImmediateCommentsProcessor() {
  const job = cron.schedule('* * * * *', async () => {
    try {
      const pendingComments = await CommentModel.find({
        status: 'pending',
        scheduledFor: null
      }).populate('youtubeAccount').limit(50);
      
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

/**
 * Setup queue monitoring
 */
function setupQueueMonitoring() {
// Add this when creating your queue
const scheduleQueue = new Queue('schedule-processing', {
  connection: {
    ...REDIS_CONFIG,
    retryStrategy: (times) => {
      console.log(`Redis connection attempt ${times}`);
      return Math.min(times * 100, 5000);
    }
  }
});

scheduleQueue.on('error', (err) => {
  console.error('Queue error:', err);
});

scheduleQueue.on('ioredis:close', () => {
  console.log('Redis connection closed');
});

scheduleQueue.on('waiting', (jobId) => {
  console.log(`Job ${jobId} is waiting`);
});
  
  const commentQueueEvents = new QueueEvents('comment-posting', {
    connection: REDIS_CONFIG
  });
  
  scheduleQueue.on('stalled', ({ jobId }) => {
    console.warn(`Schedule job ${jobId} is stalled`);
  });
  
  commentQueueEvents.on('stalled', ({ jobId }) => {
    console.warn(`Comment job ${jobId} is stalled`);
  });
}

/**
 * Setup maintenance job
 */
function setupMaintenanceJob() {
  const job = cron.schedule('*/30 * * * *', async () => {
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


function setupMaintenanceSheduler() {
  const job = cron.schedule('*/30 * * * *', async () => {
    try {
      console.log("Running maintenance scheduler...");

      // Fetch all schedules
      const schedules = await ScheduleModel.find({}).exec();

      for (const schedule of schedules) {
        const { _id, progress } = schedule;

        // Count actual comments in the database
        const [postedCount, failedCount, totalCount] = await Promise.all([
          CommentModel.countDocuments({ scheduleId: _id, status: 'posted' }),
          CommentModel.countDocuments({ scheduleId: _id, status: 'failed' }),
          CommentModel.countDocuments({ scheduleId: _id }),
        ]);

        const expectedTotal = postedCount + failedCount;

        // If mismatch, update the progress field
        if (progress.totalComments !== totalCount ||
            progress.postedComments !== postedCount ||
            progress.failedComments !== failedCount) {
          console.log(`Fixing progress for schedule ${_id}`);

          schedule.progress = {
            totalComments: totalCount,
            postedComments: postedCount,
            failedComments: failedCount,
          };

          await schedule.save();
        }
      }

    } catch (error) {
      console.error('Maintenance job failed:', error);
    }
  });

  activeJobs.set('maintenance', job);
}

/**
 * Reset Redis data
 */
async function resetRedis() {
  try {
    await redisClient.flushAll();
    console.log('Redis has been reset.');
  } catch (error) {
    console.error('Error resetting Redis:', error);
  }
}

/**
 * Graceful shutdown
 */
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

module.exports = {
  setupScheduler,
  setupScheduleJob,
  setupMaintenanceJob,
  processSchedule: optimizedProcessSchedule,
  scheduleQuotaReset,
  scheduleFrequentStatusReset,
  setupMaintenanceSheduler,
  resetRedis,
  shutdown
};