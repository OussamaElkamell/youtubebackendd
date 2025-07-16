const { ScheduleModel } = require('../models/schedule.model');
const { CommentModel } = require('../models/comment.model');
const { YouTubeAccountModel } = require('../models/youtube-account.model');
const { setupScheduleJob, pauseSchedule, deleteSchedule, updateScheduleCache } = require('../services/scheduler.service');
const { cacheService } = require('../services/cacheService');
const mongoose = require('mongoose');

/**
 * Get all schedules for the authenticated user
 */
const getSchedules = async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const cacheKey = `schedules:${req.user.id}:${status || 'all'}:${page}:${limit}`;
    
    // Try to get from cache first
    const cachedData = await cacheService.getUserData(req.user.id, cacheKey);
    if (cachedData) {
      return res.json(cachedData);
    }
    
    const query = { user: req.user.id };
    
    // Filter by status if provided
    if (status) {
      query.status = status;
    }
    
    const schedules = await ScheduleModel.find(query)
      .populate('selectedAccounts', 'email channelTitle status')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
      
    const total = await ScheduleModel.countDocuments(query);
    
    const responseData = {
      schedules,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / limit)
      }
    };
    
    // Cache for 5 minutes
    await cacheService.setUserData(req.user.id, cacheKey, responseData, 5);
    
    res.json(responseData);
  } catch (error) {
    next(error);
  }
};

/**
 * Get a specific schedule
 */
const getScheduleById = async (req, res, next) => {
  try {
    const cacheKey = `schedule:${req.params.id}`;
    
    // Try to get from cache first
    const cachedData = await cacheService.getUserData(req.user.id, cacheKey);
    if (cachedData) {
      return res.json(cachedData);
    }
    
    const schedule = await ScheduleModel.findOne({
      _id: req.params.id,
      user: req.user.id
    }).populate('selectedAccounts', 'email channelTitle status');
    
    if (!schedule) {
      return res.status(404).json({ message: 'Schedule not found' });
    }
    
    // Get comments related to this schedule
    const comments = await CommentModel.find({
      user: req.user.id,
      'metadata.scheduleId': schedule._id
    }).sort({ createdAt: -1 }).limit(100);
    
    const responseData = { schedule, comments };
    
    // Cache for 5 minutes
    await cacheService.setUserData(req.user.id, cacheKey, responseData, 5);
    
    res.json(responseData);
  } catch (error) {
    next(error);
  }
};

/**
 * Create a new schedule
 */
