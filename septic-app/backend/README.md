# Septic App — Backend API

Express + TypeORM API over the `septic_app` schema. Read the repo-root `README.md` first, and
**[docs/DATA_MODEL.md](../../docs/DATA_MODEL.md)** before touching the schema.

> **This file was rewritten on 2026-08-31.** The previous revision described the original
> scaffold: `npm run migration:run` (no such script), `../scripts/seed.ts` (no such file), default
> logins for `admin@`/`manager@`/`tech@` (never seeded), a "10 core tables" list containing
> `customers`, `appointments`, `inventory_items`, `suppliers`, `purchase_orders` and
> `wisconsin_state_reports` (**all deliberately deleted**, DATA_MODEL §12), and a role named
> `technician` (renamed `driver`). Its "Database Schema" section listed eleven tables, and **eight of
> them do not exist** — only `users`, `service_types` and `invoices` survived the redesign. It named
> **5 of the 24 routes** the server actually mounts. Every claim in it
> was stale; nothing in it was safe to follow.

## Run it

Nothing runs on the host. From the **repo root**:

```bash
docker compose up -d --build
docker compose exec backend npm run migrate
docker compose exec backend npx tsc --noEmit
docker compose exec backend npm test
```

`npm run dev` uses `ts-node-dev --respawn`; the source is bind-mounted and hot-reloads.
The server listens on `:3001` and mounts everything under `/api`.

## Scripts

| Script | What it does |
|---|---|
| `dev` | ts-node-dev, respawn on change |
| `build` / `start` | `tsc` → `node dist/server.js` |
| `test` | jest |
| `migrate` | apply pending migrations |
| `migrate:status` | applied / pending |
| `seed:user` | create one login (see below) |

There is **no** `migration:generate` and **no** `migration:run`. Migrations are versioned raw SQL
in `db/migrations/`, applied by `scripts/migrate.ts`, recorded with a sha256, and immutable once
applied. The server does not migrate at boot — it checks and warns. See the root README.

```bash
docker compose exec backend npm run seed:user -- \
  --email=driver@septic.test --role=driver --first=Al --last=Driver
```

The role must be `admin|manager|driver|office`. There is no seeded password anywhere: omit
`--password` and a strong one is generated and printed once. Putting default credentials in a
README is how they end up in production.

## API surface

`OFFICE` in the routes below is `['admin','manager','office']`. Reads are open to any
authenticated user; writes are not.

One row per route, with the full path spelled out. `tests/repo-hygiene.test.ts` parses
`src/routes/` and fails if a route exists here that is not in this table, so the table cannot fall
behind the router the way it did last time.

| Method | Path | Auth |
|---|---|---|
| `POST` | `/api/auth/register` | public |
| `POST` | `/api/auth/login` | public |
| `POST` | `/api/auth/logout` | any |
| `GET` | `/api/auth/me` | any |
| `GET` | `/api/health` | public |
| `GET` | `/api/properties` | any |
| `GET` | `/api/properties/search` | any |
| `GET` | `/api/properties/due-queue` | any |
| `POST` | `/api/properties` | OFFICE — add a site (SCH-11); ledger-owned columns are refused by name |
| `GET` | `/api/properties/:id` | any |
| `PATCH` | `/api/properties/:id` | OFFICE — whitelisted edit (SCH-11); no DELETE on this surface, retire via `status` |
| `POST` | `/api/properties/:id/due-adjustments` | OFFICE — overlay a disputed due date (SCH-16); reason required, past dates refused toward LED-01 |
| `DELETE` | `/api/properties/:id/due-adjustments` | OFFICE — close the open adjustment; the generated date stands again |
| `POST` | `/api/properties/:id/owners` | OFFICE |
| `GET` | `/api/quarantine` | any |
| `GET` | `/api/quarantine/families` | any |
| `POST` | `/api/quarantine/:id/resolve` | OFFICE |
| `POST` | `/api/quarantine/:id/unresolve` | OFFICE |
| `GET` | `/api/routes` | any |
| `GET` | `/api/routes/drivers` | any |
| `GET` | `/api/routes/:id` | any |
| `POST` | `/api/routes` | OFFICE |
| `POST` | `/api/routes/:id/stops` | OFFICE |
| `POST` | `/api/routes/stops` | OFFICE — add a site to a driver's day by `(driver_id, route_date)`, creating the draft if the day does not exist (SCH-13) |
| `PATCH` | `/api/routes/:id/stops` | OFFICE (reorder) |
| `DELETE` | `/api/routes/:id/stops/:stopId` | OFFICE |
| `POST` | `/api/routes/:id/publish` | OFFICE |
| `POST` | `/api/routes/:id/unpublish` | OFFICE |
| `GET` | `/api/disposal-sites` | any — `done` names one, so the driver must be able to read the list; the company default is marked `is_default`, and `events_using` counts what the ledger names |
| `POST` | `/api/disposal-sites` | OFFICE — add to the vocabulary (LED-07) |
| `PATCH` | `/api/disposal-sites/default` | OFFICE |
| `PATCH` | `/api/disposal-sites/:id` | OFFICE — rename/annotate (LED-07); the ledger follows the id, not the name |
| `DELETE` | `/api/disposal-sites/:id` | OFFICE — only while nothing names it; the ledger's sites are renamed, not deleted (LED-07) |
| `GET` | `/api/dispatch/today` | any |
| `PATCH` | `/api/dispatch/stops/:id/status` | any, **own route only** |
| `POST` | `/api/users` | admin only |
| `PATCH` | `/api/users/:id` | admin only |
| `POST` | `/api/users/:id/password` | admin only — reset a password; the account's live sessions die with it (AUT-11 epoch), and there is no email-based forgot-password: no employee mail exists |
| `GET` | `/api/ledger/events` | OFFICE |
| `GET` | `/api/ledger/unbilled-events` | OFFICE — the billing queue (BIL-19); heads-only, unbilled-only, sortable |
| `GET` | `/api/ledger/lookups` | OFFICE |
| `GET` | `/api/ledger/report` | OFFICE |
| `POST` | `/api/ledger/events` | any — file unscheduled work (DRV-20); server owns date and pumper, disposal site required |
| `POST` | `/api/ledger/:id/correct` | OFFICE |
| `GET` | `/api/invoices` | OFFICE |
| `GET` | `/api/invoices/:id` | OFFICE |
| `POST` | `/api/invoices` | OFFICE — create an invoice (BIL-20); every line names a service event, a price-list item, or a legacy product; the server owns every total |
| `POST` | `/api/invoices/:id/adjust` | OFFICE |
| `POST` | `/api/invoices/:id/payments` | OFFICE |
| `GET` | `/api/receivables` | OFFICE |
| `GET` | `/api/payers` | OFFICE |
| `POST` | `/api/payers` | OFFICE — add a biller from a form (SCH-12); typing into search creates nothing |

