const { CommentModel } = require('../models/comment.model');
const { ScheduleModel } = require('../models/schedule.model');
const { YouTubeAccountModel } = require('../models/youtube-account.model');
const ApiProfile = require('../models/ApiProfile');
const { postComment } = require('./youtube.service');
const { commentQueue } = require('./queue.service');
const { selectNextAccount } = require('./account.selector');

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
 * Get random comment template
 */
function getRandomTemplate(templates) {
  return templates[Math.floor(Math.random() * templates.length)];
}

/**
 * Process comments for accounts
 */
async function processCommentsForAccounts(accounts, targetVideos, schedule) {
  if (schedule.delays?.delayofsleep > 0) {
    console.log(`[Schedule ${schedule._id}] Skipping comment creation - delay of ${schedule.delays.delayofsleep} minutes active`);
    return;
  }

  // 🔥 ONLY CREATE ONE COMMENT PER SCHEDULE EXECUTION to prevent successive posts
  const nextAccount = selectNextAccount(accounts, schedule.lastUsedAccount);

  if (!nextAccount) {
    console.log(`[Schedule ${schedule._id}] No available accounts`);
    return;
  }

  const randomVideo = targetVideos[Math.floor(Math.random() * targetVideos.length)];

  const comment = {
    user: schedule.user,
    youtubeAccount: nextAccount._id,
    videoId: randomVideo.videoId,
    scheduleId: schedule._id,
    content: getRandomTemplate(schedule.commentTemplates),
    status: 'pending',
    metadata: { scheduleId: schedule._id },
  };

  const [createdComment] = await Promise.all([
    CommentModel.create(comment),
    YouTubeAccountModel.updateOne(
      { _id: nextAccount._id },
      { lastUsed: new Date() }
    ),
    ScheduleModel.updateOne(
      { _id: schedule._id },
      {
        $inc: { 'progress.totalComments': 1 },
        $set: { lastUsedAccount: nextAccount._id },
      }
    ),
  ]);

  await commentQueue.add('post-comment', {
    commentId: createdComment._id,
    scheduleId: schedule._id
  }, {
    delay: calculateOptimizedDelay(schedule.delays),
    attempts: 1,
    backoff: { type: 'exponential', delay: 3000 },
  });

  console.log(`Queued 1 comment for account ${nextAccount._id}`);
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

/**
 * Process individual comment job
 */
async function processCommentJob(commentId, scheduleId) {
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
    const proxyError = result.message?.includes("Proxy failed or invalid") || result.error?.includes("Proxy") || result.message === "Proxy failed or invalid";
    const duplication = result.message?.includes("No available accounts. Comment delayed for retry.") || result.error?.includes("Comment delayed for retry");
    
    console.log("result.error", result.message);
    
    const updateProgress = result.success
      ? { $inc: { 'progress.postedComments': 1 } }
      : { $inc: { 'progress.failedComments': 1 } };

    await ScheduleModel.updateOne({ _id: scheduleId }, updateProgress);

    let updateFields = {
      lastMessage: result.success ? 'Comment posted successfully' : result.message || result.error || 'Unknown error',
    };

    if (result.success) {
      updateFields.status = 'active';
      updateFields.proxyErrorCount = 0;
      const schedule = await ScheduleModel.findById(scheduleId);
      if (schedule?.schedule?.type === 'interval') {
        const { handleIntervalSchedule } = require('./schedule.processor');
        await handleIntervalSchedule(schedule, scheduleId);
      }
    } else if (proxyError) {
      const currentAccount = await YouTubeAccountModel.findById(comment.youtubeAccount._id);
      const newCount = (currentAccount?.proxyErrorCount || 0) + 1;
      updateFields.proxyErrorCount = newCount;
      updateFields.status = newCount >= 10 ? 'inactive' : 'active';
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

module.exports = {
  processCommentsForAccounts,
  processCommentJob,
  getCommentWithRetry,
  updateCommentStatus,
  handleCommentError,
  calculateOptimizedDelay,
  getRandomTemplate
};