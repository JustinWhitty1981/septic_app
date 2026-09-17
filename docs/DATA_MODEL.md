# Target Data Model — Septic App

Schema-first rebuild, derived from the legacy Access / Click-Once export in `data/`.

Status: **approved design, pre-implementation**
Date: 2026-08-28
Source of truth: the 9 CSVs in `data/`, profiled with a real CSV parser. Every table below is
justified against actual rows, not against the pre-build planning transcript (kept off this repo).

---

## 0. Scope

**Primary goal:** drivers on mobile devices see their daily route, and capture notes and photos
at the truck.

**Secondary:** the office gets a real compliance ledger, scheduling, and billing that the legacy
app never delivered.

**Dropped:** inventory, suppliers, purchase orders. 18 endpoints, ~1,000 backend lines, 1,855
frontend lines — and zero rows of legacy data behind any of it.

## 1. Design principles

Each one is forced by evidence, not taste.

| # | Principle | Why |
|---|---|---|
| P1 | **Derived values are never stored as truth** | `Next Service Pump Date` disagrees with `service_date + interval` in 32,396 of 45,804 rows, dominated by a +1-day off-by-one (24,790 occurrences). Storing it bakes in a bug. |
| P2 | **Preserve legacy natural keys** | `Job Site Location` literally reads `'See their house cust #3494'`. Crews identify properties by Cust Number. |
| P3 | **Raw string and parsed structure, both kept** | 4,098 of 7,440 tank sizes are not integers (`'1500w.fltr+800 PC'`). Parse, but never discard the original. |
| P4 | **Controlled vocabulary + free-text note, side by side** | `Type of Waste` has 65 values against a 9-value lookup, and mixes `'Septage+Milkhouse'` with `'Evaluation'` and `'Yucky Stuff'`. |
| P5 | **The service ledger is append-only** | 48,216 rows over 61 years are the regulatory record. Corrections are new rows, not edits. |
| P6 | **Every field-writable row has a `client_uuid`** | Offline-first requires idempotent replay of a queued write. |
| P7 | **Nothing is silently dropped in migration** | A quarantine table records every rejected row with its reason. |
| P8 | **No coordinates exist in the source** | Legacy has zero lat/lng columns. Route sequencing needs geocoding — a separate, additive workstream. |
| P9 | **Image bytes never enter the database** | Object storage only. See §8. |
| P10 | **"Today" is a value, not a call to `current_date`** | The dev snapshot ends 2024-12-02 but the clock says 2026. Using `current_date` inflated the overdue queue from 1,925 to 4,624 when measured on 2026-08-31, and the second number grows every day. See §6.1. |

## 2. Entity map

```
payers ──┐
         ├──< property_ownerships >──┐
                                     ├──< properties >──< tanks
                                     │                  ├──< service_events >──< job_notes
                                     │                  │                    └──< media
                                     │                  ├──< route_stops >── routes ── users ── pumpers
                                     │                  ├──< inspections
                                     └──< invoices ──< invoice_lines
                                            └── service_types (catalog)        └──< payments

lookups: counties · septic_system_types · waste_types · disposal_sites · baffle_materials
config:  app_setting (holds as_of_date -> business_today(), which v_due_queue and
                every date-relative rule read instead of current_date)
```

## 3. People

```sql
CREATE TYPE user_role AS ENUM ('admin','manager','driver','office');

-- App accounts. Created fresh; nothing to migrate. Legacy auth was a single shared
-- plaintext password ("septic", tblSystem) and is deliberately NOT imported.
CREATE TABLE users (
  id             serial PRIMARY KEY,
  email          varchar(255) UNIQUE NOT NULL,
  password_hash  varchar(255) NOT NULL,
  first_name     varchar(100) NOT NULL,
  last_name      varchar(100) NOT NULL,
  role           user_role NOT NULL DEFAULT 'driver',
  pumper_id      int UNIQUE REFERENCES pumpers(id),   -- login <-> certification
  phone          varchar(20),
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- The regulatory identity. Source: tblOwner (7 rows).
-- Separate from users: someone may pump without a login, and office staff
-- have logins but no certification.
CREATE TABLE pumpers (
  id                    serial PRIMARY KEY,
  certification_number  varchar(20) UNIQUE NOT NULL,  -- WI pumper cert, printed on every record
  license_number        varchar(20),                  -- 'SY #602' for all 7
  first_name            varchar(100) NOT NULL,
  last_name             varchar(100) NOT NULL,
  is_active             boolean NOT NULL DEFAULT true,
  legacy_raw_cert       varchar(20)                   -- the '?????' row, kept for audit
);
```

> `tblOwner` cert `0` carries `'?????'` — a SQL Server encoding failure — and appears on invoices as
> `Certification # = '0'`. Import it **inactive** so historical invoices still resolve.

## 4. Places — the hub

```sql
CREATE TYPE property_status AS ENUM ('active','inactive','sealed','unknown');

-- Source: tblCustomers (7,541 rows, 35 cols). MISNAMED in legacy:
-- this is a septic SYSTEM at a SITE, not a person.
CREATE TABLE properties (
  id                       serial PRIMARY KEY,
  legacy_cust_number       int UNIQUE,                 -- P2
  payer_label              varchar(200),               -- 'Eubanks Rental', 'Zommers Property'
  site_address             varchar(255),
  site_city                varchar(100),
  site_state               char(2),                    -- normalized; legacy had 'WI' and 'Wi'
  site_zip                 varchar(10),                -- '54932-' -> '54932'; keep +4 where present
  county_id                int REFERENCES counties(id),
  town                     varchar(100),               -- 131 values
  plss_section             varchar(10),                -- '25SE','6NE' — text, not int
  plss_range               varchar(10),                -- only 6 legacy values; one is '189871'
  parcel_id                varchar(40),                -- 'T06-14-18-06-14-001-00' — 3,550 of 7,541
  permit_number            varchar(30),                -- 5,120 distinct / 5,168 filled -> NOT unique
  system_type_id           int REFERENCES septic_system_types(id),
  tank_location_note       text,                       -- "NW/house - 55'W&10'N - all 3 expd"
  jobsite_location_note    text,                       -- "½ mile South of Cty F - West side"
  baffle_inlet_material_id int REFERENCES baffle_materials(id),
  baffle_inlet_date        date,
  baffle_outlet_material_id int REFERENCES baffle_materials(id),
  baffle_outlet_date       date,
  hose_count               numeric(4,2),               -- legacy '1½' — unicode fraction
  pump_style_note          text,
  pump_installed_date      date,
  chamber_pump_note        text,
  system_condition_note    text,
  service_interval_days    int NOT NULL DEFAULT 1095,  -- P1: the real rule
  last_service_date        date,                       -- maintained by the ledger, not user-entered
  next_service_due         date GENERATED ALWAYS AS
                             (last_service_date + service_interval_days) STORED,
  reminder_opt_out         boolean NOT NULL DEFAULT false,  -- 856 TRUE / 6,685 FALSE
  status                   property_status NOT NULL DEFAULT 'active',
  legacy_memo              text,                       -- P3: 7,427 verbatim, immutable
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_props_due ON properties (next_service_due) WHERE status = 'active';
```

