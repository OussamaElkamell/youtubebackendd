const prisma = require('../services/prisma.service');
const { setupViewScheduleJob, deleteViewSchedule } = require('../services/scheduler.service');
const { cacheService } = require('../services/cacheService');

/**
 * Get all view schedules for the authenticated user
 */
const getViewSchedules = async (req, res, next) => {
    try {
        const { status, page = 1, limit = 20 } = req.query;
        const cacheKey = `view_schedules:${req.user.id}:${status || 'all'}:${page}:${limit}`;

        const cachedData = await cacheService.getUserData(req.user.id, cacheKey);
        if (cachedData) return res.json(cachedData);

        const where = { userId: req.user.id };
        if (status) where.status = status;


        const schedules = await prisma.viewSchedule.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: (parseInt(page) - 1) * parseInt(limit),
            take: parseInt(limit)
        });

        const total = await prisma.viewSchedule.count({ where });

        const responseData = {
            schedules,
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                pages: Math.ceil(total / parseInt(limit))
            }
        };

        await cacheService.setUserData(req.user.id, cacheKey, responseData, 10);
        res.json(responseData);
    } catch (error) {
        next(error);
    }
};

/**
 * Get a specific view schedule
 */
const getViewScheduleById = async (req, res, next) => {
    try {
        const schedule = await prisma.viewSchedule.findFirst({
            where: { id: req.params.id, userId: req.user.id }
        });

        if (!schedule) return res.status(404).json({ message: 'View schedule not found' });

        res.json({ schedule });
    } catch (error) {
        next(error);
    }
};

/**
 * Create a new view schedule
 */
const createViewSchedule = async (req, res, next) => {
    try {
        const { name, targetVideos, scheduleType, interval, minWatchTime, maxWatchTime, probability } = req.body;

        const schedule = await prisma.viewSchedule.create({
            data: {
                userId: req.user.id,
                name,
                targetVideos: targetVideos || [],
                scheduleType: scheduleType || 'immediate',
                interval: interval || { value: 60, unit: 'minutes' },
                minWatchTime: minWatchTime || 30000,
                maxWatchTime: maxWatchTime || 120000,
                probability: probability ?? 100,
                autoLike: req.body.autoLike || false,
                status: 'active'
            }
        });

        await cacheService.clear(`user:${req.user.id}:view_schedules:*`);
        await setupViewScheduleJob(schedule.id);

        res.status(201).json({ message: 'View schedule created successfully', schedule });
    } catch (error) {
        next(error);
    }
};

/**
 * Update a view schedule
 */
const updateViewSchedule = async (req, res, next) => {
    try {
        const { name, status, targetVideos, scheduleType, interval, minWatchTime, maxWatchTime, probability } = req.body;

        const schedule = await prisma.viewSchedule.findFirst({
            where: { id: req.params.id, userId: req.user.id }
        });

        if (!schedule) return res.status(404).json({ message: 'View schedule not found' });

        const updatedSchedule = await prisma.viewSchedule.update({
            where: { id: req.params.id },
            data: {
                name,
                status,
                targetVideos,
                scheduleType,
                interval,
                minWatchTime,
                maxWatchTime,
                probability,
                autoLike: req.body.autoLike
            }
        });

        if (updatedSchedule.status === 'active') {
            await setupViewScheduleJob(updatedSchedule.id);
        } else {
            await deleteViewSchedule(updatedSchedule.id);
        }

        await cacheService.clear(`user:${req.user.id}:view_schedules:*`);
        res.json({ message: 'View schedule updated successfully', schedule: updatedSchedule });
    } catch (error) {
        next(error);
    }
};

/**
 * Delete a view schedule
 */
const deleteViewScheduleHandler = async (req, res, next) => {
    try {
        const schedule = await prisma.viewSchedule.findFirst({
            where: { id: req.params.id, userId: req.user.id }
        });

        if (!schedule) return res.status(404).json({ message: 'View schedule not found' });

        await prisma.viewSchedule.delete({ where: { id: req.params.id } });
        await deleteViewSchedule(req.params.id);
        await cacheService.clear(`user:${req.user.id}:view_schedules:*`);

        res.json({ message: 'View schedule deleted successfully' });
    } catch (error) {
        next(error);
    }
};

module.exports = {
    getViewSchedules,
    getViewScheduleById,
    createViewSchedule,
    updateViewSchedule,
    deleteViewSchedule: deleteViewScheduleHandler
};
