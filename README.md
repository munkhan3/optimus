# Goal OS

A personal operating system that translates long-term intent into today's actions,
measures whether those actions produced progress, and updates its model of how you
actually work so each plan is more honest than the last.

Single user. The design document is [`vision.md`](vision.md); it is the source of
truth, and where the code departs from it the departure is marked and explained.

## What makes it different

Most planning tools do forward compilation — goal into tasks. The value here is in
**backward propagation** (§14): a page read this morning updates `pace_hat`, which
moves the projected completion date, which moves milestone status, which moves goal
feasibility. Nothing is ever manually marked "on track".

Three properties are load-bearing:

- **No fabricated numbers.** Where a value cannot be measured it is labelled as an
  estimate or returned as absent. An unknown feasibility is `null`, never `true`.
- **Every recommendation decomposes.** Each plan item stores the full component
  breakdown that produced its score, and the UI renders it on tap.
- **The plan does not thrash.** Ranking happens weekly and is frozen; days
  redistribute what remains without re-scoring.

## Running it

Requires PostgreSQL and [uv](https://docs.astral.sh/uv/).

```bash
brew install postgresql@17 uv && brew services start postgresql@17
createdb goalos && createdb goalos_test

uv sync
uv run alembic upgrade head

cat > .env.local <<'ENV'
GOALOS_AUTH_TOKEN=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')
GOALOS_DATABASE_URL=postgresql+psycopg://localhost/goalos
ENV

uv run uvicorn goalos.api.main:app --port 8077 --reload
```

Frontend, in a second shell:

```bash
cd frontend && npm install && npm run dev     # dev server, proxies /api
cd frontend && npm run build                  # or build once; FastAPI serves dist/
```

The assistant and ingestion need `GOALOS_ANTHROPIC_API_KEY` in `.env.local`. Without
it those two endpoints return 503 rather than degrading silently.

## Tests

```bash
uv run pytest                  # everything
uv run pytest tests/metrics    # pure engine, no database, <1s
uv run pytest tests/acceptance # vision.md §29 — the definition of done
```

All 18 acceptance criteria from §29 are enforced. Twelve are provable from the pure
engine; six are claims about persistence and run against real Postgres, because that
is where they are enforced — the `completed_units` trigger, the partial unique
indexes on `baseline`, and the JSONB check on `score_breakdown`.

## Layout

```
goalos/metrics/   pure engine — stdlib only, no framework, no database
goalos/api/       FastAPI, SQLModel, the repo layer that bridges to the engine
goalos/api/llm/   ingestion + the nine read-only assistant tools
frontend/         React + Vite + Tailwind, mobile-first
config.toml       every hand-set constant from vision.md
```

`goalos/metrics/` imports nothing outside the standard library, enforced by an AST
test rather than by discipline. That is what keeps the engine testable without a
database and free of hidden reads.

## Deploying

```bash
fly launch --no-deploy
fly postgres create && fly postgres attach <name>
fly secrets set GOALOS_AUTH_TOKEN=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')
fly secrets set GOALOS_ANTHROPIC_API_KEY=sk-ant-...
fly deploy
```

Migrations run as the release command, before new machines take traffic.

**The token is the only thing between the internet and this data.** Generate it with
`secrets.token_urlsafe(32)`, keep it in Fly secrets, and never commit it.

## Status

v0 (`vision.md` Part III) is implemented: goal graph, session logging, the metrics
engine, weekly ranking, rebaselining with permanent baseline history, daily
redistribution, and the read-only assistant.

Not yet exercised against the live Anthropic API — the ingestion and chat endpoints
are written and unit-tested around the model call, but the call itself needs a key.