> **`next_service_due` is a generated column.** It cannot drift, cannot be hand-edited into
> inconsistency, and the +1-day legacy bug is not inherited. The 8 malformed legacy next-due dates
> (`8/2/226`, `7/1/316`, `4/1/105`, …) simply do not exist in this model.
>
> `service_interval_days` defaults to 1095 (3 years) because that is the empirical mode:
> 1095d covers 33,170 of 45,816 events (69%), 730d covers 7,027, 365d covers 3,434 — the top three
> account for 91% of all service history.

```sql
CREATE TYPE tank_role AS ENUM ('primary','pre_cleanout','sand_filter','secondary');

-- Solves the multi-tank problem: 4,098 of 7,440 tank strings are composite.
-- '1500w.fltr+800 PC' becomes two rows: (primary,1500,filter) + (pre_cleanout,800).
CREATE TABLE tanks (
  id               serial PRIMARY KEY,
  property_id      int NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  sequence_no      smallint NOT NULL,
  role             tank_role NOT NULL,
  capacity_gallons int CHECK (capacity_gallons > 0),
  has_filter       boolean NOT NULL DEFAULT false,
  raw_text         varchar(100) NOT NULL,   -- '1650 triple' — always preserved (P3)
  UNIQUE (property_id, sequence_no)
);

-- Source: tblBilling (7,572) + tblInspectionDate.PrevOwner* (2,771).
-- Legacy reality: only 118 of 7,572 payers have a phone (1.6%). This is a MAILING
-- ADDRESS, not a contact record — the phones live on the property.
CREATE TABLE payers (
  id              serial PRIMARY KEY,
  legacy_billing_no int UNIQUE,
  org_name        varchar(200),
  first_name      varchar(100),
  last_name       varchar(100),
  email           varchar(255),          -- NULLABLE. Zero email addresses exist in any legacy file.
  mailing_address varchar(255),
  mailing_city    varchar(100),
  mailing_state   char(2),
  mailing_zip     varchar(10),
  phone           varchar(20),
  fax             varchar(20),           -- legacy held '946-6049 cell' — not actually a fax
  tax_exempt      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE property_ownerships (
  id              serial PRIMARY KEY,
  payer_id        int NOT NULL REFERENCES payers(id),
  property_id     int NOT NULL REFERENCES properties(id),
  is_primary      boolean NOT NULL DEFAULT true,
  ownership_start date,
  ownership_end   date,                  -- NULL = current owner
  source          varchar(20) NOT NULL DEFAULT 'legacy'
);
-- Exactly one current owner per property:
CREATE UNIQUE INDEX uq_current_owner ON property_ownerships (property_id)
  WHERE ownership_end IS NULL;
```

> Distribution: 7,233 payers own one property, 118 own multiple (one owns 24), 221 own zero.
> The join table is justified but is **not** the common case — do not build the UI around it.

## 5. The service ledger — the heart

```sql
CREATE TYPE event_status AS ENUM ('scheduled','dispatched','completed','cancelled','no_access');

-- Source: tblCustDumpLog (48,216 rows, 19 cols). The actual regulatory record,
-- 1965-05-02 through 2026-06-27. NO EQUIVALENT TABLE EXISTS in the current codebase.
CREATE TABLE service_events (
  id                     bigserial PRIMARY KEY,
  client_uuid            uuid UNIQUE,                  -- P6 offline idempotency
  property_id            int NOT NULL REFERENCES properties(id),
  performed_by_pumper_id int REFERENCES pumpers(id),
  cert_unresolved        boolean NOT NULL DEFAULT false, -- 4,685 events / 21 bad cert strings
  service_date           date NOT NULL,
  status                 event_status NOT NULL DEFAULT 'completed',
  gallons_pumped         numeric(8,1) CHECK (gallons_pumped >= 0), -- 29,014 filled
  waste_type_id          int REFERENCES waste_types(id),           -- P4 controlled
  waste_note             text,                                     -- P4 'Yucky Stuff','Clnd filter'
  disposal_site_id       int REFERENCES disposal_sites(id),
  disposal_method        varchar(50),
  disposal_date          date,                                     -- only 5,519 of 48,216 filled
  dnr_permit_number      varchar(30),                              -- 0% filled in legacy
  ph_before              numeric(4,2),                             -- 0% filled in legacy
  ph_after               numeric(4,2),                             -- 0% filled in legacy
  duration_minutes       int,                                      -- 0% filled in legacy
  county_form_date       date,                                     -- 35,158 filled
  source                 varchar(16) NOT NULL DEFAULT 'legacy_import',  -- | 'app'
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, service_date)                      -- validated: 0 dups in 48,216 rows
);
CREATE INDEX idx_events_date  ON service_events (service_date DESC);
CREATE INDEX idx_events_pumper ON service_events (performed_by_pumper_id, service_date DESC);
```

> **`UNIQUE (property_id, service_date)` is load-bearing.** Verified 0 duplicate pairs across all
> 48,216 rows. It makes the ETL re-runnable, prevents double-booking a property on one day, and
> supplies the natural key the legacy data implies but never enforced.
>
> **The empty DNR columns are the opportunity.** `pH ADJ - Before/After`, `Time - Mins`, and
> `DNR Permit #` are 0-of-48,216 filled. The Access app had the fields but made them painful, so
> nobody used them. The mobile app is how they finally get captured at the truck.

## 6. Scheduling — the primary feature

```sql
CREATE TYPE route_status AS ENUM ('draft','published','in_progress','done');
CREATE TYPE stop_status  AS ENUM ('pending','arrived','done','no_access','skipped');

CREATE TABLE routes (
  id           serial PRIMARY KEY,
  route_date   date NOT NULL,
  driver_id    int  NOT NULL REFERENCES users(id),
  truck_label  varchar(30),
  status       route_status NOT NULL DEFAULT 'draft',
  started_at   timestamptz,
  completed_at timestamptz,
  version      int NOT NULL DEFAULT 0,          -- optimistic lock, two devices
  UNIQUE (route_date, driver_id)
);

CREATE TABLE route_stops (
  id               serial PRIMARY KEY,
  route_id         int NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  property_id      int NOT NULL REFERENCES properties(id),
  service_event_id bigint REFERENCES service_events(id),  -- set when the job is logged
  sequence_no      smallint NOT NULL,
  status           stop_status NOT NULL DEFAULT 'pending',
  arrived_at       timestamptz,
  completed_at     timestamptz,
  version          int NOT NULL DEFAULT 0,
  UNIQUE (route_id, sequence_no)
);
```

**The due queue is a view, not a table** (P1), and it reads the as-of date, never `current_date` (P10):

```sql
CREATE VIEW v_due_queue AS
SELECT p.id, p.legacy_cust_number, p.payer_label, p.site_address, p.site_city,
       p.next_service_due,
       business_today() - p.next_service_due AS days_overdue
FROM   properties p
WHERE  p.status = 'active' AND p.last_service_date IS NOT NULL
ORDER  BY p.next_service_due;
```

