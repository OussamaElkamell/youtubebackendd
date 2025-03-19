
const cron = require('node-cron');
const { ScheduleModel } = require('../models/schedule.model');
const { CommentModel } = require('../models/comment.model');
const { YouTubeAccountModel } = require('../models/youtube-account.model');
const { postComment } = require('./youtube.service');
const { assignRandomProxy } = require('./proxy.service');

// Store active cron jobs
const activeJobs = new Map();

/**
 * Set up all schedule jobs on server startup
 */
async function setupScheduler() {
  try {
    console.log('Setting up comment scheduler...');
    
    // Get all active schedules
    const activeSchedules = await ScheduleModel.find({ status: 'active' });
    
    console.log(`Found ${activeSchedules.length} active schedules`);
    
    // Set up each schedule
    for (const schedule of activeSchedules) {
      await setupScheduleJob(schedule._id);
    }
    
    // Set up recurring job to process immediate comments
    setupImmediateCommentsProcessor();
    
    // Set up daily maintenance job
    setupMaintenanceJob();
    
    console.log('Comment scheduler setup complete');
  } catch (error) {
    console.error('Error setting up scheduler:', error);
  }
}

/**
 * Set up a specific schedule job
 * @param {String} scheduleId Schedule ID
 */
async function setupScheduleJob(scheduleId) {
  try {
    // Stop existing job if it exists
    if (activeJobs.has(scheduleId)) {
      activeJobs.get(scheduleId).stop();
      activeJobs.delete(scheduleId);
    }
    
    // Get schedule
    const schedule = await ScheduleModel.findById(scheduleId);
    
    if (!schedule || schedule.status !== 'active') {
      return false;
    }
    
    // Determine job type and setup
    switch (schedule.schedule.type) {
      case 'immediate':
        // For immediate schedules, process them right away
        processSchedule(schedule._id);
        break;
        
      case 'once':
        // One-time schedule
        if (schedule.schedule.startDate) {
          const scheduledTime = new Date(schedule.schedule.startDate);
          const now = new Date();
          
          // If start date is in the past, process now
          if (scheduledTime <= now) {
            processSchedule(schedule._id);
          } else {
            // Schedule for future time
            const timeUntilStart = scheduledTime.getTime() - now.getTime();
            setTimeout(() => {
              processSchedule(schedule._id);
            }, timeUntilStart);
          }
        }
        break;
        
      case 'recurring':
        // Cron-based recurring schedule
        if (schedule.schedule.cronExpression) {
          const job = cron.schedule(schedule.schedule.cronExpression, () => {
            processSchedule(schedule._id);
          });
          
          activeJobs.set(scheduleId, job);
        }
        break;
        
      case 'interval':
        // Interval-based schedule
        if (schedule.schedule.interval && schedule.schedule.interval.value > 0) {
          let intervalMs;
          
          switch (schedule.schedule.interval.unit) {
            case 'minutes':
              intervalMs = schedule.schedule.interval.value * 60 * 1000;
              break;
            case 'hours':
              intervalMs = schedule.schedule.interval.value * 60 * 60 * 1000;
              break;
            case 'days':
              intervalMs = schedule.schedule.interval.value * 24 * 60 * 60 * 1000;
              break;
            default:
              intervalMs = schedule.schedule.interval.value * 60 * 1000; // Default to minutes
          }
          
          // Execute immediately and then at intervals
          processSchedule(schedule._id);
          
          const interval = setInterval(() => {
            processSchedule(schedule._id);
          }, intervalMs);
          
          // Store reference to interval
          activeJobs.set(scheduleId, {
            stop: () => clearInterval(interval)
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
 * Process a schedule by posting comments
 * @param {String} scheduleId Schedule ID
 */
async function processSchedule(scheduleId) {
  try {
    console.log(`Processing schedule ${scheduleId}`);
    
    // Get schedule with accounts
    const schedule = await ScheduleModel.findById(scheduleId)
      .populate('selectedAccounts');
    
    if (!schedule || schedule.status !== 'active') {
      console.log(`Schedule ${scheduleId} is no longer active`);
      return false;
    }
    
    // Check if end date has passed
    if (schedule.schedule.endDate && new Date(schedule.schedule.endDate) < new Date()) {
      console.log(`Schedule ${scheduleId} has ended`);
      schedule.status = 'completed';
      await schedule.save();
      
      // Stop the job
      if (activeJobs.has(scheduleId)) {
        activeJobs.get(scheduleId).stop();
        activeJobs.delete(scheduleId);
      }
      
      return false;
    }
    
    // Check if we have videos to comment on
    if ((schedule.targetVideos.length === 0 && schedule.targetChannels.length === 0) ||
        schedule.commentTemplates.length === 0) {
      console.log(`Schedule ${scheduleId} has no targets or comment templates`);
      return false;
    }
    
    // Process target videos
    const targetVideos = [...schedule.targetVideos];
    
    // If we have target channels, get their latest videos
    if (schedule.targetChannels.length > 0) {
      // This would require a separate function to get latest videos from channels
      // For now, we'll just use the directly specified videos
    }
    
    // No videos to process
    if (targetVideos.length === 0) {
      console.log(`Schedule ${scheduleId} has no videos to comment on`);
      return false;
    }
    
    // Get accounts to use based on selection strategy
    let accounts = [];
    
    switch (schedule.accountSelection) {
      case 'specific':
        // Use only the specified accounts
        accounts = schedule.selectedAccounts.filter(a => a.status === 'active');
        break;
        
      case 'random':
        // Randomly select from available accounts
        const randomIndex = Math.floor(Math.random() * schedule.selectedAccounts.length);
        const randomAccount = schedule.selectedAccounts[randomIndex];
        if (randomAccount && randomAccount.status === 'active') {
          accounts = [randomAccount];
        }
        break;
        
      case 'round-robin':
        // Select accounts in a round-robin fashion based on last used
        accounts = [...schedule.selectedAccounts]
          .filter(a => a.status === 'active')
          .sort((a, b) => {
            if (!a.lastUsed) return -1;
            if (!b.lastUsed) return 1;
            return new Date(a.lastUsed) - new Date(b.lastUsed);
          });
        break;
    }
    
    // No active accounts
    if (accounts.length === 0) {
      console.log(`Schedule ${scheduleId} has no active accounts`);
      return false;
    }
    
    // For each account, post comments to videos with random delays
    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      
      // Skip to next account if this one isn't active
      if (account.status !== 'active') {
        continue;
      }
      
      // Assign a random proxy if needed
      if (!account.proxy) {
        await assignRandomProxy(schedule.user, account._id);
      }
      
      // Calculate random delay between accounts
      const accountDelay = i === 0 ? 0 : schedule.delays.betweenAccounts;
      
      // Schedule comment posting with delay
      setTimeout(async () => {
        // For each video, pick a random comment template and post
        for (const video of targetVideos) {
          // Pick a random comment template
          const commentTemplate = schedule.commentTemplates[
            Math.floor(Math.random() * schedule.commentTemplates.length)
          ];
          
          // Calculate random delay between comments
          const commentDelay = Math.floor(
            Math.random() * 
            (schedule.delays.maxDelay - schedule.delays.minDelay) + 
            schedule.delays.minDelay
          );
          
          // Create comment in database
          const comment = new CommentModel({
            user: schedule.user,
            youtubeAccount: account._id,
            videoId: video.videoId,
            content: commentTemplate,
            status: 'pending',
            metadata: {
              scheduleId: schedule._id
            }
          });
          
          await comment.save();
          
          // Update schedule progress
          schedule.progress.totalComments += 1;
          await schedule.save();
          
          // Post comment after delay
          setTimeout(async () => {
            try {
              const result = await postComment(comment._id);
              
              // Update comment status
              if (result.success) {
                comment.status = 'posted';
                comment.postedAt = new Date();
                comment.commentId = result.commentId;
                await comment.save();
                
                // Update schedule progress
                schedule.progress.postedComments += 1;
                await schedule.save();
              } else {
                comment.status = 'failed';
                comment.errorMessage = result.error;
                comment.retryCount += 1;
                await comment.save();
                
                // Update schedule progress
                schedule.progress.failedComments += 1;
                await schedule.save();
              }
            } catch (error) {
              console.error(`Error posting comment for schedule ${scheduleId}:`, error);
              
              // Update comment as failed
              comment.status = 'failed';
              comment.errorMessage = error.message;
              comment.retryCount += 1;
              await comment.save();
              
              // Update schedule progress
              schedule.progress.failedComments += 1;
              await schedule.save();
            }
          }, commentDelay * 1000);
        }
      }, accountDelay * 1000);
    }
    
    return true;
  } catch (error) {
    console.error(`Error processing schedule ${scheduleId}:`, error);
    
    // Update schedule status to error
    try {
      const schedule = await ScheduleModel.findById(scheduleId);
      if (schedule) {
        schedule.status = 'error';
        await schedule.save();
      }
    } catch (updateError) {
      console.error(`Error updating schedule status for ${scheduleId}:`, updateError);
    }
    
    return false;
  }
}

/**
 * Set up processor for immediate comments
 */
function setupImmediateCommentsProcessor() {
  // Run every minute
  const job = cron.schedule('* * * * *', async () => {
    try {
      // Find pending comments scheduled for immediate posting
      const pendingComments = await CommentModel.find({
        status: 'pending',
        scheduledFor: null
      }).limit(10);
      
      // Process each comment
      for (const comment of pendingComments) {
        try {
          await postComment(comment._id);
        } catch (error) {
          console.error(`Error posting immediate comment ${comment._id}:`, error);
        }
      }
    } catch (error) {
      console.error('Error processing immediate comments:', error);
    }
  });
  
  activeJobs.set('immediate-processor', job);
}

/**
 * Set up daily maintenance job
 */
function setupMaintenanceJob() {
  // Run at midnight every day
  const job = cron.schedule('0 0 * * *', async () => {
    try {
      console.log('Running daily maintenance tasks');
      
      // Reset daily usage counters
      await YouTubeAccountModel.updateMany(
        {},
        {
          $set: {
            'dailyUsage.date': new Date(),
            'dailyUsage.commentCount': 0,
            'dailyUsage.likeCount': 0
          }
        }
      );
      
      // Complete any schedules that have ended
      const expiredSchedules = await ScheduleModel.find({
        status: 'active',
        'schedule.endDate': { $lt: new Date() }
      });
      
      for (const schedule of expiredSchedules) {
        schedule.status = 'completed';
        await schedule.save();
        
        // Stop the job
        if (activeJobs.has(schedule._id.toString())) {
          activeJobs.get(schedule._id.toString()).stop();
          activeJobs.delete(schedule._id.toString());
        }
      }
      
      console.log('Daily maintenance completed');
    } catch (error) {
      console.error('Error during daily maintenance:', error);
    }
  });
  
  activeJobs.set('maintenance', job);
}

module.exports = {
  setupScheduler,
  setupScheduleJob,
  processSchedule
};
