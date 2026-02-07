const { Queue, Worker, QueueEvents } = require('bullmq');
const { createClient } = require('redis');
const cron = require('node-cron');
const prisma = require('./prisma.service');
const youtubeService = require('./youtube.service');
const viewerService = require('./viewer.service');
const { assignRandomProxy } = require('./proxy.service');
const { cacheService } = require('../services/cacheService');
const { rotateAccountsForSleepCycle } = require('./account.rotation');
const Redis = require('ioredis');
const https = require('https');
const axios = require('axios');
require('dotenv').config();
const Groq = require("groq-sdk");
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const redisURL = new URL(process.env.REDIS_URL);

const isRemoteRedis = process.env.REDIS_URL && !process.env.REDIS_URL.includes('localhost') && !process.env.REDIS_URL.includes('127.0.0.1');

const REDIS_CONFIG = isRemoteRedis || process.env.NODE_ENV === 'production'
  ? {
    host: redisURL.hostname,
    port: Number(redisURL.port),
    username: redisURL.username,
    password: redisURL.password,
    tls: redisURL.protocol === 'rediss:' ? {} : undefined,
    family: 0,
  }
  : {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
  };

const QUEUE_CONFIG = {
  connection: REDIS_CONFIG,
  defaultJobOptions: {
    attempts: 1,
    backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: true,
    removeOnFail: 1000
  }
};
// Redis client singleton
let redisClient;

// BullMQ queues
const commentQueue = new Queue('post-comment', QUEUE_CONFIG);
const viewQueue = new Queue('simulate-view', QUEUE_CONFIG);
const scheduleQueue = new Queue('schedule-processing', QUEUE_CONFIG);

// QueueEvents for monitoring delayed jobs
const commentQueueEvents = new QueueEvents('post-comment', { connection: REDIS_CONFIG });

// Active jobs tracker
const activeJobs = new Map();

// Workers declared at module level to be accessible by event handlers
let scheduleWorker;
let commentWorker;
let viewWorker;

/**
 * Initialize Redis connection with optimized settings
 */
const monitorRedis = new Redis(process.env.REDIS_URL + (process.env.REDIS_URL.includes('?') ? '&' : '?') + 'family=0');
monitorRedis.on('error', (err) => console.error('monitorRedis Error:', err));
async function initRedis() {
  try {
    if (redisClient?.isOpen) return true;

    redisClient = createClient({
      url: process.env.REDIS_URL,
      socket: {
        tls: redisURL.protocol === 'rediss:',
        connectTimeout: 10000,
        reconnectStrategy: retries => Math.min(retries * 100, 5000)
      },
      disableOfflineQueue: true
    });


    redisClient.on('error', (err) => console.error('Redis Client Error:', err));

    await redisClient.connect();
    console.log('✅ Redis client connected');
    return true;
  } catch (error) {
    console.error('❌ Failed to connect to Redis:', error);
    return false;
  }
}

/**
 * Calculate optimized delay with logarithmic distribution
 */
function calculateOptimizedDelay(delays = {}) {
  // Use configuration values strictly, falling back only to minimal safety defaults
  const max = Number(delays.maxDelay || 30);
  const min = Number(delays.minDelay || 1);

  // Ensure min < max to avoid Math.log10 issues
  const actualMin = Math.max(1, min);
  const actualMax = Math.max(actualMin + 1, max);

  return Math.floor(
    Math.pow(10, Math.random() * Math.log10(actualMax - actualMin + 1)) + actualMin - 1
  ) * 1000;
}

/**
 * Main scheduler setup function
 */
async function setupScheduler() {
  try {
    console.log('Setting up optimized scheduler...');

    const redisReady = await initRedis();
    if (!redisReady) throw new Error('Redis connection failed');

    // ☢️ NUCLEAR CLEANUP: Clear any legacy repeaters stuck in Redis
    const schedulers = await scheduleQueue.getJobSchedulers();
    for (const s of schedulers) {
      await scheduleQueue.removeJobScheduler(s.key);
      console.log(`[Startup] 🧹 Removed rogue repeater: ${s.key}`);
    }

    const repeaterKeys = await redisClient.keys('bull:schedule-processing:repeat:*');
    if (repeaterKeys.length > 0) {
      console.log(`[Startup] 💣 Found ${repeaterKeys.length} ghost repeater keys in Redis, deleting...`);
      await redisClient.del(repeaterKeys);
    }

    const activeSchedules = await prisma.schedule.findMany({
      where: { status: 'active' }
    });
    console.log(`Found ${activeSchedules.length} active schedules`);

    setupQueueMonitoring();

    await Promise.all(
      activeSchedules.map(schedule => setupScheduleJob(schedule.id))
    );

    // setupMaintenanceJob();
    setupMaintenanceSheduler();
    scheduleQuotaReset();
    // resetRedis();
    console.log('Optimized scheduler setup complete');
    return true;
  } catch (error) {
    console.error('Error setting up scheduler:', error);
    return false;
  }
}

