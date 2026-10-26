-- MacroObservation: séries macro com data de referência, publicação e revisões.
-- Aplicar manualmente no Supabase, um bloco por vez.
-- NÃO aplicar via prisma migrate/db push.

-- 1) Criar tabela
CREATE TABLE IF NOT EXISTS "MacroObservation" (
    "id" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "refDate" DATE NOT NULL,
    "value" DECIMAL(38,8),
    "status" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "collectedAt" TIMESTAMP(3) NOT NULL,
    "revisionNote" TEXT,

    CONSTRAINT "MacroObservation_pkey" PRIMARY KEY ("id")
);

-- 2) Criar índices
CREATE UNIQUE INDEX IF NOT EXISTS "MacroObservation_seriesId_refDate_collectedAt_key"
    ON "MacroObservation"("seriesId", "refDate", "collectedAt");

CREATE INDEX IF NOT EXISTS "MacroObservation_seriesId_refDate_firstSeenAt_idx"
    ON "MacroObservation"("seriesId", "refDate", "firstSeenAt");

-- 3) Habilitar RLS
ALTER TABLE "MacroObservation" ENABLE ROW LEVEL SECURITY;

-- 4) Policy collector_all e grants (somente SELECT, INSERT e UPDATE)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'MacroObservation'
          AND policyname = 'collector_all'
    ) THEN
        CREATE POLICY collector_all ON "MacroObservation"
            FOR ALL
            TO collector
            USING (true)
            WITH CHECK (true);
    END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE ON "MacroObservation" TO collector;
