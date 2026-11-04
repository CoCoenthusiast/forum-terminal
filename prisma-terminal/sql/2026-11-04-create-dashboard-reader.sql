-- Usuario somente leitura do painel.
-- Aplicar manualmente no Supabase. Nao executar via prisma migrate.
-- O role e criado com LOGIN e sem senha; a senha deve ser definida manualmente
-- fora deste arquivo. Nenhuma senha deve ser registrada neste SQL nem em logs.

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_roles
        WHERE rolname = 'dashboard_reader'
    ) THEN
        CREATE ROLE dashboard_reader
            LOGIN
            NOSUPERUSER
            NOCREATEDB
            NOCREATEROLE
            NOBYPASSRLS
            CONNECTION LIMIT 5;
    END IF;
END
$$;

ALTER ROLE dashboard_reader SET default_transaction_read_only = on;
ALTER ROLE dashboard_reader SET statement_timeout = '10s';

GRANT USAGE ON SCHEMA public TO dashboard_reader;

-- Somente leitura nas 12 tabelas do painel.
GRANT SELECT ON TABLE
    "CollectionLog",
    "DailyClose",
    "DataSource",
    "IndicatorSnapshot",
    "MacroObservation",
    "MarketSnapshot",
    "MarketState",
    "MetricSnapshot",
    "Token",
    "TokenCapture",
    "TokenHolderCapture",
    "TokenPoolCapture"
TO dashboard_reader;

-- Policies de leitura, no mesmo formato das policies do collector.
DROP POLICY IF EXISTS dashboard_reader_select ON "CollectionLog";
CREATE POLICY dashboard_reader_select ON "CollectionLog"
    FOR SELECT TO dashboard_reader USING (true);

DROP POLICY IF EXISTS dashboard_reader_select ON "DailyClose";
CREATE POLICY dashboard_reader_select ON "DailyClose"
    FOR SELECT TO dashboard_reader USING (true);

DROP POLICY IF EXISTS dashboard_reader_select ON "DataSource";
CREATE POLICY dashboard_reader_select ON "DataSource"
    FOR SELECT TO dashboard_reader USING (true);

DROP POLICY IF EXISTS dashboard_reader_select ON "IndicatorSnapshot";
CREATE POLICY dashboard_reader_select ON "IndicatorSnapshot"
    FOR SELECT TO dashboard_reader USING (true);

DROP POLICY IF EXISTS dashboard_reader_select ON "MacroObservation";
CREATE POLICY dashboard_reader_select ON "MacroObservation"
    FOR SELECT TO dashboard_reader USING (true);

DROP POLICY IF EXISTS dashboard_reader_select ON "MarketSnapshot";
CREATE POLICY dashboard_reader_select ON "MarketSnapshot"
    FOR SELECT TO dashboard_reader USING (true);

DROP POLICY IF EXISTS dashboard_reader_select ON "MarketState";
CREATE POLICY dashboard_reader_select ON "MarketState"
    FOR SELECT TO dashboard_reader USING (true);

DROP POLICY IF EXISTS dashboard_reader_select ON "MetricSnapshot";
CREATE POLICY dashboard_reader_select ON "MetricSnapshot"
    FOR SELECT TO dashboard_reader USING (true);

DROP POLICY IF EXISTS dashboard_reader_select ON "Token";
CREATE POLICY dashboard_reader_select ON "Token"
    FOR SELECT TO dashboard_reader USING (true);

DROP POLICY IF EXISTS dashboard_reader_select ON "TokenCapture";
CREATE POLICY dashboard_reader_select ON "TokenCapture"
    FOR SELECT TO dashboard_reader USING (true);

DROP POLICY IF EXISTS dashboard_reader_select ON "TokenHolderCapture";
CREATE POLICY dashboard_reader_select ON "TokenHolderCapture"
    FOR SELECT TO dashboard_reader USING (true);

DROP POLICY IF EXISTS dashboard_reader_select ON "TokenPoolCapture";
CREATE POLICY dashboard_reader_select ON "TokenPoolCapture"
    FOR SELECT TO dashboard_reader USING (true);

COMMIT;

-- Conferencia:
-- \du dashboard_reader
-- \dp "CollectionLog" "DailyClose" "DataSource" "IndicatorSnapshot"
-- \dp "MacroObservation" "MarketSnapshot" "MarketState" "MetricSnapshot"
-- \dp "Token" "TokenCapture" "TokenHolderCapture" "TokenPoolCapture"
-- SELECT schemaname, tablename, policyname, roles, cmd, qual
-- FROM pg_policies
-- WHERE policyname = 'dashboard_reader_select'
-- ORDER BY tablename;
