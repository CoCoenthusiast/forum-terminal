-- Etapa B: tabela de auditoria de correções de DailyClose.
-- Gerado com:
--   git show HEAD:prisma-terminal/schema.prisma > /tmp/schema-old.prisma
--   npx prisma migrate diff \
--     --from-schema-datamodel /tmp/schema-old.prisma \
--     --to-schema-datamodel prisma-terminal/schema.prisma --script
-- A FK da tabela nova foi incorporada ao CREATE TABLE (chave da própria tabela)
-- para não emitir ALTER TABLE.

-- CreateTable
CREATE TABLE "DailyCloseCorrection" (
    "id" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "oldCloseUsd" DECIMAL(38,18) NOT NULL,
    "newCloseUsd" DECIMAL(38,18) NOT NULL,
    "oldCalcMethod" TEXT NOT NULL,
    "newCalcMethod" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "dailyCloseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyCloseCorrection_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DailyCloseCorrection_dailyCloseId_fkey" FOREIGN KEY ("dailyCloseId") REFERENCES "DailyClose"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "DailyCloseCorrection_asset_date_idx" ON "DailyCloseCorrection"("asset", "date");

-- CreateIndex
CREATE INDEX "DailyCloseCorrection_dailyCloseId_idx" ON "DailyCloseCorrection"("dailyCloseId");

-- GRANT necessário ao usuário collector (confira os privilégios já existentes):
--   GRANT SELECT, INSERT ON "DailyCloseCorrection" TO collector;
--
-- Nota: o collector também precisa de UPDATE em "DailyClose", pois a correção
-- sobrescreve registros existentes. Confira/conceda, se ainda não houver:
--   GRANT UPDATE ON "DailyClose" TO collector;