function randomBetween(min, max) {
  return Math.round(Math.random() * (max - min) + min);
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

    const schedule = await prisma.schedule.findUnique({
      where: { id: scheduleId },
      include: {
        principalAccounts: true,
        secondaryAccounts: true
      }
    });
    if (!schedule || schedule.status !== 'active') return false;

    // Cache schedule info
    await redisClient.set(`schedule:${scheduleId}`, JSON.stringify({
      id: schedule.id,
      status: schedule.status,
      type: schedule.scheduleType,
      user: schedule.userId
    }), { EX: 86400 });

    // 🛡️ Guard: Check for active sleep mode
    if (schedule.sleepDelayMinutes > 0 && schedule.sleepDelayStartTime) {
      const delayStartTime = new Date(schedule.sleepDelayStartTime);
      const delayEndTime = new Date(delayStartTime.getTime() + schedule.sleepDelayMinutes * 60 * 1000);

      if (new Date() < delayEndTime) {
        console.log(`[Schedule ${scheduleId}] Skipping setupScheduleJob - active delay period until ${delayEndTime}`);
        return true; // Already handled by the interval queue
      }
    }

    // Process schedule type
    switch (schedule.scheduleType) {
      case 'immediate':
        await scheduleQueue.add('schedule-processing', { scheduleId }, {
          priority: 1,
          jobId: `immediate-${scheduleId}`,
          removeOnComplete: true,
          removeOnFail: true
        });
        break;

      case 'once':
        if (schedule.startDate) {
          const delayMs = Math.max(0, new Date(schedule.startDate) - Date.now());
          await scheduleQueue.add('schedule-processing', { scheduleId }, {
            delay: delayMs,
            jobId: `once-${scheduleId}`,
            removeOnComplete: true,
            removeOnFail: true
          });
        }
        break;

      case 'recurring':
        if (schedule.cronExpression) {
          const job = cron.schedule(schedule.cronExpression, async () => {
            await scheduleQueue.add('schedule-processing', { scheduleId }, {
              jobId: `recurring-${scheduleId}-${Date.now()}`,
              removeOnComplete: true,
              removeOnFail: true
            });
          }, { timezone: 'America/Los_Angeles' });
          activeJobs.set(scheduleId, job);
        }
        break;

      case 'interval':
        if ((schedule.interval?.value || 0) > 0) {
          const jobId = `interval-${scheduleId}`;
          const intervalMs = calculateIntervalMs(schedule.interval);
          let delayMs = 0;

          // 1. If we have a future nextRunAt, respect it (especially on server restart)
          const now = new Date();
          if (schedule.nextRunAt && new Date(schedule.nextRunAt) > now) {
            delayMs = Math.max(0, new Date(schedule.nextRunAt).getTime() - now.getTime());
            console.log(`[Schedule ${scheduleId}] Resuming interval with remaining delay: ${Math.round(delayMs / 1000)}s`);
          }
          // 2. If it's a future start date, wait for it
          else if (schedule.startDate && new Date(schedule.startDate) > now) {
            delayMs = new Date(schedule.startDate).getTime() - now.getTime();
            console.log(`[Schedule ${scheduleId}] Waiting for start date: ${Math.round(delayMs / 1000)}s`);
          }
          // 3. If it's a brand new schedule (no comments posted yet), wait for the first interval
          else if (!schedule.postedComments || schedule.postedComments === 0) {
            delayMs = intervalMs;
            console.log(`[Schedule ${scheduleId}] New schedule: waiting for first interval (${Math.round(delayMs / 1000)}s)`);

            // Update nextRunAt so the UI shows the countdown
            const nextRun = new Date(Date.now() + delayMs);
            await prisma.schedule.update({
              where: { id: scheduleId },
              data: { nextRunAt: nextRun }
            });

            // Refresh cache (skip job setup to avoid recursion)
            if (typeof updateScheduleCache === 'function') {
              await updateScheduleCache(scheduleId, true);
            }
          }


          // 🚀 Trigger FIRST execution as a one-off job with calculated delay
          await scheduleQueue.add('schedule-processing', { scheduleId }, {
            delay: delayMs,
            jobId: `${jobId}-${Date.now()}`,
            removeOnComplete: true,
            removeOnFail: true
          });

          activeJobs.set(scheduleId, {
            stop: async () => {
              // Status check in optimizedProcessSchedule will handle stopping the chain
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
/**
 * Handle interval schedule with delay logic
 */
async function handleIntervalSchedule(schedule, scheduleId) {
  if (!((schedule.interval?.value || 0) > 0)) return null;

  try {
    const currentSchedule = await prisma.schedule.findUnique({
      where: { id: scheduleId },
      include: {
        selectedAccounts: true,
        rotatedPrincipal: true,
        rotatedSecondary: true,
        principalAccounts: true,
        secondaryAccounts: true
      }
    });
    if (!currentSchedule) return null;

    // ✅ Stop if not active
    if (currentSchedule.status !== 'active') {
      console.log(`[Schedule ${scheduleId}] Not active. Skipping repeat job creation.`);

      const jobId = `interval-${scheduleId}`;
      const schedulers = await scheduleQueue.getJobSchedulers();
      const existingJobs = schedulers.filter(s => s.id === jobId || s.key.includes(scheduleId));
      for (const j of existingJobs) {
        await scheduleQueue.removeJobScheduler(j.key);
        console.log(`[Schedule ${scheduleId}] Removed existing repeat job ${j.key} because it's not active.`);
      }

      return null;
    }

    // ✅ Calculate interval
    let intervalMs;
    const postedComments = currentSchedule.postedComments || 0;
    const limitComments = currentSchedule.limitComments?.value || 0;

    const sleepCheckKey = `schedule:${scheduleId}:sleep:check`;
    const shouldCheckSleep = await redisClient.set(sleepCheckKey, '1', {
      NX: true,
      EX: 60 // Lock for 1 minute
    });
    const triggerCount = postedComments;
    const shouldTriggerSleep =
      limitComments > 0 &&
      triggerCount > 0 &&
      triggerCount % limitComments === 0 &&
      currentSchedule.lastSleepTriggerCount !== triggerCount;

    if (shouldTriggerSleep) {
      await prisma.schedule.update({
        where: { id: scheduleId },
        data: { lastSleepTriggerCount: triggerCount }
      });
      console.log(`[Schedule ${scheduleId}] 💤 Sleep Mode Activated:`);

      const minDelay = currentSchedule.minDelay || 1;
      const maxDelay = currentSchedule.maxDelay || 30;
      const randomDelay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
      intervalMs = randomDelay * 60 * 1000;

      const sleepEndTime = new Date(Date.now() + randomDelay * 60 * 1000);
      console.log(`  - Duration: ${randomDelay} minutes`);
      console.log(`  - Start Time: ${new Date()}`);
      console.log(`  - End Time: ${sleepEndTime}`);
      console.log(`  - Posted Comments: ${postedComments}`);
      console.log(`  - Limit: ${limitComments}`);

      // 🔄 Rotate accounts if rotation is enabled (BEFORE sleep)
      let updateData = {
        sleepDelayMinutes: randomDelay,
        sleepDelayStartTime: new Date()
      };

      if (currentSchedule.rotationEnabled) {
        console.log(`[Schedule ${scheduleId}] 🔄 Rotating accounts before sleep...`);
        const rotationResult = await rotateAccountsForSleepCycle(currentSchedule);

        if (rotationResult) {
          updateData = {
            ...updateData,
            currentlyActive: rotationResult.newActiveCategory,
            rotatedPrincipal: { set: rotationResult.rotatedPrincipalIds.map(id => ({ id })) },
            rotatedSecondary: { set: rotationResult.rotatedSecondaryIds.map(id => ({ id })) },
            selectedAccounts: { set: rotationResult.newSelectedAccounts.map(id => ({ id })) },
            lastRotatedAt: new Date()
          };

          console.log(`[Schedule ${scheduleId}] ✅ Rotation complete - Now using ${rotationResult.newActiveCategory} accounts`);
        }
      }

      await prisma.schedule.update({
        where: { id: scheduleId },
        data: updateData
      });

      // 🧹 Invalidate API cache so UI sees sleep mode
      await cacheService.clear(`user:${currentSchedule.userId}:schedules:*`);
      await cacheService.deleteUserData(currentSchedule.userId, `schedule:${scheduleId}`);

      // 🚀 NO MORE REPEAT JOBS.
      // We return intervalMs to optimizedProcessSchedule which will queue the NEXT one-off job.
      return intervalMs;
    }

    // ✅ If no special delay, use regular interval (checking if exiting sleep)
    const interval = currentSchedule.interval || {};
    let nextValue = interval.value || 1;

    // 🎲 Randomize for next run if enabled and range is available
    const minRange = interval.min ?? interval.minValue;
    const maxRange = interval.max ?? interval.maxValue;
    const isRandom = !!interval.isRandom;

    if (isRandom && typeof minRange === 'number' && typeof maxRange === 'number' && maxRange > minRange) {
      nextValue = Math.floor(Math.random() * (maxRange - minRange + 1)) + minRange;
      console.log(`[Schedule ${scheduleId}] 🎲 Randomizing next execution to: ${nextValue} ${interval.unit || 'minutes'}`);
    }

    intervalMs = calculateIntervalMs({
      value: nextValue,
      unit: interval.unit || 'minutes'
    });

    // 🔄 Check if we're exiting a sleep cycle and need to rotate back
    const wasInSleep = currentSchedule.sleepDelayMinutes > 0 && currentSchedule.sleepDelayStartTime;

    let updateData = {
      sleepDelayMinutes: 0,
      sleepDelayStartTime: null
    };

    // 🔄 Only update interval if it changed due to randomization
    if (nextValue !== interval.value) {
      updateData.interval = {
        ...interval,
        value: nextValue
      };
    }

    if (wasInSleep && currentSchedule.rotationEnabled) {
      console.log(`[Schedule ${scheduleId}] 🔄 Exiting sleep - Rotating accounts back...`);
      const rotationResult = await rotateAccountsForSleepCycle(currentSchedule);

      if (rotationResult) {
        updateData = {
          ...updateData,
          currentlyActive: rotationResult.newActiveCategory,
          rotatedPrincipal: { set: rotationResult.rotatedPrincipalIds.map(id => ({ id })) },
          rotatedSecondary: { set: rotationResult.rotatedSecondaryIds.map(id => ({ id })) },
          selectedAccounts: { set: rotationResult.newSelectedAccounts.map(id => ({ id })) },
          lastRotatedAt: new Date()
        };

        console.log(`[Schedule ${scheduleId}] ✅ Post-sleep rotation complete - Now using ${rotationResult.newActiveCategory} accounts`);
      }
    }

    await prisma.schedule.update({
      where: { id: scheduleId },
      data: updateData
    });

    // 🧹 Invalidate API cache so UI sees sleep mode exit
    await cacheService.clear(`user:${currentSchedule.userId}:schedules:*`);
    await cacheService.deleteUserData(currentSchedule.userId, `schedule:${scheduleId}`);

    return intervalMs;
  } catch (error) {
    console.error(`[Schedule ${scheduleId}] Error in handleIntervalSchedule:`, error);
    // 🛡️ CRITICAL: Never return null on error, return base configuration interval to keep schedule ALIVE
    const baseInterval = calculateIntervalMs(schedule.interval || { value: 60, unit: 'minutes' });
    return baseInterval;
  }
}

async function handleViewSchedule(viewScheduleId) {
  try {
    const viewSchedule = await prisma.viewSchedule.findUnique({
      where: { id: viewScheduleId }
    });

    if (!viewSchedule || viewSchedule.status !== 'active') {
      const j = (await scheduleQueue.getJobSchedulers()).find(s => s.id === `view-${viewScheduleId}`);
      if (j) await scheduleQueue.removeJobScheduler(j.key);
      return;
    }

    const interval = viewSchedule.interval || { value: 60, unit: 'minutes' };
    const intervalMs = calculateIntervalMs(interval);

    const jobId = `view-${viewScheduleId}`;
    const schedulers = await scheduleQueue.getJobSchedulers();
    const existingJob = schedulers.find(j => j.id === jobId);
    if (existingJob) await scheduleQueue.removeJobScheduler(existingJob.key);

    await scheduleQueue.add('view-processing', { viewScheduleId }, {
      repeat: { every: intervalMs },
      jobId,
      removeOnComplete: true,
      removeOnFail: true
    });

  } catch (error) {
    console.error(`[View Schedule ${viewScheduleId}] Error handling view schedule:`, error);
    throw error;
  }
}

async function setupViewScheduleJob(viewScheduleId) {
  await handleViewSchedule(viewScheduleId);
}

async function deleteViewSchedule(viewScheduleId) {
  const schedulers = await scheduleQueue.getJobSchedulers();
  const j = schedulers.find(s => s.id === `view-${viewScheduleId}`);
  if (j) await scheduleQueue.removeJobScheduler(j.key);
}

async function fetchNextComment(scheduleId) {
  const now = new Date();
  const schedule = await prisma.schedule.findUnique({
    where: { id: scheduleId },
    include: {
      principalAccounts: true,
      secondaryAccounts: true
    }
  });

  const where = {
    status: 'scheduled',
    scheduledFor: { lte: now },
    scheduleId: scheduleId,
  };

  // 🔥 Filter out last used account
  if (schedule?.lastUsedAccountId) {
    where.youtubeAccountId = { not: schedule.lastUsedAccountId };
  }

  const comment = await prisma.comment.findFirst({
    where,
    include: {
      youtubeAccount: {
        include: { proxy: true }
      }
    }
  });

  return comment;
}

/**
 * Initialize Workers at top level
 */
scheduleWorker = new Worker('schedule-processing', async (job) => {
  console.log(`Processing schedule job ${job.id} with data:`, job.data);

  try {
    if (job.name === 'schedule-processing') {
      const { scheduleId } = job.data;
      if (!scheduleId) {
        console.error(`❌ Missing scheduleId in job:`, job.id, job.data);
        return;
      }
      return await optimizedProcessSchedule(scheduleId);
    } else if (job.name === 'view-processing') {
      const { viewScheduleId } = job.data;
      if (!viewScheduleId) {
        console.error(`❌ Missing viewScheduleId in job:`, job.id, job.data);
        return;
      }
      return await optimizedProcessViewSchedule(viewScheduleId);
    }
  } catch (error) {
    console.error(`Error processing job ${job.id}:`, error);
    throw error;
  }
}, QUEUE_CONFIG);

async function optimizedProcessViewSchedule(viewScheduleId) {
  try {
    const viewSchedule = await prisma.viewSchedule.findUnique({
      where: { id: viewScheduleId }
    });

    if (!viewSchedule || viewSchedule.status !== 'active') return { success: false, message: 'Schedule inactive' };

    const targetVideos = viewSchedule.targetVideos || [];
    if (targetVideos.length === 0) return { success: false, message: 'No target videos' };

    const numVideos = targetVideos.length;
    // ✅ Determine spread: Use calculateIntervalMs helper
    const totalInterval = calculateIntervalMs(viewSchedule.interval || { value: 60, unit: 'minutes' });
    const staggerDelay = numVideos > 1 ? totalInterval / numVideos : 0;

    console.log(`[View Schedule ${viewScheduleId}] 👁️ Spreading ${numVideos} views over ${totalInterval / 1000}s (${staggerDelay / 1000}s stagger)`);

    // Add each video to the viewQueue with staggered delay
    for (let i = 0; i < numVideos; i++) {
      const video = targetVideos[i];
      const videoId = typeof video === 'string' ? video : video.videoId;
      if (!videoId) continue;

      const dispatchDelay = i * staggerDelay;

      await viewQueue.add('simulate-view', {
        videoId,
        viewScheduleId,
        userId: viewSchedule.userId
      }, {
        delay: Math.round(dispatchDelay),
        removeOnComplete: true,
        removeOnFail: true
      });

      console.log(`[View Schedule ${viewScheduleId}] Queued video ${videoId} with ${dispatchDelay / 1000}s stagger delay`);
    }

    await prisma.viewSchedule.update({
      where: { id: viewScheduleId },
      data: { lastProcessedAt: new Date(), totalViews: { increment: targetVideos.length } }
    });

    return { success: true, viewsQueued: targetVideos.length };

  } catch (error) {
    console.error(`[View Schedule ${viewScheduleId}] Error in optimizedProcessViewSchedule:`, error);
    await prisma.viewSchedule.update({
      where: { id: viewScheduleId },
      data: { errorCount: { increment: 1 } }
    });
  }
}


// Comment worker
commentWorker = new Worker('post-comment', async (job) => {
  const { commentId, scheduleId } = job.data;
  console.log("🔄 Processing comment job:", commentId);

  try {
    const comment = await getCommentWithRetry(commentId);
    if (!comment) throw new Error(`Comment ${commentId} not found`);

    if (!comment.youtubeAccount || comment.youtubeAccount.status !== 'active') {
      await prisma.comment.update({
        where: { id: commentId },
        data: { status: 'failed', errorMessage: 'Invalid or inactive account' }
      });

      await prisma.schedule.update({
        where: { id: String(scheduleId) },
        data: { failedComments: { increment: 1 } }
      });

      return { success: false, message: 'Invalid or inactive account' };
    }

    // Simplified commentWorker: no legacy view simulation logic here
    const result = await youtubeService.postComment(commentId);

    const quotaExceeded = result.error?.includes("quota") || result.error?.includes("dailyLimitExceeded");
    const proxyError = result.message?.includes("Proxy failed or invalid") || result.error?.includes("Proxy") || result.message === "Proxy failed or invalid";
    const duplication = result.message?.includes("No available accounts. Comment delayed for retry.") || result.error?.includes("Comment delayed for retry");

    const updateProgress = result.success
      ? { postedComments: { increment: 1 } }
      : { failedComments: { increment: 1 } };

    // ✅ Prisma progress update
    await prisma.schedule.update({
      where: { id: scheduleId },
      data: updateProgress
    });

    // 🔄 REFRESH Redis cache with updated schedule progress
    const updatedSchedule = await prisma.schedule.findUnique({
      where: { id: scheduleId },
      include: { selectedAccounts: true }
    });

    const comments = await prisma.comment.findMany({
      where: { scheduleId: scheduleId },
      orderBy: { createdAt: 'desc' },
      take: 100
    });

    const detailData = {
      schedule: updatedSchedule,
      comments
    };

    // 🧹 Clear list cache and update detail cache with 10s TTL
    await cacheService.clear(`user:${updatedSchedule.userId}:schedules:*`);
    await cacheService.setUserData(updatedSchedule.userId, `schedule:${scheduleId}`, detailData, 10);

    // 🎯 Update YouTube account stats
    let updateFields = {
      lastMessage: result.success ? 'Comment posted successfully' : result.message || result.error || 'Unknown error',
    };

    if (result.success) {
      updateFields.status = 'active';
      updateFields.proxyErrorCount = 0;

      // Triggered after each comment for legacy reasons, but now handled in optimizedProcessSchedule
      // to avoid interval creep.

    } else if (proxyError) {
      const currentAccount = await prisma.youTubeAccount.findUnique({
        where: { id: comment.accountId }
      });
      const newCount = (currentAccount?.proxyErrorCount || 0) + 1;
      const threshold = currentAccount?.proxyErrorThreshold || 20; // Increased default to 20

      updateFields.proxyErrorCount = newCount;
      updateFields.status = newCount >= threshold ? 'inactive' : 'active';

      console.log(`[ProxyError] Account ${comment.accountId} count: ${newCount}/${threshold}. Rotating proxy...`);

      // Rotate proxy to give account a chance with a different one
      try {
        await assignRandomProxy(comment.userId, comment.accountId);
      } catch (proxyError) {
        console.warn(`[ProxyRotation] Failed to rotate proxy for account ${comment.accountId}: ${proxyError.message}`);
      }

    } else if (duplication) {
      const currentAccount = await prisma.youTubeAccount.findUnique({
        where: { id: comment.accountId }
      });
      const newCount = (currentAccount?.duplicationCount || 0) + 1;
      updateFields.duplicationCount = newCount;
      updateFields.status = 'active';

    } else {
      updateFields.proxyErrorCount = 0;
      updateFields.status = 'inactive';
    }

    // ✅ Save account state
    if (comment.accountId) {
      await prisma.youTubeAccount.update({
        where: { id: comment.accountId },
        data: updateFields
      });
    }

    if (quotaExceeded) {
      // Use apiProfileId instead of googleProfileId
      await handleQuotaExceeded(comment.youtubeAccount.apiProfileId);
    }

    if (result.success) {
      await updateProfileQuota(comment.accountId);
    }

    await updateCommentStatus(commentId, result);

    return result;

  } catch (error) {
    console.error(`❌ Error processing comment ${commentId}:`, error);
    await handleCommentError(commentId, error);
    throw error;
  }
}, {
  connection: REDIS_CONFIG,
  concurrency: 100,
  lockDuration: 60000,
  limiter: { max: 100, duration: 1000 }
});

// View worker
viewWorker = new Worker('simulate-view', async (job) => {
  const { videoId, viewScheduleId, userId } = job.data;
  console.log(`👁️ Processing view job for video ${videoId} (Schedule: ${viewScheduleId})`);

  try {
    const viewSchedule = await prisma.viewSchedule.findUnique({
      where: { id: viewScheduleId }
    });

    if (!viewSchedule || viewSchedule.status !== 'active') {
      console.log(`[View Schedule ${viewScheduleId}] Schedule is inactive or not found, skipping.`);
      return { success: false, message: 'Schedule inactive' };
    }

    // Roll probability
    if (Math.random() * 100 > viewSchedule.probability) {
      console.log(`[View Schedule ${viewScheduleId}] Skipping view based on probability`);
      return { success: true, message: 'Skipped by probability' };
    }

    // Get user proxies or random proxy
    const userProxies = await prisma.proxy.findMany({
      where: { userId: userId, status: 'active' }
    });

    const proxy = userProxies.length > 0
      ? userProxies[Math.floor(Math.random() * userProxies.length)]
      : null;

    const viewResult = await viewerService.simulateView(videoId, proxy, {
      minWatchTime: viewSchedule.minWatchTime,
      maxWatchTime: viewSchedule.maxWatchTime,
      headless: 'new',
      autoLike: viewSchedule.autoLike
    });

    if (viewResult.success) {
      await prisma.viewSchedule.update({
        where: { id: viewScheduleId },
        data: { completedViews: { increment: 1 } }
      });

      // Handle Auto-Like via API for better reliability (browser liking requires login)
      if (viewSchedule.autoLike) {
        try {
          // Get a random active account for this user to perform the like
          const activeAccounts = await prisma.youTubeAccount.findMany({
            where: { userId: userId, status: 'active' }
          });

          if (activeAccounts.length > 0) {
            const randomAccount = activeAccounts[Math.floor(Math.random() * activeAccounts.length)];
            console.log(`[ViewWorker] Triggering API like for video ${videoId} using account ${randomAccount.email} (Proxy Alignment)`);
            await youtubeService.likeVideo(videoId, randomAccount.id, proxy);
          } else {
            console.warn(`[ViewWorker] No active accounts found for user ${userId} to perform auto-like`);
          }
        } catch (likeError) {
          console.error(`[ViewWorker] API Like failed for video ${videoId}:`, likeError.message);
        }
      }
    } else {
      await prisma.viewSchedule.update({
        where: { id: viewScheduleId },
        data: { failedViews: { increment: 1 } }
      });
    }

    return viewResult;
  } catch (error) {
    console.error(`❌ Error in viewWorker for schedule ${viewScheduleId}:`, error);
    await prisma.viewSchedule.update({
      where: { id: viewScheduleId },
      data: { failedViews: { increment: 1 } }
    });
    throw error;
  }
}, {
  connection: REDIS_CONFIG,
  concurrency: 5, // Limit concurrent browsers
});

viewWorker.on('completed', (job) => {
  console.log(`View job ${job.id} completed`);
});

viewWorker.on('failed', (job, err) => {
  console.error(`View job ${job.id} failed:`, err);
});

// Worker event handlers
scheduleWorker.on('completed', (job, result) => {
  // Filter out repeat job completion logs to reduce noise
  if (!job.id?.includes('repeat:')) {
    console.log(`Schedule job ${job.id} completed`, result);
  }
});

scheduleWorker.on('failed', (job, error) => {
  console.error(`Schedule job ${job.id} failed:`, error);
});

commentWorker.on('completed', (job, result) => {
  console.log(`✅ Comment job ${job.id} completed`, result);
});

commentWorker.on('active', (job) => {
  console.log(`▶️  Comment job ${job.id} started processing`);
});

commentWorker.on('waiting', (jobId) => {
  console.log(`⏸️  Comment job ${jobId} moved to waiting`);
});

commentWorker.on('delayed', (jobId) => {
  console.log(`⏱️  Comment job ${jobId} is delayed`);
});

commentWorker.on('failed', (job, error) => {
  console.error(`Comment job ${job.id} failed:`, error);
});

// QueueEvents listeners for tracking delayed job lifecycle
commentQueueEvents.on('delayed', ({ jobId, delay }) => {
  console.log(`📅 Comment job ${jobId} delayed by ${delay}ms`);
});

commentQueueEvents.on('waiting', ({ jobId }) => {
  console.log(`⏰ Comment job ${jobId} is now waiting (delay expired)`);
});

commentQueueEvents.on('active', ({ jobId }) => {
  console.log(`🚀 Comment job ${jobId} is now active`);
});



/**
 * Ensure a next run is scheduled for an interval schedule if none exists
 */
async function ensureNextRun(scheduleId, intervalMs) {
  try {
    const jobs = await scheduleQueue.getJobs(['delayed', 'waiting', 'active']);
    const jobIdPrefix = `interval-${scheduleId}-`;
    const futureJobExists = jobs.some(j => j.id && j.id.startsWith(jobIdPrefix));

    if (!futureJobExists) {
      console.log(`[Schedule ${scheduleId}] 🛡️ No future job found. Scheduling next run in ${intervalMs / 1000}s`);
      const nextRunAt = new Date(Date.now() + intervalMs);

      await Promise.all([
        scheduleQueue.add('schedule-processing', { scheduleId }, {
          delay: intervalMs,
          jobId: `${jobIdPrefix}${Date.now() + intervalMs}`,
          removeOnComplete: true,
          removeOnFail: true
        }),
        prisma.schedule.update({
          where: { id: scheduleId },
          data: { nextRunAt }
        })
      ]);
    }
  } catch (error) {
    console.error(`[Schedule ${scheduleId}] Error in ensureNextRun:`, error);
  }
}

/**
 * Optimized schedule processing
 */
async function optimizedProcessSchedule(scheduleId) {
  const lockKey = `schedule_processing:${scheduleId}`;
  const lockValue = `${Date.now()}`;

  // Ensure Redis connection
  if (!redisClient.isOpen) await redisClient.connect();

  // 1. Fetch BASIC schedule configuration FIRST to avoid hardcoding "1 minute"
  const basicSchedule = await prisma.schedule.findUnique({
    where: { id: scheduleId },
    select: { interval: true, scheduleType: true }
  });

  if (!basicSchedule) {
    console.log(`[Schedule ${scheduleId}] Not found during pre-check`);
    return { success: false, message: 'Schedule not found' };
  }

  // Calculate base interval (defaulting to configuration-based calculation)
  const baseIntervalConfig = basicSchedule.interval || { value: 60, unit: 'minutes' };
  const baseIntervalMs = calculateIntervalMs(baseIntervalConfig);

  // Dynamic TTL: 90% of interval to provide a safety buffer, ensuring the cooldown 
  // expires shortly BEFORE the next job is scheduled to run. This prevents 
  // race conditions where BullMQ triggers the next job slightly early.
  // Minimum 10s as race safety, maximum 1 hour.
  const dynamicTTL = Math.min(3600, Math.max(10, Math.floor((baseIntervalMs / 1000) * 0.9)));


  // 🔒 Lock with dynamic TTL to prevent overlapping executions
  const lockAcquired = await redisClient.set(lockKey, lockValue, {
    EX: dynamicTTL,
    NX: true
  });

  if (!lockAcquired) {
    console.log(`[Schedule ${scheduleId}] 🔒 Overlap detected, skipping.`);
    // We don't ensureNextRun here because the process that holds the lock is responsible for it
    return { success: false, message: 'Lock overlap' };
  }


  console.log(`[Schedule ${scheduleId}] 🔓 Lock acquired for ${dynamicTTL}s, starting processing`);
  let schedule = null;
  try {
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
    schedule = await prisma.schedule.findUnique({
      where: { id: scheduleId },
      include: {
        selectedAccounts: true,
        user: true,
        principalAccounts: true,
        secondaryAccounts: true
      }
    });

    if (!schedule) {
      console.log(`[Schedule ${scheduleId}] Not found in database`);
      await redisClient.del(`schedule:${scheduleId}`);
      return { success: false, message: 'Schedule not found in DB' };
    }

    // Check for active delay period
    if (schedule.sleepDelayMinutes > 0 && schedule.sleepDelayStartTime) {
      const delayStartTime = new Date(schedule.sleepDelayStartTime);
      const delayEndTime = new Date(delayStartTime.getTime() + schedule.sleepDelayMinutes * 60 * 1000);

      if (new Date() < delayEndTime) {
        console.log(`[Schedule ${scheduleId}] Skipping processing - active delay period (${schedule.sleepDelayMinutes} minutes) until ${delayEndTime}`);
        return { success: false, message: 'Active sleep delay', sleeping: true };
      } else {
        // Sleep period ended - restore normal operation
        console.log(`[Schedule ${scheduleId}] Sleep ended - restoring normal operation`);

        // Clear sleep delay fields
        await prisma.schedule.update({
          where: { id: scheduleId },
          data: {
            sleepDelayMinutes: 0,
            sleepDelayStartTime: null
          }
        });

        // Set new random limitComments if min and max exist
        const minLimit = schedule.limitComments?.min;
        const maxLimit = schedule.limitComments?.max;

        if (schedule.limitComments?.isRandom && typeof minLimit === 'number' && typeof maxLimit === 'number') {
          const randomLimit = Math.round(Math.random() * (maxLimit - minLimit) + minLimit);

          await prisma.schedule.update({
            where: { id: scheduleId },
            data: {
              limitComments: {
                ...schedule.limitComments,
                value: randomLimit
              }
            }
          });

          // 🧹 Invalidate cache for new random limit
          await cacheService.clear(`user:${schedule.userId}:schedules:*`);
          await cacheService.deleteUserData(schedule.userId, `schedule:${scheduleId}`);

          console.log(`[Schedule ${scheduleId}] New random limitComments set: ${randomLimit}`);
        }
      }
    }

    // Update Redis cache with fresh data
    if (!cachedSchedule || cachedSchedule.status !== schedule.status) {
      await redisClient.set(`schedule:${scheduleId}`, JSON.stringify({
        id: schedule.id,
        status: schedule.status,
        type: schedule.scheduleType,
        user: schedule.userId
      }), {
        EX: schedule.status === 'error' ? 3600 : 86400
      });
    }

    // Validate schedule state
    if (schedule.status !== 'active') {
      console.log(`[Schedule ${scheduleId}] Status is ${schedule.status} in database`);
      return { success: false, message: `Inactive status: ${schedule.status}` };
    }

    // Check for expiration
    const now = new Date();
    if (schedule.endDate && new Date(schedule.endDate) < now) {
      console.log(`[Schedule ${scheduleId}] Schedule has ended`);
      await Promise.all([
        prisma.schedule.update({ where: { id: scheduleId }, data: { status: 'completed' } }),
        redisClient.set(`schedule:${scheduleId}`, JSON.stringify({
          id: schedule.id,
          status: 'completed',
          type: schedule.scheduleType,
          user: schedule.userId
        }), { EX: 86400 }),
        cacheService.clear(`user:${schedule.userId}:schedules:*`),
        cacheService.deleteUserData(schedule.userId, `schedule:${scheduleId}`),
        activeJobs.has(scheduleId) ? activeJobs.get(scheduleId).stop() : Promise.resolve()
      ]);
      activeJobs.delete(scheduleId);
      return { success: true, message: 'Schedule ended' };
    }

    // Validate targets and templates
    const targetVideos = [...schedule.targetVideos];
    if ((targetVideos.length === 0 && schedule.targetChannels.length === 0) ||
      (schedule.commentTemplates.length === 0 && !schedule.useAI)) {
      console.log(`[Schedule ${scheduleId}] No valid targets or templates`);
      await prisma.schedule.update({
        where: { id: scheduleId },
        data: {
          status: 'requires_review',
          errorMessage: 'No valid targets or templates'
        }
      });
      await cacheService.clear(`user:${schedule.userId}:schedules:*`);
      await cacheService.deleteUserData(schedule.userId, `schedule:${scheduleId}`);
      return { success: false, message: 'Missing targets or templates' };
    }

    // Update last processed time and reset errors
    await prisma.schedule.update({
      where: { id: scheduleId },
      data: {
        lastProcessedAt: new Date(),
        nextRunAt: null, // Clear next run while processing
        errorMessage: null,
        status: 'active',
        // Reset error count
        errorCount: 0
      }
    });

    // ✅ Handle interval randomization and sleep mode check at the start of batch
    let globalIntervalMs = null;
    if (schedule.scheduleType === 'interval') {
      console.log(`[Schedule ${scheduleId}] Handling interval processing at start of batch`);
      globalIntervalMs = await handleIntervalSchedule(schedule, scheduleId);

      // 🛡️ REFRESH schedule object to detect if sleep mode was just triggered
      if (globalIntervalMs) {
        schedule = await prisma.schedule.findUnique({
          where: { id: scheduleId },
          include: {
            selectedAccounts: true,
            user: true,
            principalAccounts: true,
            secondaryAccounts: true
          }
        });
      }
    }
    const startTime = Date.now();
    // ✅ Process schedule accounts (Safeguarded)
    try {
      await optimizedAccountProcessing(schedule, targetVideos, globalIntervalMs);
    } catch (processError) {
      console.error(`[Schedule ${scheduleId}] ❌ Error in account processing:`, processError);
      // We do NOT stop the schedule for processing errors (timeouts, proxy issues, etc.)
      // We just log it and verify if we need to incremement error count
      await prisma.schedule.update({
        where: { id: scheduleId },
        data: { errorCount: { increment: 1 } }
      });
    }


    // ✅ RECURSIVE DELAY: Queue exactly ONE future job after this one is done
    if (schedule.scheduleType === 'interval' && globalIntervalMs) {
      const suiteTime = Date.now() - startTime; // Measure how long processing took
      const nextDelayMs = Math.max(1000, globalIntervalMs - suiteTime); // Subtract elution time, min 1s safety

      const waitTimeS = Math.round(nextDelayMs / 1000);
      const nextRunAt = new Date(Date.now() + nextDelayMs);
      console.log(`[Schedule ${scheduleId}] ⏳ Batch took ${Math.round(suiteTime / 1000)}s. Queuing next execution in ${waitTimeS}s (at ${nextRunAt.toISOString()})`);

      await Promise.all([
        scheduleQueue.add('schedule-processing', { scheduleId }, {
          delay: nextDelayMs,
          jobId: `interval-${scheduleId}-${Date.now() + nextDelayMs}`,
          removeOnComplete: true,
          removeOnFail: true
        }),
        prisma.schedule.update({
          where: { id: scheduleId },
          data: { nextRunAt }
        })
      ]);
    }

    return { success: true, message: 'Batch processed successfully' };

  } catch (error) {
    console.error(`[Schedule ${scheduleId}] Error processing schedule:`, error);

    try {
      const currentStatus = await prisma.schedule.findUnique({
        where: { id: scheduleId },
        select: { status: true, errorCount: true }
      });

      if (currentStatus?.status === 'active') {
        const errorCount = (currentStatus.errorCount || 0) + 1;
        // RELAXED THRESHOLD: Only stop schedule after 50 consecutive failures to allow for transient issues.
        // Otherwise, keep 'active' so it retries.
        const newStatus = errorCount >= 50 ? 'requires_review' : 'active';

        await prisma.schedule.update({
          where: { id: scheduleId },
          data: {
            status: newStatus,
            errorMessage: error.message?.substring(0, 500) || 'Unknown error',
            errorCount: errorCount
          }
        });

        if (schedule) {
          await cacheService.clear(`user:${schedule.userId}:schedules:*`);
          await cacheService.deleteUserData(schedule.userId, `schedule:${scheduleId}`);
        }

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

    return { success: false, error: error.message };

  } finally {
    // 🧹 Always release the lock if we still own it
    const currentValue = await redisClient.get(lockKey);
    if (currentValue === lockValue) {
      await redisClient.del(lockKey);
    }
  }
}

/**
 * Process accounts for a schedule
 */
async function optimizedAccountProcessing(schedule, targetVideos, globalIntervalMs) {
  const accounts = getAccountsByStrategy(schedule);

  if (!accounts || accounts.length === 0) {
    console.log(`❌ Schedule ${schedule.id} has no active accounts`);
    await prisma.schedule.update({
      where: { id: schedule.id },
      data: { status: 'paused', errorMessage: 'No active accounts available' }
    });
    return false;
  }

  await Promise.all([
    processCommentsForAccounts(accounts, targetVideos, schedule, globalIntervalMs)
  ]);
}





/**
 * Select accounts based on strategy
 */
function getAccountsByStrategy(schedule) {
  const activeAccounts = schedule.selectedAccounts.filter(a => a.status === 'active');
  if (activeAccounts.length === 0) return [];

  switch (schedule.accountSelection) {
    case 'specific':
      return activeAccounts;
    case 'random':
    case 'round-robin':
      // Return a single selected account in an array
      const selected = selectWeightedAccount(activeAccounts, schedule.id, schedule.lastUsedAccountId);
      return selected ? [selected] : [];
    default:
      return [];
  }
}

/**
 * Get YouTube video title with retry logic
 * @param {string} videoId - The YouTube video ID
 * @returns {Promise<string>} - The video title
 */
async function getYouTubeVideoTitle(videoId) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    throw new Error('YOUTUBE_API_KEY is missing');
  }

  const url = `https://www.googleapis.com/youtube/v3/videos`;

  const MAX_RETRIES = 3;
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    try {
      const response = await axios.get(url, {
        params: {
          part: 'snippet',
          id: videoId,
          key: apiKey
        },
        timeout: 10000 // 10s timeout
      });

      if (response.status !== 200) {
        throw new Error(`YouTube API returned ${response.status}`);
      }

      const items = response.data.items;
      if (items && items.length > 0) {
        return items[0].snippet.title;
      } else {
        console.warn(`[getYouTubeVideoTitle] No video found for ID: ${videoId}`);
        throw new Error('No video found');
      }
    } catch (error) {
      attempt++;
      console.error(`[getYouTubeVideoTitle] Attempt ${attempt} failed:`, error.message);

      if (attempt >= MAX_RETRIES) {
        console.error(`[getYouTubeVideoTitle] Final failure after ${MAX_RETRIES} attempts.`);
        throw error;
      }

      // Wait before retrying (exponential backoff: 1s, 2s, 4s...)
      await new Promise(r => setTimeout(r, attempt * 1000));
    }
  }
}
/**
/**
 * Generate one YouTube-style comment from a video title using Groq
 * @param {string} title - The title of the YouTube video
 * @returns {Promise<string>} - The generated comment
 */
async function generateCommentFromTitle(title) {
  if (!title) return "Awesome video! 🔥";

  const prompt = `Write one short, enthusiastic YouTube-style comment for a video titled "${title}". Keep it friendly and engaging. Output only the comment text.`;

  try {
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 50,
      temperature: 0.9,
    });

    return response.choices[0].message.content.trim();
  } catch (error) {
    console.error("❌ Error generating comment with Groq:", error);
    return "🔥 Loved this video!";
  }
}



async function processCommentsForAccounts(accounts, targetVideos, schedule, globalIntervalMs) {
  // Use configuration strictly: fallback to 1.5s only if betweenAccounts is not set (0)
  const betweenAccountsMs = (Number(schedule.betweenAccounts) || 1.5) * 1000;
  const numAccounts = accounts.length;

  if (schedule.sleepDelayMinutes > 0) {
    console.log(`[Schedule ${schedule.id}] Skipping - sleep delay active (${schedule.sleepDelayMinutes} mins)`);
    return;
  }

  // Clean up expired keys before processing
  // await cleanupExpiredKeys(schedule.id);

  // ✅ Determine spread: Strictly follow betweenAccountsMs as requested
  const staggerDelay = betweenAccountsMs;
  const totalInterval = globalIntervalMs || calculateIntervalMs(schedule.interval || { value: 60, unit: 'minutes' });

  console.log(`[Schedule ${schedule.id}] Dispatching ${numAccounts} comments with strict ${staggerDelay / 1000}s stagger (Interval: ${totalInterval / 1000}s)`);

  let successfulCount = 0;
  let attemptCount = 0;
  const maxAttempts = accounts.length * 10;
  const usedCombinations = new Set();
  let currentLastUsedId = schedule.lastUsedAccountId;

  // Track processing startTime for safety
  const startTime = Date.now();
  const MAX_DISPATCH_TIME = 30000; // 30 seconds max to create all records

  while (successfulCount < numAccounts && attemptCount < maxAttempts) {
    attemptCount++;

    if (Date.now() - startTime > MAX_DISPATCH_TIME) {
      console.warn(`[Schedule ${schedule.id}] Dispatch timeout reached. Created ${successfulCount}/${numAccounts} jobs.`);
      break;
    }

    const video = targetVideos[Math.floor(Math.random() * targetVideos.length)];
    const videoId = video.videoId;

    // Check per-video last used account to avoid consecutive posts on SAME video
    const videoLastAccountKey = `schedule:${schedule.id}:video:${videoId}:lastAccount`;
    const lastAccountForVideo = await redisClient.get(videoLastAccountKey);

    // weighed selection with exclusions
    let account;

    // First try: Exclude BOTH global last used AND video-specific last used
    let excludedIds = [String(currentLastUsedId)];
    if (lastAccountForVideo) excludedIds.push(String(lastAccountForVideo));

    // Filter accounts excluding all restricted ones
    let availableAccounts = accounts.filter(a => !excludedIds.includes(String(a.id)));

    if (availableAccounts.length > 0) {
      account = selectWeightedAccount(availableAccounts, schedule.id, null); // null because we already filtered
    } else {
      console.log(`[Schedule ${schedule.id}] ⚠️ Strict rotation constraint (Global != ${currentLastUsedId} AND Video != ${lastAccountForVideo}) could not be met for video ${videoId}.`);

      // Fallback Strategies:
      // Priority 1: Avoid consecutive posts on THIS VIDEO (Visual repetition is worse)
      // This means we might allow repeating the Global Last Used account if necessary.
      if (lastAccountForVideo) {
        let fallbackAccounts = accounts.filter(a => String(a.id) !== String(lastAccountForVideo));
        if (fallbackAccounts.length > 0) {
          account = selectWeightedAccount(fallbackAccounts, schedule.id, currentLastUsedId);
          console.log(`[Schedule ${schedule.id}] ℹ️ Fallback: Prioritizing avoiding Video-Consecutive. Allowed Global-Consecutive if needed.`);
        }
      }

      // Priority 2: If we STILL have no account (e.g. only 1 account exists and it's the video-last),
      // we have no choice but to use it or skip. Here we use it.
      if (!account) {
        account = selectWeightedAccount(accounts, schedule.id, currentLastUsedId); // Standard weighted selection
        console.log(`[Schedule ${schedule.id}] ⚠️ Fallback: No choice but to use available account.`);
      }
    }

    if (!account || !videoId) continue;

    const combinationKey = `${account.id}:${videoId}`;
    if (usedCombinations.has(combinationKey)) continue;

    // Check Redis-based restrictions
    const cooldownKey = `schedule:${schedule.id}:account:${account.id}:video:${videoId}:cooldown`;
    const isInCooldown = await redisClient.get(cooldownKey);
    if (isInCooldown) {
      const ttl = await redisClient.ttl(cooldownKey);
      if (ttl > 10) continue; // Skip if cooldown is still significant
    }

    try {
      let baseContent;
      if (schedule.useAI) {
        try {
          console.log(`[Schedule ${schedule.id}] Using AI to generate comment for video ${videoId}`);

          const title = await getYouTubeVideoTitle(videoId);
          baseContent = await generateCommentFromTitle(title);

          // Refresh schedule to avoid stale commentTemplates check
          const freshSchedule = await prisma.schedule.findUnique({
            where: { id: schedule.id },
            select: { commentTemplates: true }
          });

          const templates = freshSchedule?.commentTemplates || schedule.commentTemplates;

          if (!templates.includes(baseContent)) {
            console.log(`[Schedule ${schedule.id}] Adding new AI comment to templates: "${baseContent}"`);
            await prisma.schedule.update({
              where: { id: schedule.id },
              data: { commentTemplates: { push: baseContent } }
            });
            // Invalidate cache to sync with UI without re-triggering job setup
            if (typeof updateScheduleCache === 'function') {
              await updateScheduleCache(schedule.id, true);
            }
          }
        } catch (error) {
          console.error(`❌ [Schedule ${schedule.id}] AI Generation failed:`, error.message);
          baseContent = getRandomTemplate(schedule.commentTemplates) || "Great video!";
        }
      } else {
        baseContent = getRandomTemplate(schedule.commentTemplates) || "Awesome content!";
      }

      const createdComment = await prisma.comment.create({
        data: {
          content: baseContent,
          status: 'pending',
          videoId,
          userId: schedule.userId,
          scheduleId: schedule.id,
          accountId: account.id
        }
      });

      if (!createdComment) continue;

      // Update counters
      await Promise.all([
        prisma.youTubeAccount.update({ where: { id: account.id }, data: { lastUsed: new Date() } }),
        prisma.schedule.update({
          where: { id: schedule.id },
          data: {
            totalComments: { increment: 1 },
            lastUsedAccountId: account.id
          }
        }),
        redisClient.set(cooldownKey, '1', { EX: Math.ceil(staggerDelay / 1000) }),
        // Set last account for THIS video (persist for 24h or reasonable time)
        redisClient.set(videoLastAccountKey, account.id, { EX: 86400 })
      ]);

      // ✅ Queue THE comment with BullMQ NON-BLOCKING delay
      // Calculate delay based on strict schedule from startTime to avoid drift
      const targetTime = startTime + (successfulCount * staggerDelay);
      const now = Date.now();
      const dispatchDelay = Math.max(0, targetTime - now);

      console.log(`[Schedule ${schedule.id}] Scheduling comment #${successfulCount + 1} for T+${Math.round((targetTime - startTime) / 1000)}s (Delaying ${Math.round(dispatchDelay)}ms from now)`);

      await commentQueue.add('post-comment', {
        commentId: createdComment.id,
        scheduleId: schedule.id
      }, {
        delay: Math.round(dispatchDelay),
        jobId: `post-comment-${createdComment.id}`,
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86400, count: 1000 }
      });

      console.log(`[Schedule ${schedule.id}] Queued Comment #${successfulCount + 1} with ${dispatchDelay / 1000}s delay`);

      successfulCount++;
      currentLastUsedId = account.id;
      usedCombinations.add(combinationKey);

    } catch (error) {
      console.error(`[Schedule ${schedule.id}] Error creating comment job:`, error);
    }
  }
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
    const comment = await prisma.comment.findUnique({
      where: { id: commentId },
      include: {
        youtubeAccount: {
          include: { proxy: true }
        },
        schedule: true
      }
    });
    if (comment) return comment;
    if (attempt < maxAttempts) await new Promise(r => setTimeout(r, attempt * 500));
  }
  return null;
}

/**
 * Update comment status after processing
 */
async function updateCommentStatus(commentId, result) {
  try {
    const updateData = {
      status: result.success ? 'posted' : 'failed',
      postedAt: result.success ? new Date() : undefined,
      youtubeCommentId: result.id,
      errorMessage: result.error?.substring(0, 500),
      retryCount: result.success ? undefined : { increment: 1 }
    };
    await prisma.comment.update({
      where: { id: commentId },
      data: updateData
    });

    // Reset proxy error count on success
    if (result.success) {
      const comment = await prisma.comment.findUnique({
        where: { id: commentId },
        select: { accountId: true }
      });

      if (comment?.accountId) {
        await prisma.youTubeAccount.update({
          where: { id: comment.accountId },
          data: { proxyErrorCount: 0 }
        });
      }
    }
  } catch (error) {
    if (error.code === 'P2025') {
      console.warn(`[updateCommentStatus] Comment ${commentId} not found, skipping update.`);
    } else {
      throw error;
    }
  }
}

/**
 * Handle comment processing errors
 */
async function handleCommentError(commentId, error) {
  try {
    await prisma.comment.update({
      where: { id: commentId },
      data: {
        status: 'failed',
        errorMessage: error.message?.substring(0, 500)
      }
    });
  } catch (updateError) {
    if (updateError.code === 'P2025') {
      console.warn(`[handleCommentError] Comment ${commentId} not found, skipping error update.`);
    } else {
      console.error(`[handleCommentError] Failed to update comment ${commentId}:`, updateError.message);
    }
  }
}

/**
 * Handle quota exceeded scenario
 */
async function handleQuotaExceeded(profileId) {
  try {
    const updateResult = await prisma.apiProfile.updateMany({
      where: {
        id: profileId,
        status: { not: 'exceeded' }
      },
      data: {
        status: 'exceeded',
        exceededAt: new Date()
      }
    });

    if (updateResult.count === 0) {
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
    const account = await prisma.youTubeAccount.findUnique({
      where: { id: youtubeAccountId },
      select: { apiProfileId: true }
    });

    if (!account || !account.apiProfileId) {
      console.warn(`Account ${youtubeAccountId} or associated profile not found`);
      return;
    }

    const profile = await prisma.apiProfile.findUnique({
      where: { id: account.apiProfileId }
    });

    if (!profile) {
      console.warn(`Profile ${account.apiProfileId} not found`);
      return;
    }

    await prisma.apiProfile.update({
      where: { id: account.apiProfileId },
      data: { usedQuota: { increment: 50 } }
    });

    console.log(`Profile ${account.apiProfileId} usedQuota updated. New value: ${profile.usedQuota + 50}`);
  } catch (error) {
    console.error('Error updating profile quota:', error);
  }
}

/**
 * Calculate interval in milliseconds
 */
function calculateIntervalMs(interval) {
  const value = Number(interval?.value || 1);
  const unit = interval?.unit || 'minutes'; // Default to minutes if missing

  if (isNaN(value)) return 60 * 1000;

  switch (unit) {
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
        // Reactivate inactive YouTube accounts for a fresh start each day
        prisma.youTubeAccount.updateMany({
          where: { status: 'inactive' },
          data: { status: 'active', proxyErrorCount: 0 }
        }),
        // Reset API quotas
        prisma.apiProfile.updateMany({
          data: { usedQuota: 0, status: 'not exceeded', exceededAt: null }
        }),
        // Reactivate schedules that were stuck in error or quota exceeded, but NOT completed or paused
        prisma.schedule.updateMany({
          where: { status: { in: ['error', 'requires_review', 'paused'] } }, // We keep manually paused as paused? Or only error/review?
          // Let's stick to ONLY error and requires_review for auto-reset to respect user's manual "pause"
          where: { status: { in: ['error', 'requires_review'] } },
          data: { status: 'active', errorCount: 0 }
        })
      ]);

      console.log(
        `Quota reset complete at ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}: ` +
        `${updatedYT.count} YT accounts, ` +
        `${updatedAPI.count} API profiles, ` +
        `${updatedSchedules.count} schedules updated.`
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
        // Only reactivate if they were inactive (not manually disabled or something else)
        // Note: YouTubeAccount doesn't have many status types, so inactive is the safe bet
        prisma.youTubeAccount.updateMany({
          where: { status: 'inactive' },
          data: { status: 'active' }
        }),
        // CRITICAL: Only reactivate schedules that are in 'error' status.
        // DO NOT touch 'completed', 'paused', or 'requires_review' manually.
        prisma.schedule.updateMany({
          where: { status: 'error' },
          data: { status: 'active' }
        })
      ]);

      if (updatedYT.count > 0 || updatedSchedules.count > 0) {
        console.log(`[${new Date().toISOString()}] Frequent reset: ${updatedYT.count} YouTube accounts, ${updatedSchedules.count} schedules updated.`);
      }
    } catch (error) {
      console.error('Error during frequent status reset:', error);
    }
  }, { timezone: 'America/Los_Angeles' });
}
async function cleanupExpiredKeys(scheduleId) {
  try {
    if (!redisClient?.isOpen) await initRedis();

    // Restricted pattern to only catch transient tracking/cooldown keys
    // DO NOT catch the main 'schedule:id' config key which might not have a TTL
    const pattern = `schedule:${scheduleId}:*:cooldown`;
    const videoPattern = `schedule:${scheduleId}:video:*:lastAccount`;

    const keys = [...(await redisClient.keys(pattern)), ...(await redisClient.keys(videoPattern))];

    let cleanedCount = 0;
    for (const key of keys) {
      const ttl = await redisClient.ttl(key);
      if (ttl === -1) { // Key exists but has no expiration (safety check)
        // Only delete if it's strictly a cooldown or tracking key
        await redisClient.del(key);
        cleanedCount++;
        console.log(`Cleaned up key without TTL: ${key}`);
      }
    }

    if (cleanedCount > 0) {
      console.log(`[Schedule ${scheduleId}] Cleaned up ${cleanedCount} expired Redis keys`);
    }

    return cleanedCount;
  } catch (error) {
    console.error(`Error cleaning up Redis keys for schedule ${scheduleId}:`, error);
    return 0;
  }
}
async function cleanupAllExpiredKeys() {
  try {
    if (!redisClient?.isOpen) await initRedis();

    const patterns = [
      'schedule:*:sleep:check',
      'schedule:*:some_temp_key:*',
    ];

    let totalCleaned = 0;

    for (const pattern of patterns) {
      const keys = await redisClient.keys(pattern);

      for (const key of keys) {
        const ttl = await redisClient.ttl(key);
        if (ttl === -1 || ttl === -2) { // -1: no expiry, -2: key doesn't exist
          await redisClient.del(key);
          totalCleaned++;
          console.log(`Global cleanup: Removed key ${key}`);
        }
      }
    }

    if (totalCleaned > 0) {
      console.log(`Global Redis cleanup: Removed ${totalCleaned} keys`);
    }

    return totalCleaned;
  } catch (error) {
    console.error('Error during global Redis cleanup:', error);
    return 0;
  }
}
const recentAccountUsage = new Map(); // scheduleId -> Map(accountId -> count)