### Bids — the price list, the document, the signature (BIL-09..16)

| Method | Path | Gate |
|---|---|---|
| `GET` | `/api/settings` | any — the system-wide sales tax is public arithmetic (BIL-16) |
| `PATCH` | `/api/settings/sales-tax` | OFFICE — set the rate (a decimal, not a percent; the refusal teaches the difference) |
| `PATCH` | `/api/settings/payment-terms` | OFFICE — set the net-days and the monthly late fee the invoice prints (BIL-08) |
| `PATCH` | `/api/settings/company` | OFFICE — the letterhead every invoice and bid prints: name, logo (a `media` id, bytes via `/api/media/upload`), address, email, phone (BIL-08/BIL-15) |
| `GET` | `/api/bid-items` | any — the master price list; `?include_retired=1` for the whole history (BIL-09) |
| `POST` | `/api/bid-items` | OFFICE — add an item (name, unit, price) |
| `PATCH` | `/api/bid-items/:id` | OFFICE — edit a price or retire an item; retirement is the delete this table allows |
| `GET` | `/api/bids` | any — `?status=&payer_id=` (BIL-10) |
| `GET` | `/api/bids/:id` | any — bid, lines, and the payer's mailing block in one response |
| `POST` | `/api/bids` | OFFICE — open a draft for a payer (dated by the server) |
| `POST` | `/api/bids/:id/lines` | OFFICE — copy a line from the price list, or add a one-off line |
| `PATCH` | `/api/bids/:id/lines/:lineId` | OFFICE — draft only; a signature does not accept edits (BIL-12) |
| `DELETE` | `/api/bids/:id/lines/:lineId` | OFFICE — draft only |
| `POST` | `/api/bids/:id/approve` | OFFICE — the signature: stamps who, when, and the tax rate of the instant (BIL-12/16) |
| `POST` | `/api/bids/:id/decline` | OFFICE — terminal, with an optional note |
| `POST` | `/api/bids/:id/convert` | OFFICE — one invoice per bid ever, in one transaction (BIL-13) |
| `GET` | `/api/properties/:id/owners` | OFFICE |
| `GET` | `/api/users` | admin only |
| `POST` | `/api/media/upload` | any |
| `GET` | `/api/media/:id` | any |
| `GET` | `/api/media/:id/raw` | any |
| `POST` | `/api/notes` | any |
| `GET` | `/api/notes` | any |

`PATCH /api/dispatch/stops/:id/status` is the endpoint the driver's phone writes to. It is not
role-gated: it compares the route's `driver_id` to the id in the token and answers 404 — the same
answer it gives for a stop that does not exist — when they differ. It accepts a `client_uuid` so an
offline replay is idempotent, refuses a body that tries to set a server-owned column, and rejects
transitions the status machine disallows rather than coercing them.

**Not built yet:** `job_notes` and `media` have tables but no entity, route or controller — so a
driver still cannot record a note or a photo. That gap is what holds DRV-12 open.

## Structure

```
src/
├── config/       # database + auth config
├── controllers/  # request handlers
├── middleware/   # authenticate, authorize, errors
├── models/       # 20 TypeORM entities across 16 files + enums
├── routes/       # auth, properties, quarantine, routes, dispatch
├── services/
└── server.ts
db/
├── migrations/   # versioned raw SQL (source of truth)
└── dev/          # fixture + verify_schema.sql
tests/            # 17 jest suites
```

Entities **describe** columns; migrations own how a table is built, and
`tests/entity-schema.test.ts` fails the build when the two disagree. Generating SQL from the
entities would lose generated columns, views and partial unique indexes.

## Tests

```bash
docker compose exec backend npm test
```

`jest.config.js` pins `maxWorkers: 1`. That is a correctness fix, not a tuning knob — see the
comment in that file and the test-reliability note in docs/REQUIREMENTS.md.

The suite writes to the dev database and is **not** read-only. Do not run it against data you care
about.

Requirements not yet built are `it.todo`, so `npm test` output doubles as the build checklist — see
[docs/REQUIREMENTS.md](../../docs/REQUIREMENTS.md).
