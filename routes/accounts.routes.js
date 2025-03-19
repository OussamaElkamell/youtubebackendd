
const express = require('express');
const { authenticateJWT } = require('../middleware/auth.middleware');
const accountsController = require('../controllers/accounts.controller');

const router = express.Router();

/**
 * @route GET /api/accounts
 * @desc Get all YouTube accounts for the authenticated user
 * @access Private
 */
router.get('/', authenticateJWT, accountsController.getAllAccounts);

/**
 * @route GET /api/accounts/:id
 * @desc Get a specific YouTube account
 * @access Private
 */
router.get('/:id', authenticateJWT, accountsController.getAccountById);

/**
 * @route POST /api/accounts
 * @desc Add a new YouTube account
 * @access Private
 */
router.post('/', authenticateJWT, accountsController.addAccount);

/**
 * @route PUT /api/accounts/:id
 * @desc Update a YouTube account
 * @access Private
 */
router.put('/:id', authenticateJWT, accountsController.updateAccount);

/**
 * @route DELETE /api/accounts/:id
 * @desc Delete a YouTube account
 * @access Private
 */
router.delete('/:id', authenticateJWT, accountsController.deleteAccount);

/**
 * @route POST /api/accounts/:id/refresh-token
 * @desc Force refresh OAuth token for an account
 * @access Private
 */
router.post('/:id/refresh-token', authenticateJWT, accountsController.refreshToken);

/**
 * @route POST /api/accounts/:id/verify
 * @desc Verify account is working by making a test API call
 * @access Private
 */
router.post('/:id/verify', authenticateJWT, accountsController.verifyAccount);

module.exports = router;
