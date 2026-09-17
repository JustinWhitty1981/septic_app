# AGENTS.md — the mental model

A short orientation for an AI agent (or a new human) picking this repository up cold. The long
form lives in `docs/`; everything here is a summary of something under test.

## What this is

A septic-pump-out business in one Postgres: a **driver PWA** (routes, arrival, completion → the
regulatory ledger) and an **office web app** (scheduling, billing, compliance, accounts
receivable). It can be deployed completely blank, and it also carries the migration machinery
for companies arriving from an Access/Click-Once export.

**The four sources of truth, and which wins:**

| File | It is | Authority |
|---|---|---|
| `docs/REQUIREMENTS.md` | Every requirement as one table row; ✅ rows say *how it was verified*. | **Highest.** Prose-justified, test-policed (`requirements.todo.test.ts` parses it and fails the build when prose and status disagree, or when §9 counts drift). |
| `docs/DATA_MODEL.md` | Schema *design*, with `> **As-built (00xx).**` notes where reality superseded it. | Design intent. Check the as-built notes before trusting a table shape. |
| `docs/TEST_PLANS.md` | One section per requirement: what will be asserted and how it could fail. Written **before** implementing. | The intent of each test. |
| `README.md` + backend `README.md` | Commands, architecture notes, endpoint tables. | Operations. `repo-hygiene.test.ts` fails the build if routes and the README table disagree, in either direction. |

The test suite **parses the documentation** and asserts it agrees with the database and the
routes. The docs are not comments; they are under test.

## Run everything (the only correct invocations)

```bash
docker compose up -d --build
docker compose exec backend npm run migrate
docker compose exec backend  npm test
docker compose exec frontend npm test            # must be npm test — see below
docker compose --profile e2e run --rm e2e        # playwright smoke; needs the stack up
docker compose restart backend                   # backend watcher misses in-place writes
```

- **Never run the frontend suite with bare `npx jest`**: CRA's babel preset needs `NODE_ENV=test`,
  which only `react-scripts test` sets. The failure mode is "every TS file is a syntax error" —
  it reads like broken code and is not.
- The service worker must not run in development (`registration.ts` gates it on `NODE_ENV`): the
  dev bundle has a fixed filename and the shell cache is cache-first, so an un-gated worker serves
  a stale app forever.
- Rebuild the backend image after touching `backend/package.json`, *before* any `down -v`, or new
  volumes will lack the new deps.
- **HTTPS is a deployment concern with files in this repo**: `docker-compose.https.yml` +
  `docker/nginx/` front the stack with TLS; a PWA is not installable and the service worker does
  not exist without a certificate the devices trust.

## Postgres facts that will bite you

- `business_today()` is the clock, not `current_date()`. Released installs answer in
  **America/Chicago**, not the container's UTC. Everything date-relative goes through the
  function, never `now()`; a test that needs the two clocks to disagree pins `as_of_date`
  **inside a transaction** and rolls it back — never by refreezing the shared calendar.
- **Applied migrations are immutable** (NF-05). `scripts/migrate.ts` sha256-guards every applied
  file; edit one and the build fails *by design*. Fix forward. A migration that must run outside
  a transaction (`ALTER TYPE ADD VALUE`) takes the header `-- runner: no-transaction`.
- The ledger is **append-only**: `guard_append_only()` on `service_events`, `payments`,
  `job_notes`. Test teardown escape: `BEGIN; SET LOCAL septic.ledger_repair='on'; DELETE …;
  COMMIT`. Never reach for it outside a fixture.
- `invoices` header columns are frozen by a row trigger: only `amount_paid` and `status` may
  change on an existing invoice.
- Schema invariants the tests re-assert every run (`tests/schema-invariants.test.ts`): no app-row
  service event without a disposal site; `amount_paid` in step with the receipts; `amount_paid ≤
  total`; computed due-queue columns are `ALWAYS GENERATED`.

## The one TypeORM rule

`AppDataSource.query()` is not uniform, and this has caused real bugs:

- `SELECT` / `INSERT … RETURNING` → `rows[]`
- `UPDATE` / `DELETE … RETURNING` → `[rows, rowCount]`

When in doubt, run a separate `SELECT` afterwards.

## Domain machines

