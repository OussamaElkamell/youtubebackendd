/*
  Warnings:

  - You are about to drop the column `delayStartTime` on the `Schedule` table. All the data in the column will be lost.
  - You are about to drop the column `delayofsleep` on the `Schedule` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Schedule" DROP COLUMN "delayStartTime",
DROP COLUMN "delayofsleep";
