const { ScheduleModel } = require('../models/schedule.model');
const { CommentModel } = require('../models/comment.model');
const { YouTubeAccountModel } = require('../models/youtube-account.model');
const { setupScheduleJob, pauseSchedule, deleteSchedule, updateScheduleCache } = require('../services/scheduler.service');
const { cacheService } = require('../services/cacheService');
const { validateRotationConfig } = require('../services/account.rotation');
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
    let {
      name,
      commentTemplates,
      targetVideos,
      targetChannels,
      accountSelection,
      selectedAccounts,
      schedule: scheduleConfig,
      includeEmojis,
      delays,
      useAI,
      accountCategories,
      accountRotation
    } = req.body;
    console.log("scheduleConfig", scheduleConfig);

    // helper to get a random integer between min and max (inclusive)
    const randomBetween = (min, max) =>
      Math.floor(Math.random() * (max - min + 1)) + min;

    // --- ✅ FIXED: Reorganize delays ---
    let limitCommentsData;

    if (
      typeof delays.limitComments === "object" &&
      delays.limitComments !== null
    ) {
      // Case 1: already structured as { value, min, max }
      limitCommentsData = {
        value: Number(delays.limitComments.value ?? 0),
        min: Number(delays.limitComments.min ?? 0),
        max: Number(delays.limitComments.max ?? 0),
      };
    } else {
      // Case 2: simple number → build it properly
      limitCommentsData = {
        value:
          delays.limitComments === 0
            ? randomBetween(delays.minSleepComments ?? 1, delays.maxSleepComments ?? 1)
            : Number(delays.limitComments ?? 0),
        min: Number(delays.minSleepComments ?? 0),
        max: Number(delays.maxSleepComments ?? 0),
      };
    }

    const delaysData = {
      minDelay: Number(delays.minDelay ?? 0),
      maxDelay: Number(delays.maxDelay ?? 0),
      betweenAccounts: Number(delays.betweenAccounts ?? 0),
      limitComments: limitCommentsData,
    };

    // --- Reorganize interval ---
    let intervalData;
    if (scheduleConfig?.interval) {
      const i = scheduleConfig.interval;
      const minVal = i.minValue ?? i.min ?? 1;
      const maxVal = i.maxValue ?? i.max ?? minVal;

      intervalData = {
        value:
          i.value === 0
            ? randomBetween(minVal, maxVal)
            : i.value ?? 1,
        unit: i.unit ?? 'minutes',
        min: minVal,
        max: maxVal,
      };
    } else {
      intervalData = { value: 1, unit: 'minutes' };
    }

    // --- Validate account rotation config ---
    if (accountRotation?.enabled) {
      const rotationValidation = validateRotationConfig(accountCategories, true);
      if (!rotationValidation.isValid) {
        return res.status(400).json({ message: rotationValidation.error });
      }

      const allAccountIds = [
        ...(accountCategories.principal || []),
        ...(accountCategories.secondary || [])
      ];

      const validAccounts = await YouTubeAccountModel.find({
        _id: { $in: allAccountIds },
        user: req.user.id,
        status: 'active'
      });

      if (validAccounts.length !== allAccountIds.length) {
        return res.status(400).json({
          message: 'Some accounts in categories are invalid or inactive',
          validAccounts: validAccounts.map(a => a._id),
        });
      }

      selectedAccounts = accountCategories.principal;
    } else {
      // --- Validate accounts (non-rotation mode) ---
      if (selectedAccounts && selectedAccounts.length > 0) {
        const validAccounts = await YouTubeAccountModel.find({
          _id: { $in: selectedAccounts },
          user: req.user.id,
          status: 'active'
        });

        if (validAccounts.length !== selectedAccounts.length) {
          return res.status(400).json({
            message: 'Some selected accounts are invalid or inactive',
            validAccounts: validAccounts.map(a => a._id),
          });
        }
      } else {
        const activeAccounts = await YouTubeAccountModel.find({
          user: req.user.id,
          status: 'active'
        });
        if (activeAccounts.length === 0) {
          return res.status(400).json({ message: 'No active YouTube accounts available' });
        }
        selectedAccounts = activeAccounts.map(a => a._id);
      }
    }

    // --- Create Schedule ---
    const schedule = new ScheduleModel({
      user: req.user.id,
      name,
      commentTemplates,
      targetVideos: targetVideos || [],
      targetChannels: targetChannels || [],
      accountSelection: accountSelection || 'specific',
      selectedAccounts,
      schedule: {
        ...scheduleConfig,
        interval: intervalData
      },
      delays: delaysData,
      includeEmojis,
      status: 'active',
      interval: intervalData,
      useAI,
      accountCategories: accountRotation?.enabled ? accountCategories : undefined,
      accountRotation: accountRotation?.enabled
        ? {
            enabled: true,
            currentlyActive: 'principal',
            rotatedPrincipalIds: [],
            rotatedSecondaryIds: []
          }
        : undefined,
    });

    await schedule.save();

    // cache + job setup
    await updateScheduleCache(schedule._id);
    await cacheService.clear(`user:${req.user.id}:schedules:*`);
    await setupScheduleJob(schedule._id);

    res.status(201).json({ message: 'Schedule created successfully', schedule });
  } catch (error) {
    next(error);
  }
};




/**
 * Update a schedule
 */
