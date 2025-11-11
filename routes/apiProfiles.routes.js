// routes/apiProfiles.route.js
const express = require('express');
const { authenticateJWT } = require('../middleware/auth.middleware');
const apiProfilesController = require('../controllers/profiles.controller');

const router = express.Router();

/**
 * @route GET /api/profiles
 * @desc Get all API profiles
 * @access Private
 */
router.get('/', authenticateJWT, apiProfilesController.getAllProfiles);

/**
 * @route GET /api/profiles/active
 * @desc Get the currently active API profile
 * @access Private
 */
router.get('/active', authenticateJWT, apiProfilesController.getActiveProfile);

/**
 * @route GET /api/profiles/:id
 * @desc Get a specific API profile
 * @access Private
 */
router.get('/:id', authenticateJWT, apiProfilesController.getProfileById);

/**
 * @route POST /api/profiles
 * @desc Create a new API profile
 * @access Private
 */
router.post('/', authenticateJWT, apiProfilesController.createProfile);

/**
 * @route PUT /api/profiles/:id
 * @desc Update an API profile
 * @access Private
 */
router.put('/:id', authenticateJWT, apiProfilesController.updateProfile);

/**
 * @route DELETE /api/profiles/:id
 * @desc Delete an API profile
 * @access Private
 */
router.delete('/:id', authenticateJWT, apiProfilesController.deleteProfile);

/**
 * @route POST /api/profiles/:id/set-active
 * @desc Set a profile as the active one
 * @access Private
 */
router.post('/:id/set-active', authenticateJWT, apiProfilesController.setActiveProfile);

module.exports = router;