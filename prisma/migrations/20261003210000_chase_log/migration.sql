-- docs/61 · what this company asked somebody outside it, and what it said

CREATE TABLE "ChaseLog" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "partyName" TEXT NOT NULL,
    "sentTo" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "sentById" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    CONSTRAINT "ChaseLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ChaseLog_companyId_kind_subjectId_idx" ON "ChaseLog"("companyId", "kind", "subjectId");
CREATE INDEX "ChaseLog_companyId_sentAt_idx" ON "ChaseLog"("companyId", "sentAt");
