-- TokenCapture: market cap e FDV por captura (GeckoTerminal).
-- Gerado com:
--   npx prisma migrate diff \
--     --from-schema-datamodel /tmp/schema-before-token-market-cap.prisma \
--     --to-schema-datamodel prisma-terminal/schema.prisma --script
-- Ajuste manual: ADD COLUMN IF NOT EXISTS para permitir reaplicação segura.
-- NÃO aplicar via prisma migrate/db push. Aplicar manualmente, se necessário.

-- AlterTable
ALTER TABLE "TokenCapture"
    ADD COLUMN IF NOT EXISTS "marketCapUsd" DECIMAL(38,2),
    ADD COLUMN IF NOT EXISTS "fdvUsd" DECIMAL(38,2);