**A driver's day.** `pending → arrived → done | no_access | skipped`, server-stamped
(`completed_at` only for `done`; `resolved_at` for any terminal state). **`done` requires
`disposal_site_id`** — the county report is assembled per site, and the vocabulary must be
reachable: `GET /api/disposal-sites` exists so the driver can satisfy the rule. The last
resolved stop flips the route to `done` and the day view stops publishing it — the PWA reads
that post-write 404 as *Day closed*, never as a failed reload.

**The offline queue** (`frontend/src/offline/`). Bare status codes get four verdicts:
`400/404/409` = refused on its facts → **drop** and re-read the day (the server owns the day);
`401/403` = refused on identity → park the queue, keep the work; `5xx/transport` = undecided →
back off and retry. A queued write never carries a `version` and never carries server-owned
fields.

**Money.** A payment is a receipt row; `invoices.amount_paid` is **re-summed** from receipt rows
on every write — never incremented. `partial` status is derived. Receivables are computed per
request, never stored. Refunds are adjustment documents, never negative receipts. Overpayment is
refused by naming the balance.

**Corrections, everywhere: new rows, never edits.** Adjustments link to the original (linear
chain); ownership changes close one row and open another; ledger corrections are new events. If
a feature wants to UPDATE history, the feature is wrong.

## Tests: the four kinds, and the traps

`septic-app/backend/tests/` — `describe` names carry requirement IDs (`T-DRV-07b: …`) and that is
load-bearing: the doc tests map them.

1. **Behavioural/API** against the live dev DB. `@test.invalid` emails, created rows tracked and
   deleted in `afterAll`. A crashed run that skips teardown leaks rows that fail the
   reconciliation suites on someone else's machine.
2. **Doc tests** — `requirements.todo.test.ts` (REQUIREMENTS rows ↔ statuses ↔ §9 counts ↔
   `it.todo` list), `repo-hygiene.test.ts` (routes ↔ README both ways, secret scanner). When you
   ship a route: mount it in `src/routes/index.ts` (route discovery only sees the mount graph),
   add the README row, and add it to `office-gate.test.ts` — which pins **both** directions.
3. **Reconciliation** — `etl.test.ts`, `schema-invariants.test.ts`: properties of migrated
   corpora (loaded + quarantined = source, no drift). They share the DB with API tests, which is
   why cleanup is sacred.
4. **Drift** — `entity-schema.test.ts` (TypeORM metadata ↔ actual columns),
   `migration-integrity.test.ts` (sha guards).

**Blank-database honesty.** The suite must pass on a fresh install *and* on a migrated corpus.
`tests/bootstrap.ts` (jest globalSetup) seeds a consistent fixture world — properties, sites,
tanks, an invoice book, a quarantine queue — guarded so it is a no-op wherever real history
exists; the corpus-only suites (ETL, landing, quarantine) skip themselves when the legacy CSVs
are absent. Never fix a blank-DB failure by assuming the corpus.

Frontend suites run via `npm test` inside the container; jsdom has no IndexedDB/service worker
(the offline tests drive the queue through its injected store), and `window.print` must be stubbed.

## House style

- Comments state **why**, in prose a reviewer in six months can act on — including the
  measurement that killed a wrong assumption.
- A refusal message names the thing the caller needs next (a balance, the other route's name,
  the site the ledger already has today).
- Errors never leak schema (`NF-11`).
- Money stays `numeric`; the server owns every clock-written field.
- Sorting is a whitelist (`utils/sort.ts` backend, `src/sort.tsx` frontend); a refused `?sort=`
  names the columns it does accept.

## Layout

```
docs/                     REQUIREMENTS / DATA_MODEL / TEST_PLANS
etl/                      legacy exports → landing schema (etl/legacy) → septic_app
docker/                   postgres init · nginx TLS overlay (+ certs/README)
septic-app/
  backend/  src/{controllers,routes,middleware,config} · db/migrations (append-only!)
            scripts/{migrate,seed-user}.ts · tests/ (the four kinds above)
  frontend/ src/{components,services,hooks,offline}     CRA, MUI, one PWA, both roles
e2e/                      playwright smoke (profile: e2e)
scripts/audit-secrets.sh  host-side secret scan (self-tested by repo-hygiene)
```
