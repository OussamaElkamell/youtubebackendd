const prisma = require('./services/prisma.service');

async function check() {
    console.log('Prisma models:', Object.keys(prisma).filter(k => !k.startsWith('_')));
    if (prisma.viewSchedule) {
        console.log('✅ viewSchedule model found');
    } else {
        console.log('❌ viewSchedule model NOT found');
    }
    process.exit(0);
}

check();
