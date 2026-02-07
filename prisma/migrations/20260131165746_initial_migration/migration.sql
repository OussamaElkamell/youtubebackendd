-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT,
    "googleId" TEXT,
    "googleEmail" TEXT,
    "resetPasswordToken" TEXT,
    "resetPasswordExpires" TIMESTAMP(3),
    "lastLogin" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiProfile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecret" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "usedQuota" INTEGER NOT NULL DEFAULT 0,
    "limitQuota" INTEGER NOT NULL DEFAULT 10000,
    "status" TEXT NOT NULL DEFAULT 'not exceeded',
    "exceededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Proxy" (
    "id" TEXT NOT NULL,
    "proxy" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "username" TEXT,
    "password" TEXT,
    "protocol" TEXT NOT NULL DEFAULT 'http',
    "status" TEXT NOT NULL DEFAULT 'active',
    "location" TEXT,
    "lastChecked" TIMESTAMP(3),
    "connectionSpeed" INTEGER,
    "notes" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Proxy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YouTubeAccount" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "channelId" TEXT,
    "channelTitle" TEXT,
    "thumbnailUrl" TEXT,
    "lastUsed" TIMESTAMP(3),
    "dailyUsageDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "commentCount" INTEGER NOT NULL DEFAULT 0,
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "accessToken" TEXT,
    "refreshToken" TEXT NOT NULL,
    "tokenExpiry" TIMESTAMP(3),
    "clientId" TEXT NOT NULL,
    "clientSecret" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "lastMessage" TEXT,
    "connectedDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isPosting" BOOLEAN NOT NULL DEFAULT false,
    "proxyErrorCount" INTEGER NOT NULL DEFAULT 0,
    "duplicationCount" INTEGER NOT NULL DEFAULT 0,
    "proxyErrorThreshold" INTEGER NOT NULL DEFAULT 3,
    "userId" TEXT NOT NULL,
    "proxyId" TEXT,
    "apiProfileId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "YouTubeAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Comment" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "parentId" TEXT,
    "content" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "scheduledFor" TIMESTAMP(3),
    "postedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "youtubeCommentId" TEXT,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "lastPreviousAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Schedule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "commentTemplates" TEXT[],
    "targetVideos" JSONB,
    "targetChannels" JSONB,
    "accountSelection" TEXT NOT NULL DEFAULT 'specific',
    "scheduleType" TEXT NOT NULL DEFAULT 'immediate',
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "cronExpression" TEXT,
    "errorMessage" TEXT,
    "interval" JSONB,
    "useAI" BOOLEAN NOT NULL DEFAULT false,
    "minDelay" INTEGER NOT NULL DEFAULT 0,
    "maxDelay" INTEGER NOT NULL DEFAULT 0,
    "betweenAccounts" INTEGER NOT NULL DEFAULT 0,
    "limitComments" JSONB,
    "delayofsleep" INTEGER NOT NULL DEFAULT 0,
    "delayStartTime" TIMESTAMP(3),
    "totalComments" INTEGER NOT NULL DEFAULT 0,
    "postedComments" INTEGER NOT NULL DEFAULT 0,
    "failedComments" INTEGER NOT NULL DEFAULT 0,
    "includeEmojis" BOOLEAN NOT NULL DEFAULT false,
    "userId" TEXT NOT NULL,
    "lastUsedAccountId" TEXT,
    "rotationEnabled" BOOLEAN NOT NULL DEFAULT false,
    "currentlyActive" TEXT NOT NULL DEFAULT 'principal',
    "lastRotatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_SelectedAccounts" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_SelectedAccounts_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_PrincipalAccounts" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_PrincipalAccounts_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_SecondaryAccounts" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_SecondaryAccounts_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_RotatedPrincipalAccounts" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_RotatedPrincipalAccounts_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_RotatedSecondaryAccounts" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_RotatedSecondaryAccounts_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "_SelectedAccounts_B_index" ON "_SelectedAccounts"("B");

-- CreateIndex
CREATE INDEX "_PrincipalAccounts_B_index" ON "_PrincipalAccounts"("B");

-- CreateIndex
CREATE INDEX "_SecondaryAccounts_B_index" ON "_SecondaryAccounts"("B");

-- CreateIndex
CREATE INDEX "_RotatedPrincipalAccounts_B_index" ON "_RotatedPrincipalAccounts"("B");

-- CreateIndex
CREATE INDEX "_RotatedSecondaryAccounts_B_index" ON "_RotatedSecondaryAccounts"("B");

-- AddForeignKey
ALTER TABLE "Proxy" ADD CONSTRAINT "Proxy_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YouTubeAccount" ADD CONSTRAINT "YouTubeAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YouTubeAccount" ADD CONSTRAINT "YouTubeAccount_proxyId_fkey" FOREIGN KEY ("proxyId") REFERENCES "Proxy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YouTubeAccount" ADD CONSTRAINT "YouTubeAccount_apiProfileId_fkey" FOREIGN KEY ("apiProfileId") REFERENCES "ApiProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "YouTubeAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "Schedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_lastPreviousAccountId_fkey" FOREIGN KEY ("lastPreviousAccountId") REFERENCES "YouTubeAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_lastUsedAccountId_fkey" FOREIGN KEY ("lastUsedAccountId") REFERENCES "YouTubeAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_SelectedAccounts" ADD CONSTRAINT "_SelectedAccounts_A_fkey" FOREIGN KEY ("A") REFERENCES "Schedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_SelectedAccounts" ADD CONSTRAINT "_SelectedAccounts_B_fkey" FOREIGN KEY ("B") REFERENCES "YouTubeAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PrincipalAccounts" ADD CONSTRAINT "_PrincipalAccounts_A_fkey" FOREIGN KEY ("A") REFERENCES "Schedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PrincipalAccounts" ADD CONSTRAINT "_PrincipalAccounts_B_fkey" FOREIGN KEY ("B") REFERENCES "YouTubeAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_SecondaryAccounts" ADD CONSTRAINT "_SecondaryAccounts_A_fkey" FOREIGN KEY ("A") REFERENCES "Schedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_SecondaryAccounts" ADD CONSTRAINT "_SecondaryAccounts_B_fkey" FOREIGN KEY ("B") REFERENCES "YouTubeAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_RotatedPrincipalAccounts" ADD CONSTRAINT "_RotatedPrincipalAccounts_A_fkey" FOREIGN KEY ("A") REFERENCES "Schedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_RotatedPrincipalAccounts" ADD CONSTRAINT "_RotatedPrincipalAccounts_B_fkey" FOREIGN KEY ("B") REFERENCES "YouTubeAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_RotatedSecondaryAccounts" ADD CONSTRAINT "_RotatedSecondaryAccounts_A_fkey" FOREIGN KEY ("A") REFERENCES "Schedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_RotatedSecondaryAccounts" ADD CONSTRAINT "_RotatedSecondaryAccounts_B_fkey" FOREIGN KEY ("B") REFERENCES "YouTubeAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
