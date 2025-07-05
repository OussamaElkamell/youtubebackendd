const express = require('express');
const { authenticateJWT } = require('../middleware/auth.middleware');
const {
  getSchedules,
  getScheduleById,
  createSchedule,
  updateSchedule,
  deleteSchedule: deleteScheduleHandler,
  pauseSchedule: pauseScheduleHandler,
  resumeSchedule: resumeScheduleHandler
} = require('../controllers/scheduler.controller');

const router = express.Router();

/**
 * @route GET /api/scheduler
 * @desc Get all schedules for the authenticated user
 * @access Private
 */
router.get('/', authenticateJWT, getSchedules);

/**
 * @route GET /api/scheduler/:id
 * @desc Get a specific schedule
 * @access Private
 */
router.get('/:id', authenticateJWT, getScheduleById);

/**
 * @route POST /api/scheduler
 * @desc Create a new schedule
 * @access Private
 */
router.post('/', authenticateJWT, createSchedule);

/**
 * @route PUT /api/scheduler/:id
 * @desc Update a schedule
 * @access Private
 */
router.put('/:id', authenticateJWT, updateSchedule);

/**
 * @route DELETE /api/scheduler/:id
 * @desc Delete a schedule
 * @access Private
 */
router.delete('/:id', authenticateJWT, deleteScheduleHandler);

/**
 * @route POST /api/scheduler/:id/pause
 * @desc Pause a schedule
 * @access Private
 */
router.post('/:id/pause', authenticateJWT, pauseScheduleHandler);

/**
 * @route POST /api/scheduler/:id/resume
 * @desc Resume a paused schedule
 * @access Private
 */
router.post('/:id/resume', authenticateJWT, resumeScheduleHandler);

module.exports = router;