> **As-built (0029).** The view gained the two honest escapes SCH-15/16. A row is
> *hidden* while an open (`pending`/`arrived`) stop books it on a future day — drafts
> included — and `scheduled_on` / `scheduled_status` / `scheduled_driver` say who has
> it; the API hides those rows by default and serves them under `show_scheduled=1`.
> A row is *disputed* while a `due_date_adjustments` row is open: `effective_due_date`
> = `COALESCE(adjustment, next_service_due)`, `days_overdue` measures against the
> effective date, and `adjusted` / `adjustment_reason` come along so a screen can show
> a date the office can explain. `next_service_date`... `next_service_due` is still
> `GENERATED ALWAYS` and untouched — the adjustment is a row beside history, never an
> edit of it, and `DELETE`ing the adjustment retires the overlay in one attributed
> action.

### 6.1 The as-of date (P10)

The development dataset is a snapshot ending **2024-12-02**. The wall clock does not stop. Measured
against the loaded source **on 2026-08-29**:

| | Properties overdue |
|---|---|
| `current_date` (2026-08-29) | **4,608** |
| as-of date (2024-12-02) | **1,926** |
| properties with any service history | 7,266 |

**Both of those numbers are stale by design, and only one of them is stale for an interesting
reason.** The first grows by roughly one per day, because the clock moves and the snapshot does not:
the same query on 2026-08-31 returns **4,624**. The second was 1,926 when measured and returns
**1,925** today — the as-of date is pinned, so that count *should* be stable, and the reason it is
not is that the dev database is writable and the test suite completes stops, which moves
`last_service_date` and therefore `next_service_due`. Treat both cells as a demonstration, not a
fixture, and re-run the query in the README's "The legacy snapshot is a development fixture" section
when you need the real figure.

**637 days of drift manufactures 2,699 phantom overdue properties — a 2.4× inflation.** The danger is
not the wrong number on screen; it's that a developer will see an absurd queue and write compensating
logic that is then *wrong in production*. So "today" becomes data:

```sql
CREATE TABLE app_setting (key text PRIMARY KEY, value text NOT NULL);

-- dev/fixture: INSERT INTO app_setting VALUES ('as_of_date','2024-12-02');
-- prod:         INSERT INTO app_setting VALUES ('as_of_date','current_date');
--               (or delete the row entirely)

CREATE FUNCTION business_today() RETURNS date
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT NULLIF(value, 'current_date')::date
       FROM app_setting WHERE key = 'as_of_date'),
    current_date
  )
$$;
```

Three consequences, all desirable:

1. **Dev against the snapshot is sane.** The queue shows the real 1,925, not 4,624.
2. **Prod needs no code change** — the setting flips, `business_today()` degrades to `current_date`.
3. **Date logic becomes testable.** A test pins `as_of_date` and asserts "property X is 30 days
   overdue" deterministically, instead of depending on the day CI ran. This outlives the stale-data
   problem — it is simply the right way to write date-sensitive business rules.

**Behaviour of this function was executed, not assumed** (against the dev Postgres, in a rolled-back
transaction):

| `app_setting.as_of_date` | `business_today()` returns |
|---|---|
| `'2024-12-02'` | `2024-12-02` (drift from real today grows by one per day: 637 on 2026-08-31) |
| `'current_date'` | real today |

> **As-built (0031/0032).** Go-live happened: the seed ships `current_date` now (0031), so a
> fresh build wakes up live — before it, every `down -v` resurrected the 2024 pin and the
> office's published routes went invisible to drivers. And released, the function answers in
> **America/Chicago** (0032), not the container's UTC: `(now() AT TIME ZONE 'America/Chicago')::date`.
> Between 18:00 and midnight Central the two dates differ, and the first evening after
> go-live a UTC clock called 09/06 "today" while the business was still 09/05. The SQL body
> above is superseded; `as_of_date` still overrides the zone, which is how the tests pin the
> calendar inside a transaction.
| row absent | real today |
| `'yesterday'` | yesterday — Postgres parses bare relative date names |
| `'current_date - 7'`, `'not-a-date'` | **hard error**, `invalid input syntax for type date` |

The last row is the property that matters: a misconfigured setting **fails loudly at query time**
rather than silently returning a plausible wrong date.

`route_date`, reminder scheduling, and the state report period must all route through the same
function. `current_date` in application code is banned for the same reason.

> **As-built (09/07).** The view answers only while the day is open — the shipped definition
> filters `route_status IN ('published','in_progress')`. That filter is why a completed day
> *vanishes* rather than turning green: the last resolved stop flips the route to `done` and
> the driver's next read 404s. `DispatchPage` reads that 404 by its cause — after its own
> accepted write the day is announced closed and the cards freeze (T-DRV-06d); over an
> unfinished day it means the office withdrew the day, and the list goes away honestly
> (DRV-14).

**One launch query per driver**, so the PWA caches a whole day in a single round trip:

```sql
CREATE VIEW v_driver_dispatch AS
SELECT r.id AS route_id, r.route_date, r.status AS route_status, r.version,
       s.id AS stop_id, s.sequence_no, s.status AS stop_status, s.version AS stop_version,
       p.id AS property_id, p.legacy_cust_number, p.payer_label,
       p.site_address, p.site_city, p.site_state, p.site_zip,
       p.tank_location_note, p.jobsite_location_note, p.chamber_pump_note,
       p.legacy_cust_number, p.reminder_opt_out,
       array_agg(json_build_object(
         'role', t.role, 'gallons', t.capacity_gallons, 'raw', t.raw_text
       )) AS tanks
FROM   routes r
JOIN   route_stops  s ON s.route_id    = r.id
JOIN   properties  p ON p.id           = s.property_id
LEFT JOIN tanks     t ON t.property_id = p.id
GROUP  BY r.id, r.route_date, r.status, r.version, s.id, s.sequence_no, s.status,
          s.version, p.id;
```

> **Sizing drives the UI.** 2024: 2,160 jobs over 234 operating days → median **9/day** company-wide,
> p90 18, max 30, spread across an average of **2.34 active pumpers** (max 5). A driver's day is
> ~4 stops, peaking near 13. That is one scrollable ordered list with large tap targets — not a
> calendar grid, not a map-first UI.
>
> **The backlog depends entirely on which definition you use, and the legacy one is unusable.**
> Measured against the loaded source, over the 7,266 properties that have service history. The
> "vs today" column moves every day; these cells were read on 2026-08-31.
>
> | Definition of "overdue" | vs as-of 2024-12-02 | vs today |
> |---|---|---|
> | Recomputed: `last_service + service_interval_days` | **1,925** | 4,624 |
> | Legacy stored `Next Service Pump Date` | **6,588** | 6,900 |
>
> The legacy column says **91% of every serviced property is overdue** (6,588 of 7,266). That is not a
> schedule, it is the P1 drift bug made visible — and it is the strongest argument for the generated
> column. Use the recomputed definition; never trust the stored one.
>
> Even 1,925 is 61 years of accumulated backlog, **not** a live queue: the legacy system never
> enforced the interval. Do not let the office dump it onto week-one routes; the practical queue is
> the subset due in the next N days.
>
> *(An earlier draft of this doc cited "4,902 overdue". That figure is not reproducible under any
> definition above and has been removed.)*

