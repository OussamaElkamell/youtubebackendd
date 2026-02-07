require('dotenv').config();
const prisma = require('./services/prisma.service');

async function main() {
    try {
        console.log("Starting diagnostic...");

        // Test simple select
        // Test exact findMany from setupScheduler
        console.log("Testing findMany({ where: { status: 'active' } })...");
        const s0 = await prisma.schedule.findMany({ where: { status: 'active' } });
        console.log("Success s0. Count:", s0.length);

        console.log("Testing findFirst with id only...");
        const s1 = await prisma.schedule.findFirst({ select: { id: true } });
        console.log("Success s1:", s1);

        if (s1) {
            const scheduleId = s1.id;

            // Test sleep fields
            console.log("Testing sleep fields...");
            const s2 = await prisma.schedule.findUnique({
                where: { id: scheduleId },
                select: {
                    sleepDelayMinutes: true,
                    sleepDelayStartTime: true
                }
            });
            console.log("Success s2:", s2);

            // Test all fields
            console.log("Testing all fields...");
            const s3 = await prisma.schedule.findUnique({
                where: { id: scheduleId }
            });
            console.log("Success s3: All fields loaded");

            // Test include
            console.log("Testing include (all relations)...");
            const s4 = await prisma.schedule.findUnique({
                where: { id: scheduleId },
                include: {
                    selectedAccounts: true,
                    user: true,
                    principalAccounts: true,
                    secondaryAccounts: true,
                    rotatedPrincipal: true,
                    rotatedSecondary: true,
                    lastUsedAccount: true
                }
            });
            console.log("Success s4: All relations work");
        }
    } catch (error) {
        console.error("DIAGNOSTIC FAILED:");
        console.error(error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
