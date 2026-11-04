-- Alinha a tabela existente "TokenCollectionFailure" ao formato definido em
-- prisma-terminal/sql/2026-10-22-create-token-captures.sql e no schema.prisma.
-- Aplicar manualmente. Nao executar via prisma migrate.

BEGIN;

-- Impede escritas concorrentes enquanto o formato e verificado e alterado.
LOCK TABLE "TokenCollectionFailure" IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM "TokenCollectionFailure") THEN
        RAISE EXCEPTION 'TokenCollectionFailure must be empty; aborting without changes';
    END IF;
END
$$;

-- Colunas do formato correto, na mesma ordem do CREATE TABLE de 2026-10-22.
ALTER TABLE "TokenCollectionFailure"
    ADD COLUMN "tokenId" TEXT,
    ADD COLUMN "tokenAddress" TEXT,
    ADD COLUMN "operation" TEXT NOT NULL,
    ADD COLUMN "endpoint" TEXT NOT NULL,
    ADD COLUMN "status" TEXT NOT NULL,
    ADD COLUMN "httpStatus" INTEGER,
    ADD COLUMN "retryAfterSeconds" INTEGER,
    ADD COLUMN "errorMessage" TEXT,
    ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Remove o formato antigo.
ALTER TABLE "TokenCollectionFailure"
    DROP COLUMN "network",
    DROP COLUMN "address",
    DROP COLUMN "reason",
    DROP COLUMN "statusCode",
    DROP COLUMN "payload",
    DROP COLUMN "failedAt";

-- Chave estrangeira para "Token"(id), preservando RLS, policy e permissoes.
ALTER TABLE "TokenCollectionFailure"
    ADD CONSTRAINT "TokenCollectionFailure_tokenId_fkey"
    FOREIGN KEY ("tokenId") REFERENCES "Token"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Indices definidos no schema.prisma e no CREATE TABLE de 2026-10-22.
CREATE INDEX "TokenCollectionFailure_tokenAddress_occurredAt_idx"
    ON "TokenCollectionFailure"("tokenAddress", "occurredAt");

CREATE INDEX "TokenCollectionFailure_status_occurredAt_idx"
    ON "TokenCollectionFailure"("status", "occurredAt");

CREATE INDEX "TokenCollectionFailure_tokenId_idx"
    ON "TokenCollectionFailure"("tokenId");

COMMIT;

-- Conferencia:
-- \d "TokenCollectionFailure"
-- SELECT COUNT(*) FROM "TokenCollectionFailure";
