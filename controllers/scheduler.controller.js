const prisma = require('../services/prisma.service');
const { setupScheduleJob, pauseSchedule, deleteSchedule, updateScheduleCache } = require('../services/scheduler.service');
const { cacheService } = require('../services/cacheService');
const { validateRotationConfig } = require('../services/account.rotation');

/**
 * Format schedule response to match frontend expectations
 */
/**
 * Format schedule response to match frontend expectations
 */
const formatScheduleResponse = (schedule, videoStats = {}) => {
  const formatted = { ...schedule };

  // Map rotation fields
  formatted.accountRotation = {
    enabled: schedule.rotationEnabled || false,
    currentlyActive: schedule.currentlyActive || 'principal',
    lastRotatedAt: schedule.lastRotatedAt
  };
  formatted.nextRunAt = schedule.nextRunAt;

  formatted.accountCategories = {
    principal: schedule.principalAccounts || [],
    secondary: schedule.secondaryAccounts || []
  };

  // Map nested objects if they are returned as flat fields in Prisma
  formatted.delays = {
    minDelay: schedule.minDelay,
    maxDelay: schedule.maxDelay,
    betweenAccounts: schedule.betweenAccounts,
    limitComments: schedule.limitComments
  };

  formatted.schedule = {
    type: schedule.scheduleType,
    startDate: schedule.startDate,
    endDate: schedule.endDate,
    cronExpression: schedule.cronExpression,
    interval: schedule.interval,
    days: schedule.scheduleConfig?.days,
    startTime: schedule.scheduleConfig?.startTime,
    endTime: schedule.scheduleConfig?.endTime
  };

  // Attach video progress stats
  // videoStats is assumed to be { [scheduleId]: { [videoId]: count } } or just { [videoId]: count } if handling single schedule
  if (videoStats[schedule.id]) {
    formatted.videoProgress = videoStats[schedule.id];
  } else if (Object.keys(videoStats).length > 0 && !videoStats[schedule.id]) {
    // Fallback if videoStats is just the map for this single schedule
    formatted.videoProgress = videoStats;
  } else {
    formatted.videoProgress = {};
  }


  return formatted;
};

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

    const where = { userId: req.user.id };

    // Filter by status if provided
    if (status) {
      where.status = status;
    }

    const schedules = await prisma.schedule.findMany({
      where,
      include: {
        selectedAccounts: {
          select: { id: true, email: true, channelTitle: true, status: true }
        },
        principalAccounts: {
          select: { id: true, email: true, channelTitle: true, status: true }
        },
        secondaryAccounts: {
          select: { id: true, email: true, channelTitle: true, status: true }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip: (parseInt(page) - 1) * parseInt(limit),
      take: parseInt(limit)
    });

    // 📊 Aggregate comments per video for these schedules
    const scheduleIds = schedules.map(s => s.id);
    const videoStatsRaw = await prisma.comment.groupBy({
      by: ['scheduleId', 'videoId'],
      where: {
        scheduleId: { in: scheduleIds },
        status: 'posted' // Only count successfully posted comments? Or all? Usually 'posted'.
      },
      _count: {
        _all: true
      }
    });

    // Transform into { [scheduleId]: { [videoId]: count } }
    const videoStats = {};
    videoStatsRaw.forEach(stat => {
      if (!videoStats[stat.scheduleId]) {
        videoStats[stat.scheduleId] = {};
      }
      videoStats[stat.scheduleId][stat.videoId] = stat._count._all;
    });

    const formattedSchedules = schedules.map(s => formatScheduleResponse(s, videoStats));

    const total = await prisma.schedule.count({ where });

    const responseData = {
      schedules: formattedSchedules,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit))
      }
    };

    // Cache for 5 minutes
    await cacheService.setUserData(req.user.id, cacheKey, responseData, 10);

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

    const schedule = await prisma.schedule.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id
      },
      include: {
        selectedAccounts: {
          select: { id: true, email: true, channelTitle: true, status: true }
        },
        principalAccounts: {
          select: { id: true, email: true, channelTitle: true, status: true }
        },
        secondaryAccounts: {
          select: { id: true, email: true, channelTitle: true, status: true }
        }
      }
    });

    if (!schedule) {
      return res.status(404).json({ message: 'Schedule not found' });
    }

    // Get comments related to this schedule
    const comments = await prisma.comment.findMany({
      where: {
        userId: req.user.id,
        scheduleId: schedule.id
      },
      orderBy: { createdAt: 'desc' },
      take: 100
    });

    // 📊 Aggregate comments per video for this schedule
    const videoStatsRaw = await prisma.comment.groupBy({
      by: ['videoId'],
      where: {
        scheduleId: schedule.id,
        status: 'posted'
      },
      _count: {
        _all: true
      }
    });

    const videoStats = {};
    videoStatsRaw.forEach(stat => {
      videoStats[stat.videoId] = stat._count._all;
    });

    const formattedSchedule = formatScheduleResponse(schedule, { [schedule.id]: videoStats });

    // Explicitly attach it if the helper felt weird about structure or just ensure it's there
    formattedSchedule.videoProgress = videoStats;

    const responseData = { schedule: formattedSchedule, comments };

    // Cache for 5 minutes
    await cacheService.setUserData(req.user.id, cacheKey, responseData, 10);

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
      accountRotation: rotationInput
    } = req.body;

    const randomBetween = (min, max) =>
      Math.floor(Math.random() * (max - min + 1)) + min;

    let limitCommentsData;
    if (typeof delays.limitComments === "object" && delays.limitComments !== null) {
      limitCommentsData = {
        value: Number(delays.limitComments.value ?? 0),
        min: Number(delays.limitComments.min ?? 0),
        max: Number(delays.limitComments.max ?? 0),
        isRandom: !!delays.limitComments.isRandom
      };
    } else {
      limitCommentsData = {
        value: delays.limitComments === 0
          ? randomBetween(delays.minSleepComments ?? 1, delays.maxSleepComments ?? 1)
          : Number(delays.limitComments ?? 0),
        min: Number(delays.minSleepComments ?? 0),
        max: Number(delays.maxSleepComments ?? 0),
        isRandom: false
      };
    }

    const delaysData = {
      minDelay: Number(delays.minDelay ?? 0),
      maxDelay: Number(delays.maxDelay ?? 0),
      betweenAccounts: Number(delays.betweenAccounts ?? 0),
      limitComments: limitCommentsData,
    };

    let intervalData;
    if (scheduleConfig?.interval) {
      const i = scheduleConfig.interval;
      const minVal = Number(i.minValue ?? i.min ?? 1);
      const maxVal = Number(i.maxValue ?? i.max ?? minVal);

      intervalData = {
        value: (!!i.isRandom) ? randomBetween(minVal, maxVal) : Number(i.value ?? 1),
        unit: i.unit ?? 'minutes',
        min: minVal,
        max: maxVal,
        minValue: minVal,
        maxValue: maxVal,
        isRandom: !!i.isRandom
      };
    } else {
      intervalData = { value: 1, unit: 'minutes' };
    }

    let finalSelectedAccounts = [];
    if (rotationInput?.enabled) {
      const rotationValidation = validateRotationConfig(accountCategories, true);
      if (!rotationValidation.isValid) {
        return res.status(400).json({ message: rotationValidation.error });
      }

      const allAccountIds = [
        ...(accountCategories.principal || []),
        ...(accountCategories.secondary || [])
      ];

      const validAccountsCount = await prisma.youTubeAccount.count({
        where: {
          id: { in: allAccountIds },
          userId: req.user.id,
          status: 'active'
        }
      });

      if (validAccountsCount !== allAccountIds.length) {
        return res.status(400).json({ message: 'Some accounts in categories are invalid or inactive' });
      }

      finalSelectedAccounts = accountCategories.principal;
    } else {
      if (selectedAccounts && selectedAccounts.length > 0) {
        const validAccounts = await prisma.youTubeAccount.findMany({
          where: {
            id: { in: selectedAccounts },
            userId: req.user.id,
            status: 'active'
          },
          select: { id: true }
        });

        if (validAccounts.length !== selectedAccounts.length) {
          return res.status(400).json({ message: 'Some selected accounts are invalid or inactive' });
        }
        finalSelectedAccounts = validAccounts.map(a => a.id);
      } else {
        const activeAccounts = await prisma.youTubeAccount.findMany({
          where: {
            userId: req.user.id,
            status: 'active'
          },
          select: { id: true }
        });
        if (activeAccounts.length === 0) {
          return res.status(400).json({ message: 'No active YouTube accounts available' });
        }
        finalSelectedAccounts = activeAccounts.map(a => a.id);
      }
    }

    const scheduleData = {
      userId: req.user.id,
      name,
      commentTemplates,
      targetVideos: targetVideos || [],
      targetChannels: targetChannels || [],
      accountSelection: accountSelection || 'specific',
      selectedAccounts: {
        connect: finalSelectedAccounts.map(id => ({ id }))
      },
      startDate: scheduleConfig.startDate ? new Date(scheduleConfig.startDate) : null,
      endDate: scheduleConfig.endDate ? new Date(scheduleConfig.endDate) : null,
      scheduleType: scheduleConfig.type || 'immediate',
      cronExpression: scheduleConfig.cronExpression,
      scheduleConfig: {
        days: scheduleConfig.days,
        startTime: scheduleConfig.startTime,
        endTime: scheduleConfig.endTime
      },
      interval: intervalData,
      minDelay: delaysData.minDelay,
      maxDelay: delaysData.maxDelay,
      betweenAccounts: delaysData.betweenAccounts,
      limitComments: delaysData.limitComments,
      includeEmojis,
      status: 'active',
      useAI: useAI || false,
      principalAccounts: rotationInput?.enabled && accountCategories?.principal ? {
        connect: accountCategories.principal.map(id => ({ id }))
      } : undefined,
      secondaryAccounts: rotationInput?.enabled && accountCategories?.secondary ? {
        connect: accountCategories.secondary.map(id => ({ id }))
      } : undefined,
      rotationEnabled: rotationInput?.enabled ? true : false,
      currentlyActive: rotationInput?.enabled ? 'principal' : 'principal'
    };

    const schedule = await prisma.schedule.create({
      data: scheduleData,
      include: {
        selectedAccounts: {
          select: { id: true, email: true, channelTitle: true, status: true }
        },
        principalAccounts: {
          select: { id: true, email: true, channelTitle: true, status: true }
        },
        secondaryAccounts: {
          select: { id: true, email: true, channelTitle: true, status: true }
        }
      }
    });

    await updateScheduleCache(schedule.id);

    const formattedSchedule = formatScheduleResponse(schedule);
    res.status(201).json({
      message: 'Schedule created successfully',
      schedule: formattedSchedule
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
      accountRotation: rotationInput
    } = req.body;

    const schedule = await prisma.schedule.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id
      }
    });

    if (!schedule) {
      return res.status(404).json({ message: 'Schedule not found' });
    }

    const randomBetween = (min, max) =>
      Math.floor(Math.random() * (max - min + 1)) + min;

    let delaysData;
    if (delays) {
      delaysData = {
        minDelay: delays.minDelay,
        maxDelay: delays.maxDelay,
        betweenAccounts: delays.betweenAccounts,
        limitComments: (() => {
          const lc = delays.limitComments;
          const value = typeof lc === 'object' && lc !== null
            ? lc.value
            : lc === 0
              ? randomBetween(delays.minSleepComments ?? 1, delays.maxSleepComments ?? 1)
              : lc;
          return {
            value: value ?? 0,
            min: lc?.min ?? delays.minSleepComments ?? 0,
            max: lc?.max ?? delays.maxSleepComments ?? 0,
            isRandom: !!lc?.isRandom
          };
        })(),
      };
    }

    let intervalData;
    if (scheduleConfig?.interval) {
      const i = scheduleConfig.interval;
      const minVal = Number(i.minValue ?? i.min ?? 1);
      const maxVal = Number(i.maxValue ?? i.max ?? minVal);
      intervalData = {
        value: (!!i.isRandom) ? randomBetween(minVal, maxVal) : Number(i.value ?? 1),
        unit: i.unit ?? 'minutes',
        min: minVal,
        max: maxVal,
        minValue: minVal,
        maxValue: maxVal,
        isRandom: !!i.isRandom
      };
    }

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (status !== undefined) updateData.status = status;
    if (commentTemplates !== undefined) updateData.commentTemplates = commentTemplates;
    if (targetVideos !== undefined) updateData.targetVideos = targetVideos;
    if (targetChannels !== undefined) updateData.targetChannels = targetChannels;
    if (accountSelection !== undefined) updateData.accountSelection = accountSelection;
    if (includeEmojis !== undefined) updateData.includeEmojis = includeEmojis;
    if (useAI !== undefined) updateData.useAI = useAI;

    // Flatten delays
    if (delaysData) {
      updateData.minDelay = delaysData.minDelay;
      updateData.maxDelay = delaysData.maxDelay;
      updateData.betweenAccounts = delaysData.betweenAccounts;
      updateData.limitComments = delaysData.limitComments;
    }

    // Flatten scheduleConfig
    if (scheduleConfig) {
      if (scheduleConfig.type) updateData.scheduleType = scheduleConfig.type;
      if (scheduleConfig.startDate !== undefined) updateData.startDate = scheduleConfig.startDate ? new Date(scheduleConfig.startDate) : null;
      if (scheduleConfig.endDate !== undefined) updateData.endDate = scheduleConfig.endDate ? new Date(scheduleConfig.endDate) : null;
      if (scheduleConfig.cronExpression !== undefined) updateData.cronExpression = scheduleConfig.cronExpression;
      if (intervalData) updateData.interval = intervalData;

      updateData.scheduleConfig = {
        days: scheduleConfig.days || schedule.scheduleConfig?.days,
        startTime: scheduleConfig.startTime || schedule.scheduleConfig?.startTime,
        endTime: scheduleConfig.endTime || schedule.scheduleConfig?.endTime
      };
    }

    if (rotationInput !== undefined) {
      if (rotationInput?.enabled) {
        const rotationValidation = validateRotationConfig(accountCategories, true);
        if (!rotationValidation.isValid) {
          return res.status(400).json({ message: rotationValidation.error });
        }

        updateData.rotationEnabled = true;
        updateData.currentlyActive = schedule.currentlyActive || 'principal';

        // Update relationships for account categories
        if (accountCategories) {
          if (accountCategories.principal) {
            updateData.principalAccounts = {
              set: accountCategories.principal.map(id => ({ id }))
            };
          }
          if (accountCategories.secondary) {
            updateData.secondaryAccounts = {
              set: accountCategories.secondary.map(id => ({ id }))
            };
          }
        }

        const currentRotationType = updateData.currentlyActive;
        const finalAccounts = currentRotationType === 'secondary' ? accountCategories.secondary : accountCategories.principal;

        if (finalAccounts) {
          updateData.selectedAccounts = {
            set: finalAccounts.map(id => ({ id }))
          };
        }
      } else {
        updateData.rotationEnabled = false;
        // Optionally disconnect accounts from rotation categories
        updateData.principalAccounts = { set: [] };
        updateData.secondaryAccounts = { set: [] };
      }
    } else if (selectedAccounts !== undefined && !schedule.rotationEnabled) {
      if (selectedAccounts.length > 0) {
        const validAccountsCount = await prisma.youTubeAccount.count({
          where: {
            id: { in: selectedAccounts },
            userId: req.user.id,
            status: 'active'
          }
        });
        if (validAccountsCount !== selectedAccounts.length) {
          return res.status(400).json({ message: 'Some selected accounts are invalid or inactive' });
        }
        updateData.selectedAccounts = {
          set: selectedAccounts.map(id => ({ id }))
        };
      } else {
        const activeAccounts = await prisma.youTubeAccount.findMany({
          where: { userId: req.user.id, status: 'active' },
          select: { id: true }
        });
        if (activeAccounts.length === 0) {
          return res.status(400).json({ message: 'No active YouTube accounts available' });
        }
        updateData.selectedAccounts = {
          set: activeAccounts.map(a => ({ id: a.id }))
        };
      }
    }

    const savedSchedule = await prisma.schedule.update({
      where: { id: req.params.id },
      data: updateData,
      include: {
        selectedAccounts: {
          select: { id: true, email: true, channelTitle: true, status: true }
        },
        principalAccounts: {
          select: { id: true, email: true, channelTitle: true, status: true }
        },
        secondaryAccounts: {
          select: { id: true, email: true, channelTitle: true, status: true }
        }
      }
    });

    // Use centralized cache invalidation and job management
    await updateScheduleCache(savedSchedule.id);

    const formattedSchedule = formatScheduleResponse(savedSchedule);

    return res.json({
      message: 'Schedule updated successfully',
      schedule: formattedSchedule
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
    const scheduleId = req.params.id;

    const schedule = await prisma.schedule.findFirst({
      where: { id: scheduleId, userId: req.user.id }
    });

    if (!schedule) {
      return res.status(404).json({ message: 'Schedule not found' });
    }

    // Use transaction to ensure data integrity
    await prisma.$transaction([
      prisma.comment.deleteMany({ where: { scheduleId } }),
      prisma.schedule.delete({ where: { id: scheduleId } })
    ]);

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
    const schedule = await prisma.schedule.findFirst({
      where: { id: req.params.id, userId: req.user.id }
    });

    if (!schedule) {
      return res.status(404).json({ message: 'Schedule not found' });
    }

    const updatedSchedule = await prisma.schedule.update({
      where: { id: req.params.id },
      data: { status: 'paused', nextRunAt: null }
    });

    await pauseSchedule(req.params.id);
    await updateScheduleCache(req.params.id);

    const formattedSchedule = formatScheduleResponse(updatedSchedule);

    res.json({
      message: 'Schedule paused successfully',
      schedule: formattedSchedule
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
    const schedule = await prisma.schedule.findFirst({
      where: { id: req.params.id, userId: req.user.id }
    });

    if (!schedule) {
      return res.status(404).json({ message: 'Schedule not found' });
    }

    const updatedSchedule = await prisma.schedule.update({
      where: { id: req.params.id },
      data: { status: 'active' },
      include: {
        selectedAccounts: {
          select: { id: true, email: true, channelTitle: true, status: true }
        },
        principalAccounts: {
          select: { id: true, email: true, channelTitle: true, status: true }
        },
        secondaryAccounts: {
          select: { id: true, email: true, channelTitle: true, status: true }
        }
      }
    });

    // Use centralized cache invalidation and job management
    await updateScheduleCache(updatedSchedule.id);

    const formattedSchedule = formatScheduleResponse(updatedSchedule);

    res.json({
      message: 'Schedule resumed successfully',
      schedule: formattedSchedule
    });

  } catch (error) {
    next(error);
  }
};

/**
 * Mark a schedule as completed
 */
const completeSchedule = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const schedule = await prisma.schedule.findUnique({
      where: { id: id }
    });

    if (!schedule) {
      return res.status(404).json({ message: 'Schedule not found' });
    }

    if (schedule.userId !== userId) {
      return res.status(403).json({ message: 'Unauthorized' });
    }

    await prisma.schedule.update({
      where: { id: id },
      data: { status: 'completed' }
    });

    await cacheService.deleteUserData(userId, `schedule:${id}`);
    await cacheService.clear(`user:${userId}:schedules:*`);

    res.json({ message: 'Schedule marked as completed' });
  } catch (error) {
    console.error('Error completing schedule:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

const retryFailedComments = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // Verify ownership
    const schedule = await prisma.schedule.findUnique({
      where: { id: id }
    });

    if (!schedule) {
      return res.status(404).json({ message: 'Schedule not found' });
    }

    if (schedule.userId !== userId) {
      return res.status(403).json({ message: 'Unauthorized' });
    }

    const startProcessing = require('../services/scheduler.service').retryFailedComments;
    const result = await startProcessing(id);

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    console.error('Error retrying failed comments:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

module.exports = {
  getSchedules,
  getScheduleById,
  createSchedule,
  updateSchedule,
  deleteSchedule: deleteScheduleHandler,
  pauseSchedule: pauseScheduleHandler,
  resumeSchedule: resumeScheduleHandler,
  completeSchedule,
  retryFailedComments
};
