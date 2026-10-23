-- Fase 6: pools e holders do coletor de tokens.
-- Aplicar manualmente no Supabase do terminal, COM BACKUP antes.
-- NAO aplicar via prisma migrate/db push. Segue o estilo de
-- prisma-terminal/sql/2026-10-22-create-token-captures.sql.
--
-- Confirmar o papel "collector" e a policy "collector_all" contra pg_policies
-- antes de aplicar. Este arquivo nao altera o schema.prisma nem o coletor.

-- TokenCapture: campos de pools e volumes observados passam a ser opcionais.
ALTER TABLE "TokenCapture" ALTER COLUMN "rawPayload" DROP NOT NULL;
ALTER TABLE "TokenCapture" ADD COLUMN "poolsObserved" INTEGER;
ALTER TABLE "TokenCapture" ADD COLUMN "buys24hObserved" INTEGER;
ALTER TABLE "TokenCapture" ADD COLUMN "sells24hObserved" INTEGER;

-- CreateTable
CREATE TABLE "TokenPoolCapture" (
    "id" TEXT NOT NULL,
    "captureId" TEXT NOT NULL,
    "poolAddress" TEXT NOT NULL,
    "poolName" TEXT,
    "dexId" TEXT,
    "reserveInUsd" DECIMAL(38,2),
    "volume24hUsd" DECIMAL(38,2),
    "buys24h" INTEGER,
    "sells24h" INTEGER,
    "buyers24h" INTEGER,
    "sellers24h" INTEGER,
    "poolCreatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenPoolCapture_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TokenPoolCapture_captureId_fkey"
        FOREIGN KEY ("captureId") REFERENCES "TokenCapture"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TokenHolderCapture" (
    "id" TEXT NOT NULL,
    "captureId" TEXT NOT NULL,
    "holdersCount" INTEGER,
    "top10Pct" DECIMAL(9,4),
    "rank11to20Pct" DECIMAL(9,4),
    "rank21to40Pct" DECIMAL(9,4),
    "restPct" DECIMAL(9,4),
    "sourceLastUpdated" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenHolderCapture_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TokenHolderCapture_captureId_fkey"
        FOREIGN KEY ("captureId") REFERENCES "TokenCapture"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "TokenPoolCapture_captureId_poolAddress_key"
    ON "TokenPoolCapture"("captureId", "poolAddress");

-- CreateIndex
CREATE INDEX "TokenPoolCapture_captureId_idx"
    ON "TokenPoolCapture"("captureId");

-- CreateIndex
CREATE UNIQUE INDEX "TokenHolderCapture_captureId_key"
    ON "TokenHolderCapture"("captureId");

-- Row Level Security
ALTER TABLE "TokenPoolCapture" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TokenHolderCapture" ENABLE ROW LEVEL SECURITY;

-- Policy: o coletor pode ler e gravar. DELETE fica fora do GRANT abaixo.
CREATE POLICY collector_all ON "TokenPoolCapture"
    FOR ALL
    TO collector
    USING (true)
    WITH CHECK (true);

CREATE POLICY collector_all ON "TokenHolderCapture"
    FOR ALL
    TO collector
    USING (true)
    WITH CHECK (true);

-- Grants para o usuario coletor (sem DELETE, por isso FOR ALL e aceitavel)
GRANT SELECT, INSERT, UPDATE ON "TokenPoolCapture" TO collector;
GRANT SELECT, INSERT, UPDATE ON "TokenHolderCapture" TO collector;
