-- Etapa C: tabela de estado de mercado (SOL State) persistido.
-- Aplicar manualmente no Supabase (banco do terminal). NÃO aplicar via prisma migrate.
-- Mesmo padrão de prisma-terminal/init.sql e sql/2026-10-16-daily-close-correction.sql.
--
-- Confirmar papel e policy contra pg_policies antes de aplicar. O papel "collector"
-- e a policy "collector_all" abaixo seguem o padrão do plano e podem divergir do banco.

-- CreateTable
CREATE TABLE "MarketState" (
    "id" TEXT NOT NULL,
    "asOf" DATE NOT NULL,
    "stateVersion" TEXT NOT NULL,
    "rulesVersion" TEXT NOT NULL,
    "computeMode" TEXT NOT NULL,
    "dataQualityScore" DECIMAL(6,5) NOT NULL,
    "oldestDataDate" DATE,
    "payload" JSONB NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MarketState_asOf_stateVersion_rulesVersion_computeMode_key"
    ON "MarketState"("asOf", "stateVersion", "rulesVersion", "computeMode");

-- CreateIndex
CREATE INDEX "MarketState_stateVersion_asOf_idx" ON "MarketState"("stateVersion", "asOf");

-- Row Level Security
ALTER TABLE "MarketState" ENABLE ROW LEVEL SECURITY;

CREATE POLICY collector_all ON "MarketState"
    FOR ALL
    TO collector
    USING (true)
    WITH CHECK (true);

-- Grants para o usuário coletor (sem DELETE, por isso FOR ALL é aceitável)
GRANT SELECT, INSERT, UPDATE ON "MarketState" TO collector;
