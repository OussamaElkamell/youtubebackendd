const { ScheduleModel } = require('../models/schedule.model');
const { cacheService } = require('./cacheService');

/**
 * Ensure schedule data is synchronized between MongoDB and Redis
 */
async function syncScheduleData(scheduleId, forceSync = false) {
  try {
    // Get fresh data from MongoDB
    const dbSchedule = await ScheduleModel.findById(scheduleId).lean();
    
    if (!dbSchedule) {
      console.log(`Schedule ${scheduleId} not found in database, removing from cache`);
      await cacheService.deleteUserData(dbSchedule?.user, `schedule:${scheduleId}`);
      return null;
    }
    
    // Get cached data
    const cacheKey = `schedule:${scheduleId}`;
    const cachedData = await cacheService.getUserData(dbSchedule.user, cacheKey);
    
    // Compare timestamps or force sync
    const needsSync = forceSync || 
      !cachedData || 
      new Date(dbSchedule.updatedAt || dbSchedule.createdAt) > new Date(cachedData.lastSync || 0);
    
    if (needsSync) {
      console.log(`Syncing schedule ${scheduleId} from database to cache`);
      
      // Update cache with fresh database data
      const syncData = {
        ...dbSchedule,
        lastSync: new Date().toISOString()
      };
      
      await cacheService.setUserData(dbSchedule.user, cacheKey, syncData, 300);
      
      // Invalidate related caches
      await cacheService.deleteUserData(dbSchedule.user, `schedules:`);
      
      return syncData;
    }
    
    return cachedData;
  } catch (error) {
    console.error(`Error syncing schedule ${scheduleId}:`, error);
    throw error;
  }
}

/**
 * Verify schedule data consistency between MongoDB and Redis
 */
async function verifyScheduleSync(scheduleId) {
  try {
    const dbSchedule = await ScheduleModel.findById(scheduleId).lean();
    if (!dbSchedule) {
      return { synced: false, error: 'Schedule not found in database' };
    }
    
    const cacheKey = `schedule:${scheduleId}`;
    const cachedData = await cacheService.getUserData(dbSchedule.user, cacheKey);
    
    if (!cachedData) {
      return { synced: false, error: 'Schedule not found in cache' };
    }
    
    // Compare critical fields
    const criticalFields = ['status', 'name', 'updatedAt'];
    const differences = [];
    
    for (const field of criticalFields) {
      if (String(dbSchedule[field]) !== String(cachedData[field])) {
        differences.push({
          field,
          database: dbSchedule[field],
          cache: cachedData[field]
        });
      }
    }
    
    return {
      synced: differences.length === 0,
      differences,
      lastSync: cachedData.lastSync
    };
  } catch (error) {
    console.error(`Error verifying schedule sync ${scheduleId}:`, error);
    return { synced: false, error: error.message };
  }
}

module.exports = {
  syncScheduleData,
  verifyScheduleSync
};