/**
 * Update recent usage tracking
 */
function updateRecentUsage(scheduleId, accountId) {
  if (!recentAccountUsage.has(scheduleId)) {
    recentAccountUsage.set(scheduleId, new Map());
  }

  const scheduleUsage = recentAccountUsage.get(scheduleId);
  const currentCount = scheduleUsage.get(accountId) || 0;
  scheduleUsage.set(accountId, currentCount + 1);

  // Clean up old entries periodically (keep only last 100 uses per schedule)
  if (scheduleUsage.size > 100) {
    const entries = Array.from(scheduleUsage.entries());
    entries.sort((a, b) => b[1] - a[1]); // Sort by usage count descending
    const toKeep = entries.slice(0, 50); // Keep top 50

    scheduleUsage.clear();
    toKeep.forEach(([accountId, count]) => {
      scheduleUsage.set(accountId, count);
    });
  }
}

/**
 * Select account using weighted random selection
 */
function selectWeightedAccount(accounts, scheduleId, lastUsedAccountId) {
  if (!accounts || accounts.length === 0) return null;

  // Rule #1: NEVER use the same account twice in a row (if we have more than 1 account available)
  const available = accounts.length > 1
    ? accounts.filter(a => String(a.id) !== String(lastUsedAccountId))
    : accounts;

  if (available.length === 1) return available[0];

  const recentUse = recentAccountUsage.get(scheduleId) || new Map();

  // Rule #2: Prefer accounts that were used least recently (Weighted Selection)
  const weights = available.map(account => {
    const recentUseCount = recentUse.get(account.id.toString()) || 0;
    // Boost accounts that haven't been used yet or were used much less
    return Math.max(1, 20 - recentUseCount);
  });

  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let random = Math.random() * totalWeight;

  for (let i = 0; i < available.length; i++) {
    random -= weights[i];
    if (random <= 0) return available[i];
  }

  return available[0];
}
/**
 * Setup immediate comments processor
 */
