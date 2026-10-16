CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "DataSource" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "version" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketSnapshot" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "priceUsd" DECIMAL(38,18) NOT NULL,
    "change24hPct" DECIMAL(18,8),
    "volume24hUsd" DECIMAL(38,2),
    "marketCapUsd" DECIMAL(38,2),
    "sourceTs" TIMESTAMP(3) NOT NULL,
    "collectedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetricSnapshot" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "value" DECIMAL(38,8) NOT NULL,
    "unit" TEXT NOT NULL,
    "bucketTs" TIMESTAMP(3),
    "collectedAt" TIMESTAMP(3) NOT NULL,
    "sourceTs" TIMESTAMP(3),

    CONSTRAINT "MetricSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyClose" (
    "id" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "closeUsd" DECIMAL(38,18) NOT NULL,
    "sourceSnapshotId" TEXT NOT NULL,
    "calcMethod" TEXT NOT NULL,
    "calcVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyClose_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionLog" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "latencyMs" INTEGER NOT NULL,
    "errorMessage" TEXT,
    "recordsFetched" INTEGER,
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndicatorSnapshot" (
    "id" TEXT NOT NULL,
    "indicator" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "asOf" DATE NOT NULL,
    "status" TEXT NOT NULL,
    "value" DECIMAL(30,12),
    "unit" TEXT NOT NULL,
    "inputCount" INTEGER NOT NULL,
    "fromDate" DATE,
    "toDate" DATE,
    "reason" TEXT,
    "formulaVersion" TEXT NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IndicatorSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DataSource_provider_key" ON "DataSource"("provider");

-- CreateIndex
CREATE INDEX "MarketSnapshot_asset_collectedAt_idx" ON "MarketSnapshot"("asset", "collectedAt");

-- CreateIndex
CREATE INDEX "MarketSnapshot_asset_sourceTs_idx" ON "MarketSnapshot"("asset", "sourceTs");

-- CreateIndex
CREATE UNIQUE INDEX "MarketSnapshot_sourceId_asset_collectedAt_key" ON "MarketSnapshot"("sourceId", "asset", "collectedAt");

-- CreateIndex
CREATE INDEX "MetricSnapshot_scope_metric_bucketTs_idx" ON "MetricSnapshot"("scope", "metric", "bucketTs");

-- CreateIndex
CREATE INDEX "MetricSnapshot_scope_metric_collectedAt_idx" ON "MetricSnapshot"("scope", "metric", "collectedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MetricSnapshot_sourceId_scope_metric_collectedAt_key" ON "MetricSnapshot"("sourceId", "scope", "metric", "collectedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DailyClose_sourceSnapshotId_key" ON "DailyClose"("sourceSnapshotId");

-- CreateIndex
CREATE UNIQUE INDEX "DailyClose_asset_date_key" ON "DailyClose"("asset", "date");

-- CreateIndex
CREATE INDEX "CollectionLog_sourceId_collectedAt_idx" ON "CollectionLog"("sourceId", "collectedAt");

-- CreateIndex
CREATE INDEX "CollectionLog_status_idx" ON "CollectionLog"("status");

-- CreateIndex
CREATE INDEX "IndicatorSnapshot_scope_indicator_asOf_idx" ON "IndicatorSnapshot"("scope", "indicator", "asOf");

-- CreateIndex
CREATE UNIQUE INDEX "IndicatorSnapshot_indicator_scope_asOf_formulaVersion_key" ON "IndicatorSnapshot"("indicator", "scope", "asOf", "formulaVersion");

-- AddForeignKey
ALTER TABLE "MarketSnapshot" ADD CONSTRAINT "MarketSnapshot_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "DataSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetricSnapshot" ADD CONSTRAINT "MetricSnapshot_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "DataSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyClose" ADD CONSTRAINT "DailyClose_sourceSnapshotId_fkey" FOREIGN KEY ("sourceSnapshotId") REFERENCES "MarketSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionLog" ADD CONSTRAINT "CollectionLog_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "DataSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