## 7. Field capture — notes, photos, offline

```sql
CREATE TABLE job_notes (
  id                bigserial PRIMARY KEY,
  client_uuid       uuid UNIQUE,                 -- P6
  service_event_id  bigint REFERENCES service_events(id),
  property_id       int REFERENCES properties(id),
  route_stop_id     int REFERENCES route_stops(id),
  author_id         int  NOT NULL REFERENCES users(id),
  body              text NOT NULL,
  client_created_at timestamptz NOT NULL,        -- the phone's clock, for ordering
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (service_event_id IS NOT NULL OR property_id IS NOT NULL OR route_stop_id IS NOT NULL)
);
```

**Offline contract:**

- `client_uuid UNIQUE` is the whole mechanism — a queued write replayed ten times lands once.
- **Conflict policy is directional, so no merge logic is ever needed.** The server owns schedule and
  status; a driver's device owns only its own notes and photos, which are append-only. Nothing is
  concurrently edited by two parties.
- `routes.version` / `route_stops.version` stop two devices completing the same stop.
- The PWA persists the `v_driver_dispatch` payload to IndexedDB and renders from it when offline.

## 8. Image pipeline — P9: no blobs in the database

**Rule: the database stores metadata and an object key. Never bytes.** A `bytea` column would put
multi-megabyte payloads through the ORM, the connection pool, every `SELECT`, and every backup.

### 8.1 Storage

| Environment | Backend | Notes |
|---|---|---|
| Development | **MinIO** in `docker-compose.yml` | S3-compatible API, so dev and prod run the *same* client code |
| Production | AWS S3 (or any S3-compatible) | Encrypted at rest (SSE-S3), private bucket, no public ACLs |

One client for both: `@aws-sdk/client-s3` + `@aws-sdk/lib-storage`, with `endpoint` and
`forcePathStyle: true` overridable so MinIO works unchanged.

### 8.2 The pipeline

```
 phone camera (12-50 MP, 3-8 MB)
   |
   +- STAGE 1  client-side, PWA, Canvas API (no dependency)
   |     downscale to <= 3.0 MP, re-encode JPEG q0.82, strip EXIF
   |     -> typically 300-600 KB before it ever touches the network
   |     (critical: rural Fond du Lac uploads on bad signal)
   |
   +- presigned PUT -> object storage direct
   |     bytes NEVER transit the API container
   |
   +- STAGE 2  server-side, sharp (libvips), DEFENCE IN DEPTH
   |     the client is untrusted. Re-decode and re-enforce:
   |       * content-sniff magic bytes, never trust the filename or Content-Type
   |       * resize so width*height <= 3,000,000 (never upscale)
   |       * re-encode JPEG q82
   |       * strip all metadata (EXIF/GPS/IPTC/XMP)
   |       * compute sha256
   |
   +- STAGE 3  derive thumbnail
   |     <= 400 px longest edge, JPEG q78 - for the route list on a phone
   |
   +- INSERT one media row per derived asset (metadata only)
```

**Why two stages:** stage 1 saves the driver's cellular data and makes offline queueing viable;
stage 2 is the only reason the 3 MP cap is actually a guarantee. A curl request, a future second
client, or a buggy app version cannot smuggle a 50 MP original past it.

### 8.3 The 3-megapixel cap

Cap on **total pixels**, because that is what decode memory scales with. A per-edge cap is a
different and worse rule:

* A width-only cap (`width <= 3000`) misses **2000x8000 = 16 MP** entirely — it is narrow
  enough to sail straight through. This is the case the total-pixel rule exists to catch.
* A total-pixel cap **accepts a 10,000x300 panorama** (exactly 3.0 MP). That is correct and
  deliberate, not a hole: it costs the same to decode as a 2000x1500 photo. An edge cap would
  reject it and buy nothing.

Both cases are asserted in `septic-app/backend/db/dev/verify_schema.sql`, so the rule
cannot quietly drift back into the wrong shape.

```
max_pixels = 3_000_000        -- 2000x1500 is exactly 3.0 MP
scale      = min(1, sqrt(max_pixels / (src_w * src_h)))
target     = floor(src_w * scale) x floor(src_h * scale)
```

`sharp` equivalent: `.resize({ width: 2000, height: 1500, fit: 'inside',
withoutEnlargement: true })`. Note that `fit: 'inside'` with *both* edges given is a
bounding-box constraint, which already implies `<= 3,000,000` pixels — so it happens to be
safe. The explicit pixel-count assertion is still required, because that safety is a property
of these particular numbers rather than of the intent, and the next person to tune the
thumbnail size may give only one edge.

### 8.4 Schema

```sql
CREATE TABLE media (
  id               bigserial PRIMARY KEY,
  client_uuid      uuid UNIQUE,                          -- P6
  service_event_id bigint REFERENCES service_events(id),
  property_id      int REFERENCES properties(id),
  route_stop_id    int REFERENCES route_stops(id),
  uploaded_by      int  NOT NULL REFERENCES users(id),

  -- object storage coordinates; the bytes live here, never in this row (P9)
  storage_bucket   varchar(100) NOT NULL,
  storage_key      varchar(500) NOT NULL,

  sha256           char(64)  NOT NULL,                   -- dedupe + integrity
  mime_type        varchar(32) NOT NULL DEFAULT 'image/jpeg',
  byte_size        int  NOT NULL,
  width            int,
  height           int,
  kind             varchar(16) NOT NULL DEFAULT 'full',  -- 'full' | 'thumb'
  parent_media_id  int REFERENCES media(id),             -- thumb -> its full-size original

  taken_at         timestamptz,
  caption          varchar(500),
  gps_lat          numeric(9,6),                         -- opt-in only; EXIF otherwise stripped
  gps_lng          numeric(9,6),
  upload_status    varchar(16) NOT NULL DEFAULT 'pending', -- pending|ready|failed

  created_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,                          -- soft delete; a GC job removes the object

  UNIQUE (storage_bucket, storage_key),
  CHECK (width IS NULL OR height IS NULL OR width * height <= 3000000),
  CHECK (kind IN ('full','thumb')),
  CHECK (kind <> 'thumb' OR parent_media_id IS NOT NULL)
);
CREATE INDEX idx_media_event    ON media (service_event_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_media_property ON media (property_id)      WHERE deleted_at IS NULL;
CREATE INDEX idx_media_sha      ON media (sha256);
```

> **As-built (0024).** `idx_media_sha` is a plain index and DRV-18 needs a promise:
> it was replaced by `uq_media_sha_live`, a *partial* unique index (`WHERE deleted_at
> IS NULL`) — a soft-deleted photo may legitimately be re-uploaded as a new row. The
> endpoint's advisory lock is the courtesy around it; the index is the truth. Same
> migration gave `job_notes.client_uuid` the UNIQUE this document always specified and
> the database never actually had.

