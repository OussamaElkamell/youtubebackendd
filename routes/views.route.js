const express = require('express');
const router = express.Router();
const viewsController = require('../controllers/views.controller');
const { authenticateJWT } = require('../middleware/auth.middleware');

router.use(authenticateJWT);

router.route('/')
    .get(viewsController.getViewSchedules)
    .post(viewsController.createViewSchedule);

router.route('/:id')
    .get(viewsController.getViewScheduleById)
    .put(viewsController.updateViewSchedule)
    .delete(viewsController.deleteViewSchedule);

module.exports = router;