const createSchedule = async (req, res, next) => {
  try {
    const {
      name,
      commentTemplates,
      targetVideos,
      targetChannels,
      accountSelection,
      selectedAccounts,
      schedule: scheduleConfig,
      includeEmojis,
      delays,
      useAI
    } = req.body;
    
    // Validate accounts
    if (selectedAccounts && selectedAccounts.length > 0) {
      const validAccounts = await YouTubeAccountModel.find({
        _id: { $in: selectedAccounts },
        user: req.user.id,
        status: 'active'
      });
      
      if (validAccounts.length === 0) {
        return res.status(400).json({ message: 'No valid active YouTube accounts selected' });
      }
      
      if (validAccounts.length !== selectedAccounts.length) {
        return res.status(400).json({ 
          message: 'Some selected accounts are invalid or inactive',
          validAccounts: validAccounts.map(a => a._id)
        });
      }
    } else {
      // If no accounts specified, get all active accounts
      const activeAccounts = await YouTubeAccountModel.find({
        user: req.user.id,
        status: 'active'
      });
      
      if (activeAccounts.length === 0) {
        return res.status(400).json({ message: 'No active YouTube accounts available' });
      }
      
      selectedAccounts = activeAccounts.map(a => a._id);
    }
    
    // Create schedule
    const schedule = new ScheduleModel({
      user: req.user.id,
      name,
      commentTemplates,
      targetVideos: targetVideos || [],
      targetChannels: targetChannels || [],
      accountSelection: accountSelection || 'specific',
      selectedAccounts,
      schedule: scheduleConfig,
      delays: delays || {
        minDelay: 30,
        maxDelay: 180,
        betweenAccounts: 300
      },
      includeEmojis:includeEmojis,
      status: 'active',
      interval: scheduleConfig.interval || { value: 1, unit: 'minutes' } ,
      useAI:useAI
    });
    
    
    await schedule.save();
    
    // Invalidate cache
    await updateScheduleCache(schedule._id); // populate fresh
await cacheService.clear(`user:${req.user.id}:schedules:*`); // remove paginated lists

    
    // Set up schedule job
    try {
      await setupScheduleJob(schedule._id);
    } catch (error) {
      console.error('Error setting up schedule job:', error);
      
      // Update schedule status to error
      schedule.status = 'error';
      await schedule.save();
      
      return res.status(500).json({
        message: 'Error setting up schedule job',
        error: error.message,
        schedule
      });
    }
    
    res.status(201).json({
      message: 'Schedule created successfully',
      schedule
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Update a schedule
 */
const updateSchedule = async (req, res, next) => {
  try {
    const {
      name,
      status,
      commentTemplates,
      targetVideos,
      targetChannels,
      accountSelection,
      selectedAccounts,
      schedule: scheduleConfig,
      includeEmojis,
      delays,
      useAI
    } = req.body;

    // 1. Fetch the schedule document
    const schedule = await ScheduleModel.findOne({
      _id: req.params.id,
      user: req.user.id
    });

    if (!schedule) {
      return res.status(404).json({ message: 'Schedule not found' });
    }

    // 2. Apply updates
    if (name) schedule.name = name;
    if (status) schedule.status = status;
    if (commentTemplates) schedule.commentTemplates = commentTemplates;
    if (targetVideos) schedule.targetVideos = targetVideos;
    if (targetChannels) schedule.targetChannels = targetChannels;
    if (accountSelection) schedule.accountSelection = accountSelection;
    if (delays) schedule.delays = delays; // ✅ FULL REPLACEMENT
    if (scheduleConfig) schedule.schedule = scheduleConfig; // ✅ FULL REPLACEMENT
    if (includeEmojis) schedule.includeEmojis = includeEmojis; 
    if (useAI) schedule.useAI = useAI; 
    // 3. Validate and update selected accounts
    if (selectedAccounts && selectedAccounts.length > 0) {
      const validAccounts = await YouTubeAccountModel.find({
        _id: { $in: selectedAccounts },
        user: req.user.id
      });

      if (validAccounts.length === 0) {
        return res.status(400).json({ message: 'No valid YouTube accounts selected' });
      }

      schedule.selectedAccounts = validAccounts.map(a => a._id);
    }

    // 4. Save the updated schedule to MongoDB
    const savedSchedule = await schedule.save();
    console.log(`✅ Schedule ${req.params.id} saved to MongoDB:`, {
      id: savedSchedule._id,
      status: savedSchedule.status,
      dbHost: mongoose.connection.host,
      dbName: mongoose.connection.db.databaseName
    });

    // 5. Setup job if status is active
    if (schedule.status === 'active') {
      try {
        await setupScheduleJob(schedule._id);
      } catch (err) {
        console.error('⚠️ Error setting up schedule job:', err);
        schedule.status = 'error';
        await schedule.save();
      }
    }

    // 6. Fetch fresh data for cache
    const freshSchedule = await ScheduleModel.findOne({
      _id: req.params.id,
      user: req.user.id
    }).populate('selectedAccounts', 'email channelTitle status').lean();

    const comments = await CommentModel.find({
      user: req.user.id,
      'metadata.scheduleId': req.params.id
    }).sort({ createdAt: -1 }).limit(100);

    const detailData = {
      schedule: freshSchedule,
      comments
    };

    // 7. Clear Redis cache
    await cacheService.clear(`user:${req.user.id}:schedules:*`);
    await cacheService.deleteUserData(req.user.id, `schedule:${req.params.id}`);

    // 8. Set updated schedule in cache
    await cacheService.setUserData(req.user.id, `schedule:${req.params.id}`, detailData, 300);

    // 9. Update list view (first page) if needed
    const page = 1;
    const limit = 20;
    const listQuery = { user: req.user.id };

    const schedules = await ScheduleModel.find(listQuery)
      .populate('selectedAccounts', 'email channelTitle status')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const total = await ScheduleModel.countDocuments(listQuery);
    const paginatedData = {
      schedules,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit)
      }
    };

    const listKey = `schedules:${req.user.id}:all:${page}:${limit}`;
    await cacheService.setUserData(req.user.id, listKey, paginatedData, 300);

    // 10. Send response
    return res.json({
      message: 'Schedule updated successfully',
      schedule: freshSchedule
    });

  } catch (error) {
    console.error('❌ updateSchedule error:', error);
    return next(error);
  }
};



/**
 * Delete a schedule
 */
const deleteScheduleHandler = async (req, res, next) => {
  try {
    // Delete comments associated with the specified schedule
    const scheduleId = req.params.id;

    // Delete comments that belong to the specific schedule
    await CommentModel.deleteMany({
      scheduleId: scheduleId, // Assuming comments have a `scheduleId` field
    });

    // Now delete the schedule
    const result = await ScheduleModel.deleteOne({
      _id: scheduleId,
      user: req.user.id
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ message: 'Schedule not found' });
    }

    // Delete from Redis and stop active jobs
    await deleteSchedule(scheduleId);

    // Invalidate cache
  await cacheService.clear(`user:${req.user.id}:schedules:*`);
await cacheService.deleteUserData(req.user.id, `schedule:${scheduleId}`);


    res.json({ message: 'Schedule and related comments deleted successfully' });
  } catch (error) {
    next(error);
  }
};

/**
 * Pause a schedule
 */
const pauseScheduleHandler = async (req, res, next) => {
  try {
    const schedule = await ScheduleModel.findOne({
      _id: req.params.id,
      user: req.user.id
    });
    
    if (!schedule) {
      return res.status(404).json({ message: 'Schedule not found' });
    }
    
    schedule.status = 'paused';
    const savedSchedule = await schedule.save();
    console.log(`✅ Schedule ${req.params.id} paused and saved to external MongoDB:`, {
      id: savedSchedule._id,
      status: savedSchedule.status,
      dbHost: mongoose.connection.host,
      dbName: mongoose.connection.db.databaseName
    });
    
    // Verify the save by reading back from external database
    const verifySchedule = await ScheduleModel.findById(req.params.id);
    console.log(`✅ Schedule verification - Status in external DB: ${verifySchedule?.status}`);
    
    // Update Redis cache with fresh data from database

    // Pause active jobs
    await pauseSchedule(req.params.id);
    
    // Invalidate cache
 await updateScheduleCache(req.params.id);
await cacheService.clear(`user:${req.user.id}:schedules:*`);
await cacheService.deleteUserData(req.user.id, `schedule:${req.params.id}`);

    
    res.json({
      message: 'Schedule paused successfully',
      schedule
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Resume a paused schedule
 */
const resumeScheduleHandler = async (req, res, next) => {
  try {
    // 1. Find the schedule in MongoDB
    const schedule = await ScheduleModel.findOne({
      _id: req.params.id,
      user: req.user.id
    });

    if (!schedule) {
      return res.status(404).json({ message: 'Schedule not found' });
    }

    // 2. Update status to active and save
    schedule.status = 'active';
    const savedSchedule = await schedule.save();

    console.log(`✅ Schedule ${req.params.id} resumed and saved to MongoDB:`, {
      id: savedSchedule._id,
      status: savedSchedule.status,
      dbHost: mongoose.connection.host,
      dbName: mongoose.connection.db.databaseName
    });

    // 3. Try to re-setup the job
    try {
      await setupScheduleJob(schedule._id);
    } catch (error) {
      console.error('❌ Error setting up schedule job:', error);
      schedule.status = 'error';
      await schedule.save();

      return res.status(500).json({
        message: 'Error setting up schedule job',
        error: error.message,
        schedule
      });
    }

    // 4. Re-fetch fresh data from DB
    const freshSchedule = await ScheduleModel.findOne({
      _id: req.params.id,
      user: req.user.id
    }).populate('selectedAccounts', 'email channelTitle status').lean();

    const comments = await CommentModel.find({
      user: req.user.id,
      'metadata.scheduleId': req.params.id
    }).sort({ createdAt: -1 }).limit(100);

    const detailData = {
      schedule: freshSchedule,
      comments
    };

    // 5. Invalidate and set Redis cache (schedule details)
    await cacheService.clear(`user:${req.user.id}:schedules:*`);
    await cacheService.deleteUserData(req.user.id, `schedule:${req.params.id}`);
    await cacheService.setUserData(req.user.id, `schedule:${req.params.id}`, detailData, 300);

    // 6. Update page 1 of schedule list in Redis
    const page = 1;
    const limit = 20;
    const listQuery = { user: req.user.id };
    const schedules = await ScheduleModel.find(listQuery)
      .populate('selectedAccounts', 'email channelTitle status')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const total = await ScheduleModel.countDocuments(listQuery);
    const paginatedData = {
      schedules,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit)
      }
    };

    const listKey = `schedules:${req.user.id}:all:${page}:${limit}`;
    await cacheService.setUserData(req.user.id, listKey, paginatedData, 300);

    // 7. Send response
    res.json({
      message: 'Schedule resumed successfully',
      schedule: freshSchedule
    });

  } catch (error) {
    next(error);
  }
};

module.exports = {
  getSchedules,
  getScheduleById,
  createSchedule,
  updateSchedule,
  deleteSchedule: deleteScheduleHandler,
  pauseSchedule: pauseScheduleHandler,
  resumeSchedule: resumeScheduleHandler
};