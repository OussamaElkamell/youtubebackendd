
const express = require('express');
const { authenticateJWT } = require('../middleware/auth.middleware');
const { ScheduleModel } = require('../models/schedule.model');
const { CommentModel } = require('../models/comment.model');
const { YouTubeAccountModel } = require('../models/youtube-account.model');
const { setupScheduleJob } = require('../services/scheduler.service');

const router = express.Router();

/**
 * @route GET /api/scheduler
 * @desc Get all schedules for the authenticated user
 * @access Private
 */
router.get('/', authenticateJWT, async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    
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
    
    res.json({
      schedules,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route GET /api/scheduler/:id
 * @desc Get a specific schedule
 * @access Private
 */
router.get('/:id', authenticateJWT, async (req, res, next) => {
  try {
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
    
    res.json({ schedule, comments });
  } catch (error) {
    next(error);
  }
});

/**
 * @route POST /api/scheduler
 * @desc Create a new schedule
 * @access Private
 */
router.post('/', authenticateJWT, async (req, res, next) => {
  try {
    const {
      name,
      commentTemplates,
      targetVideos,
      targetChannels,
      accountSelection,
      selectedAccounts,
      schedule: scheduleConfig,
      delays
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
      status: 'active'
    });
    
    await schedule.save();
    
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
});

/**
 * @route PUT /api/scheduler/:id
 * @desc Update a schedule
 * @access Private
 */
router.put('/:id', authenticateJWT, async (req, res, next) => {
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
      delays
    } = req.body;
    
    const schedule = await ScheduleModel.findOne({
      _id: req.params.id,
      user: req.user.id
    });
    
    if (!schedule) {
      return res.status(404).json({ message: 'Schedule not found' });
    }
    
    // Update fields
    if (name) schedule.name = name;
    if (status) schedule.status = status;
    if (commentTemplates) schedule.commentTemplates = commentTemplates;
    if (targetVideos) schedule.targetVideos = targetVideos;
    if (targetChannels) schedule.targetChannels = targetChannels;
    if (accountSelection) schedule.accountSelection = accountSelection;
    if (delays) schedule.delays = { ...schedule.delays, ...delays };
    
    // Validate and update selected accounts
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
    
    // Update schedule configuration
    if (scheduleConfig) {
      schedule.schedule = { ...schedule.schedule, ...scheduleConfig };
    }
    
    await schedule.save();
    
    // Re-setup schedule job if active
    if (schedule.status === 'active') {
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
    }
    
    res.json({
      message: 'Schedule updated successfully',
      schedule
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route DELETE /api/scheduler/:id
 * @desc Delete a schedule
 * @access Private
 */
router.delete('/:id', authenticateJWT, async (req, res, next) => {
  try {
    const result = await ScheduleModel.deleteOne({
      _id: req.params.id,
      user: req.user.id
    });
    
    if (result.deletedCount === 0) {
      return res.status(404).json({ message: 'Schedule not found' });
    }
    
    res.json({ message: 'Schedule deleted successfully' });
  } catch (error) {
    next(error);
  }
});

/**
 * @route POST /api/scheduler/:id/pause
 * @desc Pause a schedule
 * @access Private
 */
router.post('/:id/pause', authenticateJWT, async (req, res, next) => {
  try {
    const schedule = await ScheduleModel.findOne({
      _id: req.params.id,
      user: req.user.id
    });
    
    if (!schedule) {
      return res.status(404).json({ message: 'Schedule not found' });
    }
    
    schedule.status = 'paused';
    await schedule.save();
    
    res.json({
      message: 'Schedule paused successfully',
      schedule
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route POST /api/scheduler/:id/resume
 * @desc Resume a paused schedule
 * @access Private
 */
router.post('/:id/resume', authenticateJWT, async (req, res, next) => {
  try {
    const schedule = await ScheduleModel.findOne({
      _id: req.params.id,
      user: req.user.id
    });
    
    if (!schedule) {
      return res.status(404).json({ message: 'Schedule not found' });
    }
    
    schedule.status = 'active';
    await schedule.save();
    
    // Re-setup schedule job
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
    
    res.json({
      message: 'Schedule resumed successfully',
      schedule
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