### 8.5 Format, privacy, retention

- **Format: JPEG.** Full-size q82, thumbnail q78. Chosen over WebP/AVIF deliberately — these are
  compliance records that may have to be opened by a regulator on unknown software years from now.
  JPEG is the format that will still open. WebP is a later delivery-side optimisation, not an
  archival one.
- **EXIF stripped by default.** Phone EXIF carries precise GPS, device model, and exact capture
  time. Properties already have addresses; silently warehousing a driver's GPS track at every stop
  is a liability nobody asked for. If location evidence is genuinely wanted it is captured
  explicitly into `gps_lat`/`gps_lng` by the app, not inherited from metadata.
- **Dedupe:** `sha256` is unique per `kind`, so a re-uploaded identical photo is recognised rather
  than duplicated.
- **Volume is a non-issue.** ~2,150 jobs/yr x ~3 photos x ~500 KB is about **3 GB/year**. A lifecycle
  rule moving objects to Infrequent Access after 18 months is the only cost management required.
- **Deletion is two-phase:** `deleted_at` soft-deletes the row; a scheduled job issues the
  `DeleteObject` and then hard-deletes. Never delete an object while its row is live.
- **Serving:** presigned GET URLs, 15-minute expiry. Never proxy bytes through the API, and never
  make the bucket public — these are photos of people's property.

### 8.6 Dependencies to add

| Package | Where | Purpose |
|---|---|---|
| `sharp` | backend | libvips resize / encode / metadata-strip. Prebuilt binaries, no ImageMagick shell-out |
| `@aws-sdk/client-s3`, `@aws-sdk/lib-storage` | backend | one client for MinIO and S3 |
| — (Canvas API) | frontend | stage-1 compression, zero dependencies |

> `sharp` and the S3 SDK are **new** dependencies — neither is currently in the codebase. They must
> be added deliberately, not assumed.

## 9. Billing

```sql
CREATE TYPE invoice_status  AS ENUM ('draft','open','paid','void');
CREATE TYPE payment_method  AS ENUM ('check','cash','card','other');

CREATE TABLE invoices (
  id                serial PRIMARY KEY,
  legacy_invoice_no int UNIQUE,
  payer_id          int NOT NULL REFERENCES payers(id),
  property_id       int REFERENCES properties(id),
  service_event_id  bigint REFERENCES service_events(id),
  invoice_date      date NOT NULL,
  subtotal          numeric(10,2) NOT NULL DEFAULT 0,
  tax_rate          numeric(5,4)  NOT NULL DEFAULT 0,
  tax_amount        numeric(10,2) NOT NULL DEFAULT 0,
  total             numeric(10,2) NOT NULL DEFAULT 0,
  status            invoice_status NOT NULL DEFAULT 'open',
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invoice_lines (
  id                  serial PRIMARY KEY,
  invoice_id          int NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  service_type_id     int REFERENCES service_types(id),
  legacy_product_code varchar(20),
  description         varchar(255),
  quantity            numeric(8,2) NOT NULL DEFAULT 1,
  unit_price          numeric(10,2) NOT NULL DEFAULT 0,
  amount              numeric(10,2) NOT NULL DEFAULT 0
);

-- Fixes the legacy conflation where Check # held the value 'c.c.'
CREATE TABLE payments (
  id        serial PRIMARY KEY,
  invoice_id int NOT NULL REFERENCES invoices(id),
  amount     numeric(10,2) NOT NULL CHECK (amount >= 0),
  method     payment_method NOT NULL,   -- check|cash|card|other
  reference  varchar(50),               -- the actual check number
  paid_at    date
);

> **As-built (0025/0026).** A payment is a receipt and receipts have witnesses: the
> table gained `received_by` (FK users, NULL on the 3,199 legacy rows — payments whose
> taker predates every login), `note`, and `client_uuid`; `amount` is CHECK'd strictly
> positive (refunds are adjustment documents, BIL-05, never negative receipts); the
> invoice FK is RESTRICT; and the table is append-only under the same ledger guard as
> `service_events` — a deleted receipt is money that was un-taken. `invoices.amount_paid`
> is not a number anyone types: it is re-summed from the receipt rows on every payment,
> and the derived status needed a word for *partway*, so `invoice_status` grew
> `'partial'` (0026 — `ALTER TYPE ADD VALUE` cannot run inside a transaction, which is
> what the `-- runner: no-transaction` header in `scripts/migrate.ts` exists for).

CREATE TABLE inspections (
  id                serial PRIMARY KEY,
  property_id       int NOT NULL REFERENCES properties(id),
  inspection_date   date NOT NULL,
  prev_owner_first  varchar(100),
  prev_owner_last   varchar(100),
  notes             text,
  legacy_inspect_id int UNIQUE
);
```

> **Legacy AR is small and clean:** $996,843.95 billed, $982,994.95 paid, **$13,849.00 outstanding**
> across 50 unbalanced invoices (1.5% of 3,283). Migratable in an afternoon.
>
> `Disposal Fee`, `Tax Amount`, and `DNR Service Fee` are **literally `0` in all 3,283 rows** — the
> legacy app never used them. Keep the columns; expect no history.
>
> `Date Paid` uses format `01-Nov-24` while every other date in the export is `M/D/YYYY`. The ETL
> must special-case it.

### Estimates (bids) — the installation/plumbing half (BIL-09..15, planned 0028)

The company has always installed systems (including mounds) and a licensed plumber has
always done general work, but the legacy corpus contains no estimate tables at all: bids
lived on paper, which is also where their prices lived — in memory. This design adds what
the ledger never had, under one rule repeated from three directions already: **the list
is a reference, the bid is a record, the signature is a border.**