const updateSchedule = async (req, res, next) => {
  try {
    let {
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
      useAI,
      accountCategories,
      accountRotation
    } = req.body;

    const schedule = await ScheduleModel.findOne({
      _id: req.params.id,
      user: req.user.id
    });

    if (!schedule) {
      return res.status(404).json({ message: 'Schedule not found' });
    }

    // helper to get a random integer between min and max (inclusive)
    const randomBetween = (min, max) =>
      Math.floor(Math.random() * (max - min + 1)) + min;

    // --- Reorganize delays (aligned with createSchedule) ---
    let delaysData;
    if (delays) {
      delaysData = {
        minDelay: delays.minDelay,
        maxDelay: delays.maxDelay,
        betweenAccounts: delays.betweenAccounts,
        limitComments: {
          value:
            delays.limitComments === 0
              ? randomBetween(delays.minSleepComments ?? 1, delays.maxSleepComments ?? 1)
              : delays.limitComments,
          min: delays.minSleepComments,
          max: delays.maxSleepComments,
        },
      };
    }

    // --- Reorganize interval (aligned with createSchedule) ---
    let intervalData;
    if (scheduleConfig?.interval) {
      const i = scheduleConfig.interval;
      const minVal = i.minValue ?? i.min ?? 1;
      const maxVal = i.maxValue ?? i.max ?? minVal;

      intervalData = {
        value:
          i.value === 0
            ? randomBetween(minVal, maxVal)
            : i.value ?? 1,
        unit: i.unit ?? 'minutes',
        min: minVal,
        max: maxVal,
      };
    }

    // --- Validate account rotation config if being updated ---
    if (accountRotation !== undefined) {
      if (accountRotation?.enabled) {
        const rotationValidation = validateRotationConfig(accountCategories, true);
        if (!rotationValidation.isValid) {
          return res.status(400).json({ message: rotationValidation.error });
        }

        // Validate all account IDs exist and are active
        const allAccountIds = [
          ...(accountCategories.principal || []),
          ...(accountCategories.secondary || [])
        ];
        
        const validAccounts = await YouTubeAccountModel.find({
          _id: { $in: allAccountIds },
          user: req.user.id,
          status: 'active'
        });

        if (validAccounts.length !== allAccountIds.length) {
          return res.status(400).json({
            message: 'Some accounts in categories are invalid or inactive',
            validAccounts: validAccounts.map(a => a._id),
          });
        }

        // Update rotation config
        schedule.accountCategories = accountCategories;
        schedule.accountRotation = {
          enabled: true,
          currentlyActive: schedule.accountRotation?.currentlyActive || 'principal',
          rotatedPrincipalIds: schedule.accountRotation?.rotatedPrincipalIds || [],
          rotatedSecondaryIds: schedule.accountRotation?.rotatedSecondaryIds || [],
          lastRotatedAt: schedule.accountRotation?.lastRotatedAt
        };
        
        // Use principal accounts as selected if rotation is newly enabled
        if (!schedule.accountRotation?.enabled) {
          schedule.selectedAccounts = accountCategories.principal;
        }
      } else {
        // Disable rotation
        schedule.accountRotation = { enabled: false };
        schedule.accountCategories = undefined;
      }
    }

    // --- Validate / update selected accounts (non-rotation mode or manual override) ---
    if (selectedAccounts !== undefined && !accountRotation?.enabled) {
      if (selectedAccounts.length > 0) {
        const validAccounts = await YouTubeAccountModel.find({
          _id: { $in: selectedAccounts },
          user: req.user.id,
          status: 'active'
        });

        if (validAccounts.length !== selectedAccounts.length) {
          return res.status(400).json({
            message: 'Some selected accounts are invalid or inactive',
            validAccounts: validAccounts.map(a => a._id),
          });
        }
        schedule.selectedAccounts = validAccounts.map(a => a._id);
      } else {
        const activeAccounts = await YouTubeAccountModel.find({
          user: req.user.id,
          status: 'active'
        });
        if (activeAccounts.length === 0) {
          return res.status(400).json({ message: 'No active YouTube accounts available' });
        }
        schedule.selectedAccounts = activeAccounts.map(a => a._id);
      }
    }

    // --- Apply primitive field updates ---
    if (name !== undefined) schedule.name = name;
    if (status !== undefined) schedule.status = status;
    if (commentTemplates !== undefined) schedule.commentTemplates = commentTemplates;
    if (targetVideos !== undefined) schedule.targetVideos = targetVideos;
    if (targetChannels !== undefined) schedule.targetChannels = targetChannels;
    if (accountSelection !== undefined) schedule.accountSelection = accountSelection;
    if (includeEmojis !== undefined) schedule.includeEmojis = includeEmojis;
    if (useAI !== undefined) schedule.useAI = useAI;

    // --- Apply delays & interval updates ---
    if (delaysData) schedule.delays = delaysData;
    if (scheduleConfig) {
      schedule.schedule = {
        ...scheduleConfig,
        interval: intervalData ?? scheduleConfig.interval
      };
      if (intervalData) schedule.interval = intervalData;
    }

    // Save and refresh jobs/cache
    const savedSchedule = await schedule.save();
    if (savedSchedule.status === 'active') {
      await setupScheduleJob(savedSchedule._id);
    }

    await cacheService.clear(`user:${req.user.id}:schedules:*`);
    await cacheService.deleteUserData(req.user.id, `schedule:${savedSchedule._id}`);

    const freshSchedule = await ScheduleModel.findById(savedSchedule._id)
      .populate('selectedAccounts', 'email channelTitle status')
      .lean();

    return res.json({
      message: 'Schedule updated successfully',
      schedule: freshSchedule
    });
  } catch (error) {
    console.error('❌ updateSchedule error:', error);
    next(error);
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