-- docs/60 · what was sent, so the next run does not send it again

CREATE TABLE "NotificationLog" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "forDay" TIMESTAMP(3) NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationLog_companyId_kind_subjectId_forDay_key"
  ON "NotificationLog"("companyId", "kind", "subjectId", "forDay");
CREATE INDEX "NotificationLog_companyId_sentAt_idx" ON "NotificationLog"("companyId", "sentAt");