```sql
CREATE TYPE bid_status AS ENUM ('draft','approved','declined','invoiced');

-- The master price list (BIL-09). Reference data the office owns; it is not history.
CREATE TABLE bid_items (
  id          serial PRIMARY KEY,
  name        varchar(120)  NOT NULL,            -- 'Licensed plumber labor'
  unit        varchar(20)   NOT NULL,            -- 'hour', 'feet', 'each' — priced per *something*
  unit_price  numeric(10,2) NOT NULL CHECK (unit_price >= 0),
  is_active   boolean NOT NULL DEFAULT true,     -- retire, never delete: a price that
                                                 -- existed is evidence of what was charged
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bids (
  id            serial PRIMARY KEY,
  payer_id      int NOT NULL REFERENCES payers(id),   -- a document is addressed to someone
  property_id   int REFERENCES properties(id),        -- the lot, when the work happens there
  bid_date      date NOT NULL DEFAULT business_today(),  -- server clock at creation (P10)
  status        bid_status NOT NULL DEFAULT 'draft',
  notes         text,
  tax_rate      numeric(5,4) NOT NULL DEFAULT 0,  -- the system rate, STAMPED at approval
                                                  -- (BIL-16): the signature freezes the
                                                  -- tax on the bid with the prices on it
  approved_by   int REFERENCES users(id),             -- stamped, never typed (BIL-12)
  approved_at   timestamptz,
  declined_at   timestamptz,
  decline_note  text,
  invoice_id    int REFERENCES invoices(id),          -- set exactly once, by the conversion (BIL-13)
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bid_lines (
  id           serial PRIMARY KEY,
  bid_id       int  NOT NULL REFERENCES bids(id) ON DELETE CASCADE,
  bid_item_id  int  REFERENCES bid_items(id),         -- NULL: a one-off line the customer talked about
  description  varchar(255) NOT NULL,   -- COPIES of the price list, taken at
  unit         varchar(20)  NOT NULL,   -- the moment of adding (BIL-10): the list
  unit_price   numeric(10,2) NOT NULL CHECK (unit_price >= 0),   -- may change Tuesday
  quantity     numeric(8,2)  NOT NULL CHECK (quantity > 0),      -- 0.5 of an hour is exact
  line_total   numeric(12,2) GENERATED ALWAYS AS (unit_price * quantity) STORED,
  sequence_no  int NOT NULL,
  -- A generated column can carry a CHECK, and this one earns its keep: without a
  -- bound, `unit_price * quantity` can overflow numeric(12,2) inside the INSERT and
  -- the client hears "internal error" for what is really a typo in a number. With
  -- it, the endpoint can pre-validate the same product rule and answer 400 by name.
  CONSTRAINT chk_bid_line_size CHECK (unit_price * quantity < 10000000)
);

-- BIL-13: the invoice line's third lawful reference. The check gets wider, not weaker:
-- a line still may not be free text floating on its own — it points at a service event,
-- a product code, or a line a signature approved.
ALTER TABLE invoice_lines ADD COLUMN bid_line_id int REFERENCES bid_lines(id);
ALTER TABLE invoice_lines DROP CONSTRAINT chk_line_reference;
ALTER TABLE invoice_lines ADD CONSTRAINT chk_line_reference CHECK (
  service_event_id IS NOT NULL OR legacy_product_code IS NOT NULL OR bid_line_id IS NOT NULL
);

-- BIL-16: the one-row settings table earns its second question. The CHECK is the
-- whole requirement: a rate is not an amount, and the clerk who types 5.5 meaning
-- "5.5%" into a decimal field would otherwise bill 550% of every job.
ALTER TABLE company_settings
  ADD COLUMN sales_tax_rate numeric(5,4) NOT NULL DEFAULT 0
    CHECK (sales_tax_rate >= 0 AND sales_tax_rate < 1);
```

Conversion arithmetic (server-side, in the conversion transaction — never at a keyboard):
`subtotal = SUM(bid_lines.line_total)`, `tax_amount = round(subtotal × bids.tax_rate, 2)`,
`total = subtotal + tax_amount`, all three written to the invoice's own long-idle
`tax_rate`/`tax_amount`/`total` columns. An unapproved bid has no `tax_rate` of its own
worth quoting: its detail shows the *current* system rate as a labelled estimate.

Decisions, with their reasons:

* **The bid total is not a column.** Billed/collected/owed are computed per request all
  the way through BIL-07; a stored bid total would be a stored total that drifts, and
  bids acquire exactly the mutation history (line adds, quantity edits) that makes stored
  sums lie. `line_total` is the one exception the doctrine already made: `GENERATED
  ALWAYS` is a column nobody can *type into*, which is different from a stored column.
* **No freeze trigger on approved bids**, unlike invoices (0022). The invoice trigger
  exists because 61 years of hand-edited money history must survive a future bug; bids
  are new, small, and their immutability rule is young — the endpoint guards it and the
  mutation-tested refusals police the guards. Recorded as a known lighter weight, not
  an oversight.
* **`invoice_lines.bid_line_id` is the shape of BIL-01 evolving.** Every widening of a
  money constraint needs a provenance story or it is just a hole; this one has one that
  predates the migration (the legacy estimate *was* the paper line its invoice was
  typed from — 3,120 orphans, BIL-03, are what typing it by hand cost).
* **`invoice_lines.bid_item_id` (0033) is the same widening, one more time.** BIL-20's
  queue-to-invoice path needed a line that names a price-list item the way a bid line names
  a bid line: the migration adds the column, rebuilds the four-way OR CHECK, and indexes the
  not-null half. The *item id* is stored, never a copy of the price — the line carries the
  price it charged. Exactly-one is enforced by `POST /api/invoices`, not by the CHECK: a
  mutually-exclusive CHECK over N alternatives must be rewritten every time BIL-01 grows.
* **`bids.bid_date` defaults server-side**, and the create endpoint refuses a client-
  supplied one; `approved_at`/`declined_at`/conversion date are stamped, never sent.
  Every clock-written field in this app is the server's (P10's 635-day lesson).

Migration **0028** is one file: enum + three tables + the constraint swap + the
`company_settings` column. The swap counts rows that would violate the *old* check
before dropping it (they are the 3,120 quarantined-never-loaded lines — zero in the
live table; assert, then proceed), and needs no `-- runner: no-transaction` header
because the enum is created whole, not altered. `bids.tax_rate` defaults 0 not because
tax is 0 but because **0 is the pre-signature value** — only approval stamps a real one.

## 10. Lookups

| Table | Source | Normalisation work |
|---|---|---|
| `counties` | 34 spellings → ~6 real | Fond du Lac 5,729 (76%), Calumet 624, Sheboygan 589, Manitowoc 384, Dodge 74, Winnebago 32. Aliases: `'FDL'` (26), `'Fond du lac'` (6) |
| `septic_system_types` | 100 distinct | Conventional, Mound, Manure Pit, … needs curation |
| `waste_types` | 9 defined, 65 used | The 9 DNR-ish values are the spine; the other 56 are free text |
| `disposal_sites` | 105 free-text | DNR-permitted facilities: `'ZSS'`, `'<company> slurry'`, `'land spread'` |
| `baffle_materials` | 635 distinct raw strings (282 inlet ∪ 507 outlet) → **592 rows in the lookup** | **The "~6" estimate below is wrong, and it was measured from one column.** Loading both columns and collapsing on the six named materials matches 5 of them. This is free text, not a dirty dropdown — a picker over it (DRV-08) needs a curated short list plus a free-text escape, not a normalisation pass. Only **253** of the 592 lookup rows are referenced by any property. **The originals were not kept:** unlike `county_raw` there is no `baffle_*_material_raw`, so a string mapped to the wrong material cannot be audited without the CSVs. See §13. |
| `service_types` | `tblInvoiceDetails` (99 codes) | Real catalog. 17 codes are *used* but undefined |

## 11. Migration scaffolding

```sql
CREATE TABLE import_staging    (source_file text, row_no int, raw jsonb);
CREATE TABLE import_quarantine (source_file text, row_no int, raw jsonb, reason text);  -- P7
CREATE TABLE import_log        (source_file text, loaded int, quarantined int, ran_at timestamptz);
```

