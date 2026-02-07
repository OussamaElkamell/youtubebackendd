-- AlterTable
ALTER TABLE "Schedule" ADD COLUMN     "simulateViews" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "viewConfig" JSONB;
