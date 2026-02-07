const { setupMaintenanceJob, setupMaintenanceSheduler } = require('./services/scheduler.service');
const prisma = require('./services/prisma.service');

async function test() {
    try {
        console.log('Verifying scheduler.service.js...');

        // Just checking if they are functions
        if (typeof setupMaintenanceJob !== 'function') throw new Error('setupMaintenanceJob is not a function');
        if (typeof setupMaintenanceSheduler !== 'function') throw new Error('setupMaintenanceSheduler is not a function');

        console.log('✅ Functions are exported correctly.');

        // We can't easily run the cron jobs here without triggering them, 
        // but we can check the file content one last time for any 'ScheduleModel' string.
        const fs = require('fs');
        const content = fs.readFileSync('./services/scheduler.service.js', 'utf8');

        if (content.includes('ScheduleModel')) {
            console.error('❌ ScheduleModel still found in scheduler.service.js');
        } else {
            console.log('✅ No ScheduleModel found in scheduler.service.js');
        }

        if (content.includes('CommentModel')) {
            console.error('❌ CommentModel still found in scheduler.service.js');
        } else {
            console.log('✅ No CommentModel found in scheduler.service.js');
        }

        process.exit(0);
    } catch (error) {
        console.error('❌ Verification failed:', error);
        process.exit(1);
    }
}

test();
