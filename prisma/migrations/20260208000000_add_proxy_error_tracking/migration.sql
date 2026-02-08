-- AlterTable
ALTER TABLE "Proxy" ADD COLUMN     "proxyErrorCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "proxyErrorThreshold" INTEGER NOT NULL DEFAULT 5;