> Every rejected row lands in `import_quarantine` with a reason. Nothing is silently dropped.
> Known rejects so far: 2 malformed service dates (`12/21/217`, `4/1/158`), 8 malformed next-due
> dates, 1 `Range` value of `'189871'`, 1 `Contract Date` of `'11/11/1111'`.

## 12. Deliberately excluded

| Excluded | Reason |
|---|---|
| `inventory_items`, `suppliers`, `purchase_orders` | Zero legacy rows. 18 endpoints, ~1,000 backend + 1,855 frontend lines. Cut by decision. |
| `customer_locations` | Marked deprecated in code yet still `@Entity`-registered via the `src/models/*.ts` glob load. |
| `SepticTankRecord.compliance_status` / `inspection_frequency` | A tank-inspection-calendar model the business does not operate. Replaced by `service_interval_days`. |
| `WisconsinStateReport.total_records` / `compliant_records` / `overdue_records` | Denormalised counters with no source events to compute them from. Compute, don't store. |
| `tblSystem.Password = 'septic'` | One shared plaintext password for the entire app. Never import. (A second credential found hardcoded in ad-hoc scripts was scrubbed; rotation waived — that host is not a live target.) |
| `Property.latitude` / `longitude` | No coordinates exist in the source (P8). Needs geocoding — separate workstream. |
| `customers.email NOT NULL` | Zero email addresses exist in any of the 9 files. Nullable on `payers`. |

## 13. Questions and open decisions

1. ~~**RED — the export stops at 2024-12-02.**~~ **RESOLVED — by design.** The CSVs are a
   point-in-time **development fixture**; production data is migrated later, at cutover. The staleness
   is accepted, not a blocker. What remains is not a question but two consequences that are now
   designed for:
   - **P10 / §6.1** — the snapshot falls further behind the clock by one day every day (637 days on
     2026-08-31), so `current_date` is banned and `business_today()` supplies the as-of date. Without
     this the due queue reads 4,624 instead of 1,925 and developers chase a phantom bug.
   - **At cutover**, re-export and re-run the ETL. The loader and the row-count assertions in §14 are
     the check that the new export is complete. Reproduce the staleness itself with:
     `SELECT extract(year from service_pumped_date::date)::int, count(*) FROM legacy.tblcustdumplog
      GROUP BY 1 ORDER BY 1;` → 2019→2,022 · 2020→2,115 · 2021→2,173 · 2022→2,146 · 2023→2,265 ·
     2024→2,160 · **2025 → none** · 2026 → 1 row.
2. **AMBER — 4,685 events carry a certification number that is not one of the 7 known pumpers.**
   Re-verified in SQL against the loaded source, and this **corrects an earlier read of the data**.
   It is not a spread of typos: **21 distinct bad values**, and a *single* one — `6043` — accounts for
   **4,650 of the 4,685**, used continuously from **1988-09-06 to 2023-09-29**. The remaining 20
   values are a long tail of 1–11 uses each (`4319`×11, `2692`×4, `2693`×3, `23920`, `393`, `24391`, …).
   Known certs are `0`(unknown), 2392, 2393, 4391, 4502, 6460, 6971.
   **Do NOT auto-repair by edit distance.** A 35-year span on one number means it is a real
   certification — almost certainly a former employee, or an obsolete number belonging to a former
   owner (6460) — not a keystroke. Auto-repair would silently reassign ~4,650 regulatory
   records to the wrong person on a state filing. Recommended: quarantine `6043` and ask the
   business who it belongs to; the ~35 long-tail singletons *can* be edit-distance repaired.
3. **RESOLVED — the "2,933 orphaned invoice lines" are abandoned Access forms, not credits.**
   Re-measured line by line, which also corrects the count: 2,933 is the number of distinct orphaned
   invoice *numbers*; they cover **3,120 lines**. Only **6** lines carry a negative invoice number
   (`-1, -2, -7, -8, -15 ×2`) and all six have **positive** prices — $135, $50, $180, $245, $165,
   $165. A credit carries a negative amount, so these are not credits. The split is:
   - **1,709** reference invoice numbers below the `tblInvoices` floor of 15885 → header rows were
     never exported
   - **1,404** reference numbers *inside* the 15885–20574 window, sitting in its gaps
   - **1** is 20575, one past the maximum
   - **6** are the negatives above

   One mechanism explains all four buckets. In Access a bound subform commits its rows immediately
   while the main form commits only on save: abandon an invoice mid-entry and the line items survive
   with no header. The negatives are the same event caught one keystroke earlier, before a number was
   assigned. Decisively, `tblInvoiceAmount` has three columns — `Invoice Number`,
   `InvoiceProductCode`, `Price` — and **no customer column**, so no orphan can be attributed to
   anyone. Quarantine all 3,120 with reason codes (BIL-03); never attach them to an invented invoice.

   The instinct this pointed at was still right, just about a different thing: the legacy app had no
   way to adjust an invoice, which is the most plausible reason the rows exist. That need is
   forward-looking and is now **BIL-05** — adjustments as linked new rows, original never edited.

   **Consequence, recorded as ETL-08:** `tblInvoices` holds 3,283 of the 4,690 invoice numbers its own
   detail table references, so the export is incomplete. Harmless as a dev fixture. At cutover it
   silently deletes billing history, and per-file reconciliation would not catch it — both files
   reconcile happily against themselves. Completeness must be asserted *across* files.
4. **GREEN — `Memo` holds 59,987 `**`-delimited fragments** (avg 8.1 per property, 5,232 properties
   with 5+) that overlap the structured ledger. Recommended: archive verbatim in
   `properties.legacy_memo`, parse opportunistically later.
5. **GREEN — `Permit Number` has 48 duplicates** across 5,168 values. Enforce uniqueness or leave
   loose?
6. **OPEN — every property is due on a 1,095-day interval, and nobody chose that.** The transform
   loads the ledger and derives `last_service_date`, but leaves `service_interval_days` at its
   schema default for all 7,541 properties. The legacy `Next Service Date` cannot be mined for an
   interval — it disagreed with `service_date + interval` in 32,396 of 45,804 rows because it was
   hand-edited, so there is no stored rule to recover, only noise. `tblCustDumpLog` does carry
   `days_between_pumps`, so a per-property interval *could* be derived from actual history. It is
   not derived here because that is a scheduling policy with consequences — it decides who gets a
   reminder and when — and a data migration is the wrong place to invent one. The due queue is
   therefore correct but uniformly assumed; 1,925 properties currently read as overdue.
7. **OPEN — LED-03 ("every event carries a disposal site") cannot be applied retrospectively.**
   Measured against the loaded ledger: **45,251 of 48,216 events have no disposal site**, and the
   2,965 that do match a known site exactly. So the requirement is a rule for new writes, enforced
   in the app at the truck, not a property of the migrated history. Back-filling 94% of the
   regulatory record would be fabrication, and the legacy report evidently got by without the field.