function setupImmediateCommentsProcessor() {
  const job = cron.schedule('* * * * *', async () => {
    try {
      const pendingComments = await prisma.comment.findMany({
        where: {
          status: 'pending',
          scheduledFor: null,
          schedule: {
            status: 'active',
            OR: [
              { sleepDelayMinutes: 0 },
              { sleepDelayStartTime: null }
            ]
          }
        },
        include: {
          youtubeAccount: true,
          schedule: true
        },
        take: 50
      });

      await Promise.all(pendingComments.map(async (comment) => {
        if (!comment.youtubeAccount || comment.youtubeAccount.status !== 'active') {
          await prisma.comment.update({
            where: { id: comment.id },
            data: { status: 'failed', errorMessage: 'Invalid or inactive account' }
          });
          return;
        }

        await commentQueue.add('post-immediate-comment', {
          commentId: comment.id
        }, {
          jobId: `post-immediate-comment-${comment.id}`,
          attempts: 1,
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
  scheduleQueue.on('error', (err) => {
    console.error('scheduleQueue error:', err);
  });

  scheduleQueue.on('ioredis:close', () => {
    console.log('scheduleQueue Redis connection closed');
  });

  commentQueue.on('error', (err) => {
    console.error('commentQueue error:', err);
  });

  scheduleQueue.on('waiting', (job) => {
    console.log(`Job ${job.id} is waiting`);
  });

  const commentQueueEvents = new QueueEvents('post-comment', {
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
  const job = cron.schedule('*/10 * * * *', async () => { // Run every 10 minutes
    try {
      console.log('Running enhanced maintenance tasks...');

      // 1. Global Redis cleanup
      // await cleanupAllExpiredKeys();

      // 2. Clean orphaned jobs
      const [commentJobs, scheduleJobs] = await Promise.all([
        commentQueue.getJobs(['failed', 'completed']),
        scheduleQueue.getJobs(['failed', 'completed'])
      ]);

      let cleanedJobs = 0;
      for (const job of [...commentJobs, ...scheduleJobs]) {
        try {
          if (!job || typeof job !== 'object') continue;

          // Double check failedReason access
          const reason = job.failedReason || '';
          const name = job.name || '';
          const id = job.id || '';

          if (reason.includes('Missing key for job') &&
            !name.includes('repeat:') &&
            !id.includes('repeat:')) {
            await job.remove();
            cleanedJobs++;
          }
        } catch (jobError) {
          console.error(`Error processing job in maintenance:`, jobError.message);
        }
      }

      if (cleanedJobs > 0) {
        console.log(`Cleaned up ${cleanedJobs} orphaned jobs`);
      }

      // 3. Check for schedules that need review
      const needsReviewSchedules = await prisma.schedule.findMany({
        where: {
          status: 'paused',
          lastFailureAt: { lt: new Date(Date.now() - 30 * 60 * 1000) } // Older than 30 minutes
        }
      });

      for (const schedule of needsReviewSchedules) {
        console.log(`Schedule ${schedule.id} has been in needs_review status for >30 minutes`);
        // You might want to send notifications or take other actions here
      }

      // 4. Clean up old usage tracking data
      const now = Date.now();
      const USAGE_CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour
      for (const [scheduleId, usageMap] of recentAccountUsage.entries()) {
        if (usageMap.size > 200) { // If too much data, clean it up
          const entries = Array.from(usageMap.entries());
          const toKeep = entries.slice(0, 100);
          usageMap.clear();
          toKeep.forEach(([accountId, count]) => {
            usageMap.set(accountId, Math.floor(count * 0.8)); // Reduce counts by 20%
          });
          console.log(`Cleaned up usage tracking for schedule ${scheduleId}`);
        }
      }

      // 5. Clean completed/failed jobs
      await Promise.all([
        commentQueue.clean(0, 'completed'),
        commentQueue.clean(0, 'failed'),
        scheduleQueue.clean(0, 'completed'),
        scheduleQueue.clean(0, 'failed')
      ]);

      console.log('Enhanced maintenance tasks completed');
    } catch (error) {
      console.error('Enhanced maintenance job failed:', error);
    }
  });

  activeJobs.set('enhanced-maintenance', job);
}



function setupMaintenanceSheduler() {
  const job = cron.schedule('*/30 * * * *', async () => {
    try {
      console.log("Running maintenance scheduler...");

      // Fetch all schedules
      const schedules = await prisma.schedule.findMany({});

      for (const schedule of schedules) {
        const { id, postedComments, failedComments, totalComments } = schedule;

        // Count actual comments in the database
        const [actualPosted, actualFailed, actualTotal] = await Promise.all([
          prisma.comment.count({ where: { scheduleId: id, status: 'posted' } }),
          prisma.comment.count({ where: { scheduleId: id, status: 'failed' } }),
          prisma.comment.count({ where: { scheduleId: id } }),
        ]);

        // If mismatch, update the fields
        if (totalComments !== actualTotal ||
          postedComments !== actualPosted ||
          failedComments !== actualFailed) {
          console.log(`Fixing progress for schedule ${id}`);

          await prisma.schedule.update({
            where: { id },
            data: {
              totalComments: actualTotal,
              postedComments: actualPosted,
              failedComments: actualFailed,
            }
          });
        }
      }
    } catch (error) {
      console.error('Maintenance scheduler failed:', error);
    }
  });

  activeJobs.set('maintenance-scheduler', job);
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

/**
 * Pause a schedule in Redis
 */
async function pauseSchedule(scheduleId) {
  try {
    if (!redisClient?.isOpen) await initRedis();

    // Update Redis cache to paused status
    await redisClient.set(`schedule:${scheduleId}`, JSON.stringify({
      id: scheduleId,
      status: 'paused',
      type: 'unknown',
      user: 'unknown'
    }), { EX: 86400 });

    // Stop active job if exists
    if (activeJobs.has(scheduleId)) {
      await activeJobs.get(scheduleId).stop();
      activeJobs.delete(scheduleId);
    }

    console.log(`Schedule ${scheduleId} paused in Redis`);
    return true;
  } catch (error) {
    console.error(`Error pausing schedule ${scheduleId}:`, error);
    return false;
  }
}

/**
 * Update schedule in Redis after database changes
 */
async function updateScheduleCache(scheduleId, skipJobSetup = false) {
  try {
    if (!redisClient?.isOpen) await initRedis();

    // Get fresh schedule data from database
    const schedule = await prisma.schedule.findUnique({
      where: { id: scheduleId }
    });

    if (!schedule) {
      // Schedule deleted, remove from cache
      await deleteSchedule(scheduleId);
      return true;
    }

    // 🧹 Update Worker State (Raw Redis)
    await redisClient.set(`schedule:${scheduleId}`, JSON.stringify({
      id: schedule.id,
      status: schedule.status,
      type: schedule.scheduleType,
      user: schedule.userId
    }), {
      EX: schedule.status === 'error' ? 3600 : 86400
    });

    // 🧹 Invalidate API Cache (Prefixed Redis)
    const userId = schedule.userId;
    if (userId) {
      await Promise.all([
        cacheService.clear(`user:${userId}:schedules:*`),
        cacheService.deleteUserData(userId, `schedule:${scheduleId}`)
      ]);
      console.log(`[Schedule ${scheduleId}] API cache invalidated for user ${userId}`);
    }

    // If schedule was updated and is now active, restart the job
    if (schedule.status === 'active' && !skipJobSetup) {
      await setupScheduleJob(scheduleId);
    } else if (activeJobs.has(scheduleId) && schedule.status !== 'active') {
      // If not active, stop any running jobs
      await activeJobs.get(scheduleId).stop();
      activeJobs.delete(scheduleId);
    }

    console.log(`Schedule ${scheduleId} cache updated in Redis`);
    return true;
  } catch (error) {
    console.error(`Error updating schedule cache ${scheduleId}:`, error);
    return false;
  }
}

/**
 * Delete a schedule from Redis
 */
async function deleteSchedule(scheduleId) {
  try {
    if (!redisClient?.isOpen) await initRedis();

    // Remove from Redis
    await Promise.all([
      redisClient.del(`schedule:${scheduleId}`),
      redisClient.del(`schedule:${scheduleId}:lastUsedAccount`)
    ]);

    // Stop active job if exists
    if (activeJobs.has(scheduleId)) {
      await activeJobs.get(scheduleId).stop();
      activeJobs.delete(scheduleId);
    }

    console.log(`Schedule ${scheduleId} deleted from Redis`);
    return true;
  } catch (error) {
    console.error(`Error deleting schedule ${scheduleId}:`, error);
    return false;
  }
}

/**
 * Retry failed comments for a schedule
 */
async function retryFailedComments(scheduleId) {
  const schedule = await prisma.schedule.findUnique({
    where: { id: scheduleId },
    include: {
      selectedAccounts: true, // Need accounts to know count for validation if needed
    }
  });

  if (!schedule) {
    return { success: false, message: 'Schedule not found' };
  }

  const failedComments = await prisma.comment.findMany({
    where: {
      scheduleId: scheduleId,
      status: 'failed'
    }
  });

  if (failedComments.length === 0) {
    return { success: true, message: 'No failed comments to retry' };
  }

  console.log(`[Schedule ${scheduleId}] Retrying ${failedComments.length} failed comments...`);

  const startTime = Date.now();
  // Use configuration strictly: fallback to 1.5s only if betweenAccounts is not set
  const betweenAccountsMs = (Number(schedule.betweenAccounts) || 1.5) * 1000;

  // Clean up old comments status to avoid double processing
  await prisma.comment.updateMany({
    where: {
      id: { in: failedComments.map(c => c.id) }
    },
    data: {
      status: 'pending',
      errorMessage: null,
      retryCount: { increment: 1 }
    }
  });

  // Decrement failedComments counter on Schedule
  await prisma.schedule.update({
    where: { id: scheduleId },
    data: {
      failedComments: { decrement: failedComments.length }
    }
  });

  let queuedCount = 0;
  for (const comment of failedComments) {
    // Calculate delay based on strict schedule from startTime to avoid drift
    const targetTime = startTime + (queuedCount * betweenAccountsMs);
    const now = Date.now();
    const dispatchDelay = Math.max(0, targetTime - now);

    await commentQueue.add('post-comment', {
      commentId: comment.id,
      scheduleId: schedule.id
    }, {
      delay: Math.round(dispatchDelay),
      jobId: `retry-comment-${comment.id}-${Date.now()}`, // Unique ID for retry
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86400, count: 1000 }
    });

    queuedCount++;
  }

  return {
    success: true,
    message: `Retrying ${queuedCount} comments`,
    count: queuedCount
  };
}

module.exports = {
  setupScheduler,
  setupScheduleJob,
  setupMaintenanceJob,
  processSchedule: optimizedProcessSchedule,
  scheduleQuotaReset,
  scheduleFrequentStatusReset,
  setupMaintenanceSheduler,
  pauseSchedule,
  deleteSchedule,
  updateScheduleCache,
  setupViewScheduleJob,
  deleteViewSchedule,
  resetRedis,
  shutdown,
  cleanupExpiredKeys,
  cleanupAllExpiredKeys,
  selectWeightedAccount,
  retryFailedComments,
};
