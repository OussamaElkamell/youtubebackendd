-- AlterTable
ALTER TABLE "Schedule" ADD COLUMN     "lastFailureAt" TIMESTAMP(3),
ADD COLUMN     "scheduleConfig" JSONB;