8. **OPEN — "1,925 overdue" is not 1,925 jobs, and the queue cannot tell you which ones are real.**
   Measured against `v_due_queue` on the loaded data — with `business_today()` returning the
   snapshot's as-of date of 2024-12-02 rather than the wall clock, per §6 — the overdue rows
   break down as:

   | Band | Properties | Oldest due date |
   |---|---|---|
   | 1–30 days overdue | 22 | 2024-11-02 |
   | 1–6 months | 220 | 2024-06-05 |
   | 6–12 months | 73 | 2023-12-08 |
   | 1–10 years | 1,056 | 2014-12-13 |
   | **over 10 years** | **554** | **1989-09-29** |

   Only about 290 sites fell due inside the last year. The other 1,610 have not been pumped since
   before 2014, and the oldest due date in the file is 1989 — a site whose last recorded service
   was 1986-09-30 and whose `status` is still `active`. Those are almost certainly systems the
   legacy database carried forward and never closed, not a decade of missed appointments.

   This is not a bug in the derivation. `next_service_due` is arithmetically correct for every
   row, and `status = 'active'` is the only filter the view applies. The problem is that `active`
   was set by the migration rather than by a human, so it records "this row existed in Access"
   and not "this customer is still a customer" — and item 6's assumed 1,095-day interval then
   guarantees that any site with an old last-service date reads as overdue forever.

   Three ways out, and none of them belongs in a transform: a dormancy rule (a site with no event
   in N years stops appearing), a real `status` review by the office, or a per-property interval
   derived from `days_between_pumps` as item 6 describes. The queue is shipped showing the bands
   rather than hiding them, so the office can see the shape of the problem while deciding.
   **The number to act on is roughly 290, not 1,925.**

9. **OPEN — migration 0011's header is wrong, and two things really were silently dropped.**
   0011 opens *"Nothing is silently dropped during the ETL"* and lists four known rejects.
   Measured against the loaded data, three of the four claims do not hold:

   | 0011 claims | Measured |
   |---|---|
   | 2 malformed service dates | **correct** — both are in `import_quarantine`: `12/21/217`, `4/1/158` |
   | 8 malformed next-due dates | **0 quarantined.** `next_service_pump_date` is never read at all — `05_service_events.sql:101` ignores the column by design, since the due date is derived |
   | 1 Range value of `'189871'` | **not rejected.** It was loaded |
   | 1 Contract Date of `'11/11/1111'` | there are **2**, and both were nulled |

   The two real drops:

   - `contract_date` is parsed by `pg_temp.wb_date()` at `03_people_and_places.sql:144` with
     **no quarantine INSERT beside it**. Both `11/11/1111` rows became
     `property_ownerships.ownership_start IS NULL` with no trace anywhere. (Worth noting the
     column is near-useless regardless: only 31 of 7,541 customers have a contract date at
     all, so 7,512 of 7,541 ownership rows have a NULL start.)
   - `range` is the **PLSS range** of the parcel — part of the legal land description, whose
     real values look like `13`, `20A`, `25NE` — and `pg_temp.clean()` validates nothing, so
     `'189871'` is sitting in `properties.plss_range`.

   The migration file is **not edited**. `scripts/migrate.ts` stores a sha256 per migration
   and exits 1 on mismatch, and `migration-integrity.test.ts` recomputes them, so a
   comment-only change registers as schema drift. That is the right trade — the alternative
   is a checksum nobody can trust — but the consequence is that anyone reading only the
   migration reads a false statement. The lesson for the remaining migrations is to keep
   claims about *data* out of the files that describe *schema*, because once applied they
   cannot be corrected in place.

   **Worth deciding:** whether to add the missing quarantine INSERT for `contract_date` and a
   numeric check on `plss_range`, so a re-run quarantines these three rows instead of nulling
   and loading them.

10. **OPEN — `import_quarantine` records that a row was fixed, but not what the fix was.**
    `resolved_at` and `resolved_by` exist; there is no `resolution_note`. The queue can now be
    drained from the UI, but closing one of the six `orphan_line_negative_invoice_number` rows
    leaves no record of which invoice number the person thought was meant — and the next
    reviewer cannot tell a considered resolution from an accidental click, because the two
    look identical. `unresolve` exists precisely because the difference is invisible.

    The fix is one nullable `text` column, which is why it is listed here rather than added:
    `import_quarantine` belongs to migration 0011, and per item 9 that file cannot be edited.
    It needs a new migration, and a new migration for one column is worth bundling with the
    other things §13 will eventually need rather than spending one on this alone.

11. **OPEN — the baffle mapping threw away the evidence it was built from.** `county_raw` exists for
    exactly one reason: when a county was guessed from a village name, the guess has to stay
    checkable against what the CSV said. The same judgement was needed for baffles and was not made.
    `legacy.tblcustomers` carries 635 distinct non-blank strings across `baffles_inlet_material` and
    `baffles_outlet_material`; they were normalised into the 592 rows of `baffle_materials`, and
    `properties` kept only the foreign key. There is no `baffle_inlet_material_raw`.

    Why it matters rather than being tidy: 339 of the 592 lookup rows are referenced by nothing,
    which is the shape you would expect from a mapping that split near-duplicates and invented some
    rows, and 2,095 properties have no inlet material at all. If any of those mappings is wrong, the
    only way to find out is to re-read the CSVs — which are gitignored, exist on one machine, and are
    not present at cutover. A wrong `county_raw` guess is recoverable from the production database; a
    wrong baffle guess is not.

    The fix is the same shape as item 10 — two nullable `text` columns on `properties`, populated by
    a re-run of the transform while `legacy` is still loaded. It is cheaper today than it will be at
    cutover, and it is the last moment at which it costs nothing.

## 14. Source data profile

Accurate counts from a real CSV parser. `wc -l` over-counts badly: `Memo` and `Tank Location`
contain newlines inside quoted fields (`tblCustomers.csv` is 7,541 rows, not 28,870).

| File | Rows | Cols | Role |
|---|---|---|---|
| `tblCustDumpLog.csv` | 48,216 | 19 | Service/compliance ledger → `service_events` |
| `tblCustomers.csv` | 7,541 | 35 | Septic system/site registry → `properties` + `tanks` |
| `tblBilling.csv` | 7,572 | 11 | Payer/mailing address → `payers` |
| `tblInvoiceAmount.csv` | 6,590 | 3 | Invoice line items → `invoice_lines` |
| `tblInvoices.csv` | 3,283 | 13 | Invoices → `invoices` |
| `tblInspectionDate.csv` | 2,771 | 5 | Inspections → `inspections` |
| `tblInvoiceDetails.csv` | 99 | 2 | Service catalog → `service_types` |
| `tblOwner.csv` | 7 | 11 | Certified pumpers → `pumpers` |
| `tblWasteTypes.csv` | 9 | 1 | Waste lookup → `waste_types` |
| `tblSystem.csv` | 1 | 1 | Shared plaintext password → **discarded** |

All files are UTF-8 **with BOM**. Line endings are mixed across files. The reader must use
`utf-8-sig` and tolerate both LF and CRLF.


