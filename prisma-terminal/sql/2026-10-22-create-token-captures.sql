-- Fase 6, etapa 1: estrutura do coletor de tokens (GeckoTerminal).
-- Aplicar manualmente no Supabase do terminal. NAO executar via prisma migrate.
-- Mesmo padrao de prisma-terminal/sql/2026-10-18-market-state.sql.
--
-- Confirmar o papel "collector" e a policy "collector_all" contra pg_policies
-- antes de aplicar. Este arquivo nao altera o schema.prisma nem gera client.

-- CreateTable
CREATE TABLE "Token" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'solana',
    "address" TEXT NOT NULL,
    "name" TEXT,
    "symbol" TEXT,
    "decimals" INTEGER,
    "imageUrl" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenCapture" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "priceUsd" DECIMAL(38,18) NOT NULL,
    "liquidityUsd" DECIMAL(38,2),
    "volume24hUsd" DECIMAL(38,2),
    "txCount24h" INTEGER,
    "rawPayload" JSONB NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenCapture_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TokenCapture_tokenId_fkey"
        FOREIGN KEY ("tokenId") REFERENCES "Token"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TokenCollectionFailure" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT,
    "tokenAddress" TEXT,
    "operation" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "retryAfterSeconds" INTEGER,
    "errorMessage" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenCollectionFailure_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TokenCollectionFailure_tokenId_fkey"
        FOREIGN KEY ("tokenId") REFERENCES "Token"("id")
        ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Token_network_address_key" ON "Token"("network", "address");

-- CreateIndex
CREATE INDEX "Token_symbol_idx" ON "Token"("symbol");

-- CreateIndex
CREATE INDEX "Token_name_idx" ON "Token"("name");

-- CreateIndex
CREATE UNIQUE INDEX "TokenCapture_tokenId_capturedAt_key"
    ON "TokenCapture"("tokenId", "capturedAt");

-- CreateIndex
CREATE INDEX "TokenCapture_tokenId_capturedAt_idx"
    ON "TokenCapture"("tokenId", "capturedAt");

-- CreateIndex
CREATE INDEX "TokenCollectionFailure_tokenAddress_occurredAt_idx"
    ON "TokenCollectionFailure"("tokenAddress", "occurredAt");

-- CreateIndex
CREATE INDEX "TokenCollectionFailure_status_occurredAt_idx"
    ON "TokenCollectionFailure"("status", "occurredAt");

-- CreateIndex
CREATE INDEX "TokenCollectionFailure_tokenId_idx"
    ON "TokenCollectionFailure"("tokenId");

-- Row Level Security
ALTER TABLE "Token" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TokenCapture" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TokenCollectionFailure" ENABLE ROW LEVEL SECURITY;

-- Policy: o coletor pode ler e gravar. DELETE fica fora do GRANT abaixo.
CREATE POLICY collector_all ON "Token"
    FOR ALL
    TO collector
    USING (true)
    WITH CHECK (true);

CREATE POLICY collector_all ON "TokenCapture"
    FOR ALL
    TO collector
    USING (true)
    WITH CHECK (true);

CREATE POLICY collector_all ON "TokenCollectionFailure"
    FOR ALL
    TO collector
    USING (true)
    WITH CHECK (true);

-- Grants para o usuário coletor (sem DELETE, por isso FOR ALL é aceitável)
GRANT SELECT, INSERT, UPDATE ON "Token" TO collector;
GRANT SELECT, INSERT, UPDATE ON "TokenCapture" TO collector;
GRANT SELECT, INSERT, UPDATE ON "TokenCollectionFailure" TO collector;
