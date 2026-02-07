-- AlterTable
ALTER TABLE "Schedule" ADD COLUMN     "errorCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastProcessedAt" TIMESTAMP(3),
ADD COLUMN     "sleepDelayMinutes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sleepDelayStartTime" TIMESTAMP(3);
