const cron = require('node-cron');
const ApiProfile = require('../models/ApiProfile'); // Adjust path if needed

// ⏰ Schedule: Every day at 00:00 Pacific Time
cron.schedule('0 0 * * *', async () => {
  try {
    console.log(`[${new Date().toISOString()}] 🔁 Resetting usedQuota for all API profiles...`);

    await ApiProfile.updateMany({}, { $set: { usedQuota: 0 } });

    console.log(`[${new Date().toISOString()}] ✅ usedQuota reset completed.`);
  } catch (error) {
    console.error('❌ Error resetting usedQuota:', error.message);
  }
}, {
  timezone: 'America/Los_Angeles' // YouTube API resets in PT timezone
});
