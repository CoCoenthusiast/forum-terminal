# forum-terminal

Data collection scripts and indicator tests for the SOL terminal.

## What it is

This repository contains only the terminal data pipeline:

- `scripts/terminal/` — collectors, persistence helpers, quality checks, indicator
  formulas and the automated tests that do not touch the database.
- `prisma-terminal/` — the Prisma schema for the terminal database and the SQL used
  to initialize it.
- `.github/workflows/collect-terminal.yml` — manual workflow that runs the collectors.

It is intentionally isolated from any application or forum code.

## Requirements

- Node.js 20+
- A PostgreSQL database (only needed to run collectors or database-backed tests)

## Setup

```bash
npm install
npx prisma generate --schema prisma-terminal/schema.prisma
```

`prisma generate` writes the client to `scripts/terminal/generated/`, which is not
tracked by git.

## Configuration

The code reads the database connection from the `TERMINAL_DATABASE_URL` environment
variable. No connection string is stored in this repository.

Remote databases are rejected unless `GITHUB_ACTIONS=true` (used by the workflow) or
`TERMINAL_ALLOW_REMOTE=1` is set. Database-backed tests read `TEST_DATABASE_URL` and
only accept a local instance on port `5433`.

```bash
export TERMINAL_DATABASE_URL="postgresql://user:pass@localhost:5433/terminal"
```

## Scripts

- `npm run collect:coingecko` — collect market data from CoinGecko.
- `npm run collect:defillama` — collect chain metrics from DefiLlama.
- `npm run backfill` — backfill historical price and metric series.
- `npm run report:quality` — print a data quality report.
- `npm test` — run the tests that do not require a database.
- `npm run test:dailyclose` and `npm run test:quality:db` — database-backed tests
  (local port `5433` only).
- `npm run typecheck` — type-check the sources.

## Database schema

The schema lives in `prisma-terminal/schema.prisma`. `prisma-terminal/init.sql` is the
plain SQL equivalent for initializing an empty database. Migrations are applied
manually by a maintainer; this repository does not run them automatically.
