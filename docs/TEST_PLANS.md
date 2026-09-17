# Test plans — pending requirements

One section per **non-obvious** requirement, written **before** the implementation it plans
for. The mechanical rows — a column that must exist, a label that must render — carry their
verification on the REQUIREMENTS.md row itself; a plan earns its space by saying what will be
asserted and how the assertion could fail. When the code lands, the plan's cases become real
tests and the plan records where they went. A requirement is done when its `it.todo` is gone,
its doc row is ✅, and the cases run in `npm test`.

Style follows the house rules: HTTP against the live server where the bug class lives in the
seam, raw `pg` for schema facts, no mocks, and every new test mutation-checked (break the
code by hand, watch the named test fail, restore).

---

## AUT-10 — driver token refused on office-only endpoints

**Intent.** A stolen tablet (role `driver`, the weakest credential in the system) must not be
able to write office state. Reads stay open by recorded decision (quarantine.ts, routes.ts
comments); *writes* are the gate.

**Approach.** One table-driven integration test: log in a driver and an office user, then
enumerate every OFFICE-gated route in `src/routes/` and fire each with the driver token.
Enumeration from the live server (not a hand list in the test) is not possible in Express, so
the list is written out and guarded: the test also asserts each listed route is mounted (a
404-with-office-token means the route disappeared and the test must notice, not pass
vacuously).

**Cases.**
1. Every office write route: driver token → 403 (never 401 — the token is valid; never 2xx/404).
2. Same routes with an office token → not 403 (200/201/400/404/409 acceptable — the gate is
   open; the body decides).
3. `/api/users` (created by AUT-12) included the moment it exists.
4. Open reads (`GET /properties`, `GET /routes`, `GET /quarantine`) with a driver token → 200,
   pinning that the gate is writes-only, per the documented decision.

**Status.** ✅ shipped (`tests/office-gate.test.ts`, 30 cases incl. ledger/billing/users).
Mutation-checked: removing one `authorize` gate turns the matching driver case red.

**Why it can fail while looking right:** a route added later without `authorize` → covered by
case 1 once added to the list; list drifts from the router → case 2 catches vanished routes;
403-vs-401 mixup → exact-status assertions.

---

## AUT-11 — logout invalidates the session server-side

**Intent.** Today `logout` returns 200 and does nothing; a stolen token is valid for 7 days
regardless. Post-logout and post-deactivation, the token must stop working.

**Design.** ~~Per-user `tokens_invalid_before` timestamp compared against `iat`.~~
**Corrected by its own test:** second-resolution `iat` cannot distinguish a token minted
0.4 s *before* a logout from one minted 0.2 s *after* it — the same-second re-login case
died deterministically, and no rounding convention fixes an information gap. The shipped
design (0019) is a **counter**: `users.tokens_epoch`, embedded in the token as `ep` at
login; logout increments the column; `authenticate` refuses any token whose epoch is
behind. "Log out and immediately back in" is exact. `authenticate` also refuses inactive
accounts, which closes the gap where disabling an account left its live tokens working
(feeds AUT-12).

**Status.** ✅ shipped. `tests/session-revocation.test.ts` (6), mutation-checked: reverting
logout to its no-op turns 3 of them red.

**Cases.**
1. Login → token works on `/me`; logout → same token gets 401 on `/me`.
2. After logout, a *fresh* login immediately works (revocation is per-token-generation, not a
   user kill-switch).
3. Login, logout, login, then use the *first* token → still 401 (each logout only raises the
   marker; it never lowers it).
4. Deactivate a user at the DB → their pre-existing valid token is refused 401 without waiting
   for expiry.
5. Malformed/foreign tokens keep answering 401 as before (AUT-03/04 regression).

**Why it can fail while looking green:** (the clock-arithmetic version of this failure did
exactly that — see the correction above; the counter made it untestable by construction.)

---

## AUT-12 — admin can create, disable and re-enable accounts through the API

**Intent.** `scripts/seed-user.ts` is a bootstrap tool, not an operations surface. Admins need
HTTP endpoints; non-admins must not have them.

**Design.** `src/routes/users.ts`: `authenticate` + `authorize('admin')` at the router level,
then `POST /api/users` (create with explicit role, password validated by the AUT-06 policy,
email conflict → 409) and `PATCH /api/users/:id` (accepts `is_active`; refuses admin
self-deactivation with 400; a narrow UPDATE, per AUT-09's rule about full-row saves).
Responses never carry `password_hash`. Disabling takes effect immediately via the AUT-11
`is_active` check in `authenticate`.

**Cases.**
1. Admin creates an `office` account → 201, no hash in body; the account logs in and reaches
   office reads.
2. Same create by `manager`, `driver`, and with no token → 403, 403, 401.
3. `POST /register` (public) still cannot mint the role — create-with-role exists only on the
   gated surface (AUT-01 regression guard at the new boundary).
4. Duplicate email → 409; weak password → 400 with `requirements` array.
5. Admin disables the account → its next login is 403 *and* its already-issued token is
   refused (AUT-11 seam).

**Status.** ✅ shipped (`tests/user-admin.test.ts`). Mutation-checked: widening the router's
`authorize('admin')` to include `manager` turns 2 cases red.
6. Admin re-enables → login works again; the revoked token from case 5 stays dead — the
   deactivation raises the session epoch, so re-enabling restores the *account*, never a
   session that existed while it was suspended (a flag-conditioned refusal is a pause, not
   a revocation; caught by this very case).
7. Admin disables *themselves* → 400, and the admin can still log in afterwards.
8. `PATCH` an id that does not exist → 404 (intParam rule: answered from the URL).

**As-built (09/16) — the row gained its third operation: `POST /api/users/:id/password`.**
The absence comment this table predates called reset "a whole feature with its own failure
modes"; the failure modes turn out to be exactly two, and both are already built: the
AUT-06 policy (a reset that accepted weak passwords would re-import the legacy corpus's
one-shared-plaintext-password answer) and the AUT-11 epoch (a reset that left live sessions
alive would reset the password and nothing else — the tablet stays stolen, only the
lock changes). Cases (`user-admin.test.ts`, `AUT-12: password reset`): a reset kills the
old password's *login* and its *issued token* while the new password logs in, and the old
token stays dead after the fresh login (the epoch moved, it did not blink); a weak reset
is refused with the `requirements` array and the old password demonstrably still works;
the gate is the router (manager 403, no token 401) and bad ids answer 404 from the URL;
**self-reset is allowed** — changing your own password is the legitimate case, and the
epoch bump simply ends the resetter's sessions like any other, which is the safe failure
mode self-*deactivation* does not have. The screen (`UsersPage.test.tsx`): every row
offers the reset including your own (with the dialog warning the self-resetter that this
device goes to the sign-in page — which is what `authService.logout` + `?expired` then
says), the refusal arrives in the server's words without a reload, and the field carries
the `autoComplete="new-password"` guard the creation form learned the hard way: a reset
autofilled by a password manager would land the admin's own credential on someone else's
account — the shared-password corpus with extra steps.

---

## AUT-06 — password policy accepts everything a reasonable person could type

**Intent.** The current class `[!@#$%^&*(),.?":{}|<>]` rejects `Passw0rd_one` for its
underscore — the most common symbol in a typed password. Fix = widen; the row's two
"KNOWN DEFECT" tests flip to `toBe(true)`.

**Design.** "Special character" becomes *any character that is not a letter or digit*
(including space): `/[^A-Za-z0-9]/`. Stated rules (length, upper, lower, digit, special) are
unchanged; only what counts as special.

**Cases.**
1. Previously rejected, now accepted: underscore, hyphen, slash, plus, equals, semicolon,
   brackets, tilde, backslash, backtick, apostrophe, space.
2. Still rejected for the stated reasons: too short; no uppercase; no lowercase; no digit;
   alphanumeric-only (`NoSymbolsHere1`).
3. Requirement strings still exactly 5 entries (UI contract).

**Guard bookkeeping.** AUT-06 leaves the `QUALIFIED` set in
`requirements.todo.test.ts`, the doc row becomes ✅, and §9 counts move — the checklist test
forces all three to move together.

---

## SCH-06 — reassigning a property closes the old link and keeps the history

**Intent.** Ownership changes are a recorded event. `property_ownerships` already carries
`relationship_status` ('current'/'historic') + a partial unique index
(SCH-05). Reassignment = one transaction: close old (status→historic, `end_date`), insert new
current. Nothing is ever overwritten.

**Approach.** New office-gated endpoint on the property write path + a schema-behaviour test.

**Cases.**
1. Assign payer A to property P → A is current. Reassign to B → one txn: A's row flips to
   `historic` with an `end_date`; B's row is `current`; **A's row still exists** (the whole
   point).
2. Re-assigning to A again later → two A rows, only one current (history is not merged).
3. Concurrent double-reassignment → the partial unique index makes the second "current"
   impossible; endpoint reports the conflict, never silently unsets.
4. Old row's original columns (start date, notes) survive byte-for-byte through the close.
5. Driver token cannot reassign (AUT-10 list grows).

**Status.** ✅ shipped (`POST /api/properties/:id/owners`, office-gated; `tests/owners.test.ts`).
Mutation-checked by committing the crime itself: swapping close-and-open for a single
`UPDATE payer_id` reddens the keep-the-old-row case. Two suite bugs surfaced on the way: a
teardown that reopened legacy rows *before* deleting its replacements (tripped SCH-05's own
index), and a corpus-scavenger case that passed vacuously until the replay freed a property —
now it plants its own unowned site instead of asking the corpus to cooperate.

**Status.** ✅ shipped (`POST /api/properties/:id/owners`, office-gated; `tests/owners.test.ts`).
Mutation-checked by committing the crime itself: swapping close-and-open for a single
`UPDATE payer_id` turns the keep-the-old-row case red. The suite restores every legacy row
it touches — and its teardown ordering (delete the new rows before reopening the old) is
itself pinned by the SCH-05 index that a wrong order trips.

---

## LED-01 — the ledger is append-only; edits become correcting entries

**Intent (P5).** A submitted `service_events` row is never UPDATEd. Correcting a wrong entry
means inserting a new row linked to the old one, both remaining readable.

**Design.** Migration: `service_events.corrects_event_id bigint REFERENCES service_events(id)`
+ a `BEFORE UPDATE/DELETE` trigger on `septic_app.service_events` that raises, **except** for
the append-only bookkeeping columns the driver flow already writes (status capture on stops is
`route_stops`, not events — the ledger row is write-once from the day it is filed). The API
exposes `POST /api/ledger/:id/correct` (office or the originating driver): copies the row,
applies the corrected fields, sets `corrects_event_id`, marks the old row `superseded`
(a status column flip, allowed by the trigger as the one sanctioned transition — decided in
the plan, enforced by the exception list).

**Cases.**
1. Raw `UPDATE service_events SET gallons=…` → the trigger raises; row unchanged.
2. Raw `DELETE` → raises.
3. `POST /ledger/:id/correct` → old row intact (original gallons readable), new row references
   it, correction chain of length 2 readable.
4. State report (LED-02) counts the corrected value, not the superseded one — the pair must
   net out to the corrected number.
5. Two corrections on the same original → chain 3, report uses the head.
6. A correction that names a nonexistent event → 404.

**Status.** ✅ shipped (0020 + 0023 + `tests/ledger.test.ts`). Two findings the plan's
cases themselves produced: (a) 0020's row-level allowlist trigger returned OLD on its
allowed path — silently discarding every "permitted" UPDATE — caught by the payment case,
fixed forward in 0022 after learning that 0018/0020 cannot be edited (NF-05); (b) three
`ON DELETE SET NULL` foreign keys on `service_events` (pumper, waste type, disposal site)
would have Postgres issue exactly the UPDATE the append-only guard forbids whenever a
referenced row was deleted — deleting a pumper silently blanked "who pumped it" on
regulatory rows. 0023 makes them RESTRICT: a pumper cited by the ledger is retired, not
deleted.

---

## LED-02 — state report generated from service_events, no tallies

**Approach.** `GET /api/ledger/state-report?from=&to=` computes sums by month/disposal-site
directly over `service_events` (SQL in the controller, reviewable). Test compares the API
answer against the same SQL run through `pg` — and against itself after a correction is
applied, proving the number follows the ledger rather than a cache.

**Cases.**
1. Report totals equal a raw recomputation over the fixture window.
2. Insert a correcting entry → report moves on the next call (no stored state to drift).
3. Empty range → zeros, not 500. `from > to` → 400.
4. No table named like a report/tally exists in `information_schema` (P1 guard, like NF-03).

**Status.** ✅ shipped (`GET /api/ledger/report`, office-gated; cases 1–4 all in
`tests/ledger.test.ts`). Mutation-checked: counting superseded rows turns the
follows-a-correction case red.

---

## LED-03 — every event carries a disposal site

**Intent.** 105 sites in the source; the field is the point of the report. An app-captured
pump-out with no site is not a completed pump-out.

**Design.** `complete` transition of the stop-status endpoint requires `disposal_site_id`
(existing 105-row `disposal_sites` lookup) and 400-names the field when missing; a CHECK on
`service_events` where `source='app' AND status complete`. Legacy import rows keep their
gaps (they predate the rule and quarantining 40k rows is not the ask) — the CHECK scopes to
app-sourced rows; the plan says so out loud so nobody "fixes" it into a table-wide constraint
that fails import.

**Cases.**
1. Complete without site → 400, body names the field, stop stays `arrived`. *(Shipped
   wording: the refusal answers after the state-machine checks, so a terminal stop still
   hears the fact about its own status first — that ordering is itself a case.)*
2. Complete with valid site → event row carries it; state report groups by it.
3. Site id that does not exist → 400 (not a 500 FK violation — NF-11).
4. Raw UPDATE forcing site NULL on an app row → CHECK refuses.

---

## LED-04 — no-gallons pump-outs are allowed and flagged

**Intent (P7).** 19,202 of 48,216 legacy rows have no gallons; rejecting them would delete 40%
of the ledger. Accept, flag visibly, count honestly in the report.

**Cases.**
1. Complete a stop with gallons omitted → 200; event exists with `gallons IS NULL`; response
   `warnings` names the missing gallons (same channel DRV-07 uses for the unlinked-pumper
   case).
2. State report shows no-gallons events in the count-of-events but excluded from the gallons
   sum — and the report response carries a `events_without_gallons` figure so the gap is
   visible, not silent.
3. Negative or zero gallons → still refused (a recorded 0 is a lie, an absent number is a
   fact).
4. Legacy-import NULL gallons are not re-flagged row-by-row in the API path (nothing reads
   them through the app). *(Amended from the plan: legacy records gallons = 0 — 23,529 of
   them — so a recorded zero turned out to be a real historical value, and inventing a
   refusal would have rewritten the requirement instead of the data.)*

**Status.** ✅ shipped (endpoint refusal by name + `chk_ledger_app_disposal`, scoped
`source = 'app'`; `tests/stop-capture.test.ts` LED-03/LED-04 sections).
Mutation-checked: removing the endpoint gate turns the refusal case red.

---

## BIL-01 — invoice lines reference an event or product, not free text alone

**Design.** Schema-first: `invoice_lines` gets `CHECK (service_event_id IS NOT NULL OR
product_id IS NOT NULL)` + FKs; free-text `description` may accompany a reference but never
replace one. Existing table predates this; migration adds the constraint **only if** existing
rows satisfy it — the migration counts violations first and refuses to run (fail-at-migrate,
not fail-at-insert surprise), quarantining nothing silently (LED-05's spirit).

**Cases.**
1. INSERT a line with `description` only → constraint refuses, by name.
2. Line with `service_event_id` + description → fine.
3. Line with `product_id` (here: `legacy_product_code`) → fine.

**Status.** ✅ shipped (0021, pre-check + `chk_line_reference` + boundary wording in the
adjust endpoint; `tests/billing.test.ts`).
4. The migration's violation pre-check is itself tested: a planted bad row makes the
   migration refuse (then rolled back).

---

## BIL-05 — invoice adjustments link to the original and never edit it

**Design.** `invoices.kind ∈ {invoice, credit, adjustment}` + `adjusts_invoice_id` already
exist per the doc row; verify, and gate the trigger: UPDATEs to an invoice whose `kind` is a
correction document are refused outright; originals are append-only like the ledger (same
trigger pattern as LED-01). `POST /api/invoices/:id/adjust` creates the linked row.

**Cases.**
1. Adjust an invoice → new row `kind='adjustment'`, `adjusts_invoice_id` set; original row's
   totals unchanged (byte-compare before/after).
2. Raw UPDATE of the original invoice's total → trigger raises.
3. Adjusting an adjustment → allowed (chains), still never an edit.
4. Office-gated (driver → 403; AUT-10 list grows).
5. (0035) An adjustment carries a non-blank `reason`; blank/whitespace reason → 400 with the
   message that names what is missing. `adjust_reason` persisted; `created_by` equals the
   office login's id, proven by reading it back from the row, not from a response echo.
6. (0035) `GET /api/invoices/:id` returns a `history` array with the original + the adjustment
   entries — each carries `adjust_reason`, `created_by_name`, `created_on`. The complaint
   answer reads off one call.
7. (sorting) The book sorts by the balance owed. Read-only off the frozen corpus: a row with the
   larger bill but the smaller balance **leads** the smaller-bill/higher-balance row under
   `?sort=balance`, and the reverse under `?sort=total` — so a server that ordered on total would
   fail it. Flipping `dir` flips the whole set; `meta.sort`/`meta.dir` echo back; an unknown
   `?sort=` is refused by naming the columns the list does keep, and that list now contains
   `balance`. Deliberately read-only (no seeded rows) — the reconciliation suites (etl,
   schema-invariants) read these tables mid-run and count an app row as a lost import. The screen
   asserts the Balance header asks the **server** for `sort=balance&dir=asc` rather than ordering
   the one fetched page locally (the book is paginated).

**Status.** ✅ shipped (0020 columns + money-sign CHECKs in 0021; `POST /api/invoices/:id/adjust`;
`tests/billing.test.ts`). Mutation-checked: disabling the invoices money guard turns the
direct-UPDATE case red. The plan's "credit/adjustment columns exist" premise was false —
they arrived in 0020. 0035 added the reason and the who; the corrected-value form is
proven in `InvoicesPage.test.tsx` (editing a line's corrected qty/price files only the
signed difference with the original's reference, a corrected quantity of 0 is the whole
credit, the reason gates the File button, and the detail reads the chain's reason/who).

---

## ETL-04 — county spellings normalise through county_alias

**Approach.** The ETL already landed raw county strings; `county_alias` + normalised
`county_id` exist (0013/0015, DRV-11). What's missing is the transform: fill `county_id` from
`county_alias`, original text retained.

**Cases.**
1. `FDL` (26 rows) resolves to the `Fond du Lac` county id; `county_raw` still reads `FDL`.
2. All 34 source spellings resolve, or the unresolved ones land in quarantine with a reason
   (never guessed — LED-06).
3. Re-run is idempotent (ETL-01's checksum guard covers it; assert no duplicate alias rows).
4. The 49 properties with no county remain unresolved after the pass — the transform refuses
   to invent (count asserted, per 0013's decision). *(Measured at test time: 38 — the row's
   49 predates 0013's accounting; the suite measures the current corpus.)*

**Status.** ✅ shipped (`tests/etl.test.ts` ETL-04 block — the transform itself already
existed; what was missing was its proof). Mutation-checked twice: re-pointing the `FDL`
alias at Calumet reddens the alias cross-check. The first version of one case was a
self-join tautology and survived that mutation — its replacement names the expected county
independently of the rows under test, and the comment says so.

---

## DRV-14 — conflicts resolve by ownership; no merge logic exists

**Design decision (from the requirement itself):** keep it a *guard*, not a feature. Server
owns schedule/status; device owns notes/photos (append-only). So the test asserts the shape
of the system:
1. Two writes to one stop's status: last-writer-wins *with version check where ordering
   matters* (SCH-10 covers reorder; status transitions reject illegal states regardless of
   who sends last).
2. Notes/photos for the same stop from two devices → both rows exist; no dedupe/merge on body.
3. A static guard: no `merge`-shaped code exists (scan for COALESCE-style field merge in
   the write path — like NF-02/NF-03 style greps).
4. Device cannot write schedule/status columns it doesn't own (already pinned by stop-capture
   tests — cross-reference, don't duplicate).

**Status.** ✅ shipped (`tests/media-capture.test.ts` DRV-14 block). The notes endpoint is
append-only by construction; two tokens, same note text, two rows — asserted. The merge guard
is a source scan (`UPDATE job_notes`, `mergeX(`, body-COALESCE, and no PUT/PATCH/DELETE on the
notes router). `job_notes.client_uuid` turned out to have **no unique constraint**, making the
replay check fiction under a race — fixed forward in 0024.

---

## DRV-15b — image pipeline records dimensions (3 MP cap applies)

**Design.** The upload endpoint (built here, DRV-16/18 share it) decodes the image server-side
(`sharp`), records `width`/`height` on `media`, and enforces total pixels ≤ 3,000,000 —
computed from the *re-decode*, never from headers or client claims (DRV-15's lesson).

**Cases.**
1. 2000×8000 (16 MP, narrow — passes naive edge caps) → refused, by pixel total.
2. 10000×300 panorama (3 MP exactly) → accepted; dimensions recorded exactly.
3. Dimensions in the response/row match what `sharp` measured, not what the client claimed
   *(stronger in the shipped shape: the upload carries the bytes as raw base64, so the client
   cannot claim dimensions at all; the test still posts `width: 1, mime_type: text/plain` and
   requires it to be ignored).*
4. Non-image body → 415.

**Status.** ✅ shipped (`POST /api/media/upload`; 413 by pixel total, exactly-3MP accepted,
DB CHECK agrees with the recorded dimensions). Mutation-checked: an edge-based cap (16384/side)
lets 2000×8000 through and reddens the refusal case. Two fixture bugs surfaced: JPEG segment
lengths are big-endian (a little-endian length made every parser call the fixture corrupt),
and content-addressed dedup means run-salted fixtures must differ in **content** — two fixtures
that differed only in source quality collapsed to identical bytes after the q82 re-encode and
one test answered with the other's row.

---

## DRV-16 — EXIF stripped by default; GPS only on explicit opt-in

**Cases.**
1. Upload a JPEG with GPS EXIF (fixture generated with coordinates embedded) → stored bytes,
   re-fetched from object storage, decode to an image with **no GPS tags** (read them back
   with `sharp .metadata()`: no `exif` GPS keys).
2. `media.gps_lat/gps_lng` are NULL by default even though the source file had them.
3. Upload with `gps_opt_in=true` + coordinates in the body → lat/lng stored (from the
   request, not scraped silently… decided in plan: opt-in stores what the *client* submits at
   capture time, since EXIF is stripped unconditionally — the opt-in flag's meaning is
   documented in the response).
4. Byte size of stored object ≠ source byte size (re-encode happened) — pinned with
   inequality, not a constant.

**Status.** ✅ shipped. The GPS-bearing fixture is a hand-built EXIF/GPS APP1 segment spliced
after SOI — `sharp` confirms it before upload; the stored object is fetched back through
`GET /api/media/:id/raw` and contains no APP1 and no EXIF. Strip-by-re-encoding, so there is
no scrubber to forget. Opt-in stores body coordinates only; coordinates without the flag are
observably discarded. Mutation-checked: `.withMetadata(true)` reddens the strip case.

---

## DRV-18 — retried photo upload does not duplicate, keyed on sha256

**Cases.**
1. Upload the same bytes 3× (different client_uuids) → one `media` row, three 200s with the
   same id (200-on-replay semantics from DRV-13).
2. Same client_uuid replay → same row (client_uuid UNIQUE path still works).
3. Two different files, same sha256 claim in body → refused on content hash mismatch
   (the body's hash is a checksum, not an identity).
4. Object storage holds one key per sha256; the retry wrote nothing second (`ListObjectsV2`
   prefix count from inside the container).

**Status.** ✅ shipped (dedup read + advisory lock + `uq_media_sha_live` in 0024, partial so a
soft-deleted photo may be re-uploaded). Mutation-checked by deleting *both* the endpoint's
dedup read and its ON CONFLICT clause — the second upload then dies on the index, which is the
behaviour a reviewer should want. The mutation initially escaped the first two attempts because
the dev watcher never loaded the mutated file (in-place writes do not trigger respawn on this
bind mount — only `cp`-style replacement does; mutation runs now restart the container).

---

## Cross-cutting (applies to every requirement above)

- Every new mounted route gets a README.md table row (repo-hygiene test enforces both
  directions).
- Every new table column gets an entity declaration (entity-schema test).
- New office writes join the AUT-10 enumeration.
- `docs/REQUIREMENTS.md` row + `QUALIFIED`/`PENDING` sets + §9 counts move together —
  enforced by the checklist test, not by hand.
- Each implementation is mutation-checked per the house rule: introduce the exact bug the
  test claims to catch; the named test must go red.

---

## BIL-06 — Payments are their own rows; the balance is arithmetic

**Design.** `POST /api/invoices/:id/payments` inserts a row into a new `payments`
table — amount, method, received_by, note, optional `client_uuid` — and then, in
the same transaction, recomputes `invoices.amount_paid` as the SUM of that
invoice's payment rows and derives `status` from the comparison with `total`
(open / partial / paid). The recomputation is deliberately a re-sum from the
payment rows rather than an increment: an increment compounds; a re-sum is
idempotent and self-healing, and if the column ever drifts from its source the
next payment fixes it and a test can prove it.

The guard from 0020 already anticipates this: money columns are frozen and the
comment says payment bookkeeping must keep moving. `payments` itself gets the
append-only trigger — a receipt that can be edited is not a receipt. A wrong
payment is fixed the way every other wrong record in this system is fixed: a
correcting row (here: a second payment with a negative amount? **No** — amounts
are CHECK > 0; a refund goes through BIL-05's adjustment invoice, which keeps
one ledger of corrections instead of two). Overpayment is refused with the
balance named in the message, because $50 against a $185 balance is a typo, and
the typo should be caught by the person holding the check.

**Cases.**
1. The story in the requirement, end to end: payer "Jane Smith", invoice 335.00,
   payment 150.00 → status `partial`, balance 185.00, the payment row says who
   received it and when. Then 185.00 → status `paid`, balance 0.
2. Recomputation, not increment: plant a payment directly (fixture), re-post the
   endpoint, and the column equals the SUM of the rows, not old+new.
3. Overpayment refused; the refusal names the remaining balance.
4. `void` invoices refuse payments (404/409 — a void invoice is not collectible).
5. Append-only `payments`: UPDATE and DELETE through pg raise 42501 (the 0020
   trigger family), and no edit/delete verb exists on the route.
6. `amount` must be a positive number, `method` a bounded string; client_uuid
   replay returns the first receipt (DRV-13 semantics, same as notes).
7. An adjustment (negative-total invoice, BIL-05) reduces the payer's balance
   through the same arithmetic — asserted here rather than in BIL-07's test
   because it is an arithmetic property of the derivation.

**Mutation plan.** Make the endpoint *increment* instead of re-sum → case 2
reddens. Remove the overpayment guard → case 3 reddens. Drop the payment guard
trigger → case 5 reddens.

---

## BIL-07 — Accounts receivable is computed, never stored

**Design.** `GET /api/receivables` (office): one row per payer that owes money —
billed (SUM of non-void totals, adjustments included as negatives), collected
(SUM of payments), balance, oldest open invoice date — with `balance > 0` the
filter itself. Same rule as LED-02: `tblStateReports` is gone because tallies
drift; a stored "balance owed" column would be the same mistake with money on
it. The invoice rows behind a payer are already reachable (`GET
/invoices?payer_id=`), so receivables is the aggregate and the book is the
drill-down.

**Cases.**
1. Jane Smith again: 335 billed, 150 collected, 185 balance, and the row's
   invoice count is 1. Asserted against an independent SQL recomputation
   (ledger-report's pattern) rather than a constant.
2. A fully paid payer is absent from the list — `balance > 0` is the definition,
   not a display filter.
3. A void invoice is excluded from billed and its payments... (payments cannot
   exist against voids per BIL-06, but a paid-then-voided legacy row is exactly
   what the corpus may contain — assert the SQL handles it by excluding the
   invoice from billed and showing the payment so the balance can go negative
   *and that is visible*, i.e., the row's balance equals billed−collected even
   when negative, and a test documents why negative balances appear).
4. Adjustments: invoice 335 + adjustment −100 → balance 235 with 1 collected-0.
5. Ordering by balance DESC (the person at the desk is chasing the biggest first).
6. `?q=` narrows by payer name (the screen's search).

**Mutation plan.** Exclude payments from the collected SUM → case 1 reddens.
Drop the void exclusion → case 3 reddens.

---

## BIL-08 — An invoice can be printed as a document

**Design.** Frontend route `/invoices/:id/print`, deliberately outside the app
chrome: header, payer mailing block (BIL-04 of the *other* kind — mail is the
only delivery this business has: 0 payers have email, SCH-07), line table,
totals, and the payment history including the running balance — the statement
the office actually mails. `window.print()` fires on load when asked
(`?auto=1`); a Print button covers the case where the browser blocks it.
`@media print` hides the button. No PDF on the server: the browser's own print
dialog is the PDF generator, and one fewer dependency that renders text is a
win when the text is a legal demand for money.

**Cases (render tests, RTL).**
1. The number, the payer name, every line, the money, the balance, and each
   payment row appear on the page.
2. Auto-print calls `window.print` exactly once when `auto=1` (mock the global).
3. A credit/adjustment document says so — a negative document printed to look
   like an invoice is how refunds get argued about.
4. Balance math on the page: total − paid = balance, from the row's own numbers.
5. The sheet itself (`T-BIL-08b`, as-built 09/06): `@page { size: letter }` with
   human margins, the white-on-white chrome gone via `.no-print`, the line table
   repeating its header across pages and refusing to split a row, and exact grays
   rather than the washed-out defaults. Asserted by reading **every** `<style>` tag
   the render emitted — emotion injects its own, and `querySelector('style')`
   silently inspects the wrong stylesheet.
 6. (as-built 09/14, revised 09/15) **The consolidated statement** — the one paper the
    office can mail for a corrected bill, and the reason James Kiesner's $1,100 bill with a
    −$20 credit and a $1,080 check had to stop reading *partial / $20 owed*. It bills the
    head **as issued** and reconciles it in a server-summed **payments-and-adjustments ledger**.
    Backend (`billing.test.ts`, `BIL-05 × BIL-08`): the statement's `total` is the bill's own
    `$1,100`; a lone `−$20` correction becomes a signed ledger entry running to `$1,080`, and
    a following `$1,080` receipt is a second entry running to `$0.00` with the header reading
    `paid`; `body.data.balance` is netted (no $20 gap left to fall into); opening the **credit**
    still hands back the head-headed paper (`statement.invoice_id` = the original); a plain bill
    nets to exactly itself. A payment posted to the corrected bill is capped and statused against
    the **netted** owed, so the discount closes the account and an overpayment names the corrected
    balance. Frontend (`PrintInvoicePage.test.tsx`): `?statement=1` renders the bill's line and
    Total `$1,100.00`, then the correction as its own signed ledger line naming the document it
    was filed under (`invoice #…`) and carrying its reason, and — with the receipt — draws the
    balance due to `$0.00`, presented as an invoice (no "not an invoice" banner); without the
    flag it stays the single record as filed. The statement also prints the company's terms
    (from `GET /api/settings`), so the demand carries its own disclosure.
 7. (as-built 09/16, `T-BIL-08c`) **The letterhead is read, not hardcoded.** The office sets
    name, logo, address, email and phone once (`company_settings`, 0037; `PATCH
    /api/settings/company`); the header prints them. Asserted in `PrintInvoicePage.test.tsx`:
    the settings-supplied name/address/email/phone appear and the old hardcoded name does not;
    a stored logo is fetched through `settingsService.getLogoUrl` (the bucket is private —
    a bare `<img src>` could never authenticate) and rendered; with no logo no image is
    requested; and a logo whose fetch fails still prints the whole document — a missing
    logo is a plainer paper, never a blank page.

---

## DRV-07 (round two) — the disposal site, end to end
*Plan written after the fact; the shipped tests are T-DRV-07b and the
StopActions site-guard cases. Recorded here so the file stays the ledger of
what the tests mean.*

**Bug design.** The server had always refused `done` without `disposal_site_id`
(a service event without a site is not the compliance record the state report
is assembled from), and every existing test satisfied the rule by reading a
site id **from the database** — an assumption a phone cannot make. The driver's
Done tap came back 400, the queue dropped it as refused-on-facts (correctly,
per DRV-14), and the screen admitted nothing: stops ended `no_access` with
arrivals recorded and zero pump-outs.

**Cases.** Backend `T-DRV-07b`: a driver token can `GET /disposal-sites`; every
row has `id` + `name`; and one id taken **from that response** is enough to
finish a stop — 200, with the event's `disposal_site_id` equal to the row the
driver chose. Frontend: `Confirm done` is disabled until a site is chosen; the
recorded write carries the site id as its own argument; the queued body carries
`disposal_site_id` inside it (a second request that can fail alone is a second
request that will).

**Mutation plan.** Drop `disabled={site === ''}` → the guard case reddens. Drop
the endpoint → the round-trip case reddens. Serve an empty list → the Done row
says "Disposal sites unavailable" instead of offering a death.

---

## Office board — the day moves underneath
*Also post-hoc: this began as a user complaint ("reload the screen when a
driver says they've arrived"), which is a requirement by another name.*

**Cases** (`RouteComposerPage.test.tsx`). The day is re-read on a ~15 s timer
without being asked; a failed poll keeps the rows it already had — "could not
refresh" must never render as "nobody routed today".

**Mutation plan.** Remove the interval → both cases reddens. Make a failed poll
clear the list → case 2 reddens.

---

## DRV-20 — the disposal site is implied, not typed

**Design.** One row of `company_settings` names the default site; `GET
/api/disposal-sites` marks it with `is_default`; the driver's Done dialog
opens with it already chosen. Override stays available — when the truck
genuinely went elsewhere, that fact belongs on the record, and it costs one
tap, not a hunt. The *server* never applies the default: `done` must still
name a site, because a value the server invented at 2pm is not something the
office can defend in a county audit. (Seed value: the most-used legacy site —
a guess, and the office UI exists so the guess can be corrected.)

**Cases.** `T-DRV-20` (backend): the list has exactly one `is_default`; a
PATCH by office role moves it and the list agrees; a driver PATCH is 403;
`done` with no site is *still* 400 — the default is a UI affordance, not a
loosened rule. Frontend: the Done row pre-selects the default and Confirm is
live before any tapping; choosing another site changes what is recorded.

**Mutation plan.** Make the server apply the default when absent → the 400
case reddens (deliberately). Drop `is_default` from the list → pre-fill test
reddens.

---

## SCH-11 — the office can add and edit a site

**Intent.** The office takes on new customers, so the site list cannot be a
frozen migration artifact; and the edit surface must not become the legacy
`tblCustomers` again, where the next-due date was whatever somebody last typed
into it (P1). Two endpoints: `POST /api/properties` (create) and
`PATCH /api/properties/:id` (narrow, whitelisted edit). No DELETE on the
surface at all — the honest retire is `status`.

**Cases** (`site-admin.test.ts`). Office token creates a site with an address
and gets 201 back, with `last_service_date` and `next_service_due` NULL (no
service date, no arithmetic — the row has no history yet). A body that names a
server-owned column (`next_service_due`, `last_service_date`, `legacy_memo`,
`county_raw`) is refused by *naming that column and why* — not ignored, because
a silently-dropped field is how the legacy app learned to lie about due dates.
An edit changes whitelisted fields and nothing else; the generated due date
moves only via its inputs (`service_interval_days`), never by hand. A second
create with a used `legacy_cust_number` is 409 naming the number, not the
constraint. `service_interval_days ≤ 0` and a fifth `status` are 400. A driver
token is 403 on both (also pinned in `office-gate.test.ts`).

**How it could fail.** A full-row `save()` would clobber `last_service_date`
between the read and the write — the mutation plan is to hand-write a service
date, PATCH an unrelated field, and demand the date survives. A whitelist that
forgot `insert:false` on the generated column 500s at Postgres instead of 400.
Test rows are created with a `@test.invalid`-era payer label and deleted in
`afterAll`; a crashed run leaks sites that will fail reconciliation for
someone else.

**Mutation plan.** Add `last_service_date` to the whitelist → the server-owned
case reddens. Ignore unknown fields instead of refusing → the naming case
reddens. Make PATCH a row-save → the survives-the-edit case reddens.

---

## LED-07 — the office maintains the disposal-site vocabulary

**Intent.** AGENTS.md already assigned this: "the office owns tidying that
table, nothing in code guesses at it." 105 legacy free-text names (`Land`,
`Slurrystore`) now have an office surface: `POST /api/disposal-sites`,
`PATCH /api/disposal-sites/:id`, `DELETE /api/disposal-sites/:id`. The list
stays driver-readable (OPEN_READS) — a gated vocabulary is how DRV-07 round two
happened. Renaming is safe because the ledger references sites by **id**;
deleting is only safe while nothing names the row, and the enforcement is
RESTRICT plus a refusal that says so.

**Cases** (`site-admin.test.ts`). Create returns the row; a second create with
the same name is 409 naming the name (UNIQUE, not the constraint). The list
gains `events_using` so the office sees what the ledger names before it tries
to delete it. Renaming a site the ledger names (picked from the corpus,
restored in the same test — SCH-06's discipline) changes the name on the
joined history without touching a single event row: identity lives in the id.
DELETE of a never-named site is 200 and the row is gone; DELETE of a site with
`events_using > 0` is 409 naming the site and the count; DELETE of the
company default is 409 naming the default, even if unreferenced. Driver token:
403 on all three writes (pinned in `office-gate.test.ts`).

**How it could fail.** A CASCADE-shaped delete would point 2,965 regulatory
events at nothing; the RESTRICT check is the whole requirement, so the test
picks a site the corpus *actually* names. A rename that also re-points events
would be editing history — the test asserts the event ids' `disposal_site_id`
is unchanged across the rename. If the suite aborts between rename and
restore, the corpus name is left renamed: the restore is in a `finally`.

**Mutation plan.** Remove the `events_using` pre-check and let Postgres throw →
the 409 message becomes an internal-error reference, and the case demanding the
name and count reddens. Swap id for name in the join → the history-follows-the
-id case reddens.

---

## SCH-12 — a biller is created from a form, never from a keystroke

**Intent.** `payers.controller.ts` has said since day one that a payer "is created when the
paperwork is right, which is an office decision with a form behind it, not a side effect of
typing into a reassignment box." The site-add flow made that form real demand: a brand-new
site's `payer_label` is free text with no `payers` row behind it, so the biller search could
find nothing to select. `POST /api/payers` is the form. The discipline it protects: a payer
row is the thing invoices accumulate onto, and one invented per typo is how the legacy corpus
got 1,047 rows with 1,034 "distinct companies".

**Cases** (`payer-admin.test.ts`). Office create lands a row and answers with the same shape
search will show (`name`, `sites_owned: 0`). A body with no name at all — neither an
organization nor a person — is 400. `mailing_state` is two letters, normalised like a site's.
The new payer is immediately selectable *and assignable*: `POST /properties/:id/owners`
against it opens the first ownership row (close-nothing, open-one), asserted through the
API, not assumed. A driver token is 403 (also pinned in `office-gate.test.ts`).
No `legacy_billing_no` is accepted — a new payer has an id, and the legacy column is not a
sequence to hand out. Duplicates by name are *not* refused: two households named Whitty are
real, and the search's `sites_owned` ranking exists precisely to tell them apart.

**How it could fail.** Creating a payer and assigning it in two calls is not one transaction,
and the UI does not pretend it is: a create whose assign fails leaves a billable row with zero
sites, which is a fact the office can see and re-use, not a half-write the server hides.
Frontend: the empty search result must offer the form and the form must not fire while typing.
Test rows (payer + ownership) are deleted in `afterAll`; a crashed run leaks a payer that will
show up on someone else's dropdown.

**Mutation plan.** Fire the create from `onInputChange` → the "no create while typing" case
reddens. Drop the name requirement → the 400 case reddens. Hand out `legacy_billing_no` →
the column-trust case reddens.

## T-SCH-13 — add an open site to a driver's day (`POST /api/routes/stops`)

**Asserts.** A named driver + a date + this site: the site is a `pending` stop on that
driver's route for that date, at the end of the sequence — whether that route existed
before this request or not. `route_created: true|false` says which, because the clerk
should hear that they just made the day, not discover it later.

**Cases** (`schedule-site.test.ts`). First stop of a nonexistent day creates the draft and
appends (`route_created: true`, `sequence_no: 1`). Same driver+date, second site: same
`route_id`, `route_created: false`, sequence continues — the `(route_date, driver_id)`
duplicate rule of `POST /routes` is *not* reached, because this endpoint was built to
survive it. The clash case is the reason for the transaction: a site already routed to
driver A that day, offered to driver B, is 409 naming A and the date (SCH-08's exact
sentence), **and driver B's day must not exist afterwards** — asserted by counting B's
routes for the date before and after; a client-orchestrated create-then-append would leak
an empty draft here, which is exactly what the single transaction is for. Already on this
route → "This site is already on this route." A published day → 409 naming driver, date,
and the remedy (unpublish), and the site is not added. Guardrails reuse the create
sentences: unknown driver 404, non-driver role 409 by name, disabled driver 409, missing
or malformed date 400, unknown property 404 (and the property check lands before any
write). Driver token 403 is pinned in `office-gate.test.ts`.

**How it could fail.** The advisory lock must be taken on the *same key format* as
`addStop` — `hashtext('route_stop:' || property_id || ':' || route_date)` — or two
endpoints double-book with each other while each is internally correct; a test books via
this endpoint and attempts the same site/date via `/routes/:id/stops` to prove they see
each other. The find-or-create reuses the COALESCE-scalar-subquery shape of `create` with
its snapshot caveat intact (concurrent first-creates of the same day can race to a 500 —
two clerks, one millisecond; recorded, not fixed, because fixing it means a lock the whole
suite would pay for).

**Mutation plan.** Remove the transaction (create, then append, no rollback) → the
"driver B's day must not exist" assertion reddens. Drop the advisory lock → the
cross-endpoint double-book case reddens. Trust the caller's `route_created` instead of
computing it → the second-site case reddens.

## T-BIL-09 — the master price list (`/api/bid-items`)

**Asserts.** Office CRUD over a catalog of `(name, unit, unit_price, is_active)`: create
answers the row, list shows it, an edit moves the price, and `is_active=false` retires it
from the picker without erasing it. Money is `numeric` end to end — `'300.00'` in,
`'300.00'` out, never `300.00000000004`.

**Cases** (`bids.test.ts`). Create with name+unit+price; missing name / empty unit /
negative price are 400 naming the field. An unknown field on the body is refused by name
(SCH-11's rule: an ignored field is a field somebody will believe they set). A price edit
changes what the *list* says and changes **no bid line that ever copied it** — asserted
against a bid lined before the edit, because "the catalog is not history; the bid is"
(BIL-10) is worth nothing if it is only true in prose. Retire-and-relist round-trips the
flag. A driver token is 403 on every verb that writes (also pinned in `office-gate`).
No DELETE is offered: retired rows stay — asserted by retiring and re-selecting the row
still by id.

**How it could fail.** Storing price as float (a `300.1` sum drifts); deleting instead of
retiring (old provenance dies with the row); letting the list silently accept an empty
`unit` (a line item priced "per nothing" is how hours get billed as eaches).

**Mutation plan.** Switch the column to `float8` → the exact-string money assertion
reddens. Offer DELETE → the provenance case reddens. Accept a negative price → the
refusal case reddens.

## T-BIL-10 — a bid is a document addressed to a payer

**Asserts.** `POST /api/bids` opens a draft for a payer row (optionally naming a site);
lines are added **from the price list** — copying description/unit/unit_price at the
moment of adding — or as free-text one-off lines. `payer_id` must exist: the 404 names
the thing needed next, and the UI's empty biller search is already one click from
SCH-12's form.

**Cases** (`bids.test.ts`). Create lands a draft dated by the server (`bid_date` equals
`business_today()`, not the client's clock — a body that sends `bid_date` is refused by
name; the server owns every clock-written field). A line from a catalog item: `bid_item_id`
recorded, description/unit/price **copies of that moment**; then the item's price is
edited and the line is byte-for-byte unchanged — the copy is the requirement. A free-text
line lands with `bid_item_id NULL` (legal on a bid; BIL-13 decides when free text stops
being free text). An unknown property id 404s; a non-active catalog item can still be
added by explicit id (retirement hides it from the picker, it does not forbid the office
from knowing better than the picker).

**How it could fail.** Storing references instead of copies (the price-list edit of
T-BIL-09 reaches into last month's documents); creating bids with no payer (an invoice
addressed to nobody, SCH-12's argument one step earlier); trusting the client's date
(P10 — the fixture is 635 days from the wall clock).

**Mutation plan.** Drop the copy and join through `bid_item_id` at read time → the
price-drift case reddens. Accept a client `bid_date` → the server-clock case reddens.

## T-BIL-11 — the arithmetic the keyboard may not type

**Asserts.** `line_total` is `GENERATED ALWAYS AS (unit_price * quantity) STORED`:
the canonical pair from the requirement text is asserted literally — labor 3 × $300.00 =
$900.00, pipe 100 × $3.00 = $300.00 — and the bid detail's total derives as $1,200.00,
per request, from no stored column. A body naming `line_total` or `total` is 400 by name.
Quantity `0`/negative and price negative are refused; quantity `0.5` (half an hour) is
not — `numeric(8,2)` keeps it exact.

**How it could fail.** The generated column defined but the API still accepting a client
total *anyway* in a second code path; totals stored "for performance" and drifting after
a line edit — the suite edits a quantity and re-reads the total to prove it followed.

**Mutation plan.** Make `line_total` a plain column with a default → the
`GENERATED ALWAYS` 4212-style refusal (naming the column) reddens. Store the total on the
header → the edit-then-re-read case reddens.

## T-BIL-12 — approval is a signature

**Asserts.** `POST /:id/approve` on a non-empty draft stamps `approved_by` (the caller's
own id, read from the token — the body that tries to name a different approver is
refused) and `approved_at` (server clock), and moves status; `decline` is terminal with
an optional note. After approval every mutation endpoint — add line, edit line, remove
line, re-approve, decline — answers 409 naming the status, and the row is unchanged in
the database, not merely refused in the response.

**Cases** (`bids.test.ts`). Empty draft cannot be approved (the publish-with-no-stops
rule wearing a document's clothes). Approve twice: the second names the first's
timestamp or refuses; it does not overwrite either. Declined: approve is refused
("a declined bid is a decision, reopen means a new bid"). Draft lines remain freely
editable up to the signature — the asymmetry (before: anything; after: nothing) is the
requirement, and both directions are asserted.

**Mutation plan.** Let approve overwrite `approved_at` → the twice-approved case reddens.
Skip the status guard on the line endpoints → the frozen-after-approval case reddens.

## T-BIL-13 — one approved bid, one invoice, one transaction

**Asserts.** `POST /:id/convert` on an approved bid writes, in one transaction: an
`invoices` header (payer, `invoice_date = business_today()`, `source`-equivalent
`kind='invoice'`, totals summed from lines server-side, **no** `service_event_id`),
one `invoice_lines` row per bid line carrying `bid_line_id`, description, quantity,
unit_price, amount — and sets the bid's `invoice_id` and `status='invoiced'` in the
same transaction. `chk_line_reference` accepts the third reference because 0028
redefined it as three-way, and a line that names *nothing* (service event, product,
bid line — none) still fails: the constraint got wider, not weaker, and both the new
acceptance and the surviving refusal are asserted.

**Cases** (`bids.test.ts`). Draft → convert refused (approve first, by name). Empty
approved bid cannot exist (BIL-12 refused its approval), so conversion of an
approved-with-lines bid is the only shape. Convert twice: the second 409 names the
invoice id that already exists, and the database still holds exactly one invoice for
the bid — and the *same* twice, fired as `Promise.all` of two concurrent POSTs: the
bid row's `FOR UPDATE` must serialize them into one 201 and one 409, which is the
behavioural proof the transaction holds (widths of `bid_lines.description` and
`invoice_lines.description` are identical at 255, so a planted overflow could not
force a partial failure anyway — the double-click is the failure that is actually
reachable). The invoice's line money equals the bid's line money to the cent — every
line, asserted field for field against the bid's copies. The invoice detail response
resolves the bid-line origin (a clerk asking "what is this charge?" gets an answer).

**How it could fail.** Two invoices from double-clicking Convert (the
`(bid_id)`-once rule is a transaction + status guard, and the test fires convert twice);
invoice totals trusted from the client; the invoice landing without the bid-line
references, which BIL-01's constraint would only notice if something kept checking it —
the surviving no-reference refusal is the proof it still does.

**Mutation plan.** Drop the transaction (header, then lines) → the orphan-header count
reddens. Widen `chk_line_reference` by dropping the service-event/product arms instead
of adding the third → the no-reference refusal reddens.

## T-BIL-14 — the money machinery never noticed the new invoice

**Asserts.** Against a converted bid, with no new endpoints: `POST /invoices/:id/payments`
takes a $500 check and `amount_paid` re-sums to `500.00` (BIL-06's drift mutation re-run
on a construction invoice), status derives `partial`; overpaying past $1,200.00 is
refused naming the balance; `GET /receivables` shows the payer owed $700.00, and the
Recompute path re-derives the same; the invoice print view renders the bid's line
descriptions and the running balance.

**How it could fail.** Receivables filtering on `service_event_id IS NOT NULL` (it does
not today; the assertion is that it never will); print views keyed to pump-out shapes.

**Mutation plan.** Add `AND service_event_id IS NOT NULL` to the receivables query →
the $700.00 case reddens. (Reverted; the case is the guard against a future "fix".)

## T-BIL-15 — the bid prints

**Asserts.** The print view renders bid number/date, the payer's mailing block from the
bid detail's own payload (one request per document — BIL-08's rule, restated because a
second screen must not learn it the expensive way), every line with its unit and the
server-computed money, and the total. `window.print` is stubbed (jsdom has none) and the
assertion is on the **document**, not the button.

**Cases** (frontend `BidPrint.test.tsx`). A bid with the two canonical lines prints
"900.00", "300.00", "1,200.00" — the formatted, server-sent values; an approved bid's
print carries the approval date (the paper says who said yes and when); declined bids
are not printed (no route renders them, asserted by the list's affordances).

**As-built (09/16) — the bid's sheet is the invoice's sheet (`T-BIL-15b`).** Bids were
printing badly while invoices printed perfectly, and the diff was the stylesheet: the
bid page hid only the app bar and drawer, so the browser drew its own headers into the
page-margin box, the 240px `nav` gutter stayed reserved inside the page, and the column
was 720px-capped with washed-out grays. The bid now carries `T-BIL-08b`'s assertions
pointed at its own page — every emitted `<style>` tag must know about `@page` letter
sizing, `break-inside: avoid`, `table-header-group`, `print-color-adjust: exact`, the
drawer *and `nav`* gone, the print button inside `.no-print` — so the two sheets cannot
drift apart again. The letterhead assertions (settings-supplied name/contact, fetched
logo) run here too: the signed quote and the later bill cannot disagree about who wrote
them (the old headers were two hardcoded strings that disagreed by name).

## T-BIL-16 — a system-wide sales tax, frozen by the signature

**Asserts.** One rate, in the one-row `company_settings`: `GET /api/settings` answers
`sales_tax_rate` (`0.0000` until the office says otherwise — the legacy corpus charged
tax on 0 of 3,283 invoices, so 0 is the measured default, not a placeholder);
`PATCH /api/settings/sales-tax` moves it, `updated_by` names the office user who said
so, and the value is a *rate*: `1.5` is refused (`CHECK (0 ≤ r < 1)` — the bug the
check exists for is the clerk who types 5.5 into a decimal field, or 150 into a
percent field, and bills half again as much).

**As-built (09/15) — the row gained its two term columns.** The same `GET /api/settings`
now also answers `payment_term_days` and `late_fee_rate_monthly`; `PATCH
/api/settings/payment-terms` moves both, `updated_by` names who, and the late fee shares
the tax field's `CHECK (0 ≤ r < 1)` for the identical reason — `1.5` typed as a rate would
print a 150% monthly penalty. (`settings.test.ts`; the gate is `office-gate.test.ts`, which
proves the route is mounted and 403s a driver.)

**As-built (09/16) — the row answers "who is the company" (`0037`).** `GET /api/settings`
now also answers `company_name`, `logo_media_id`, `address`, `email`, `phone`; `PATCH
/api/settings/company` moves them and is the office gate's newest entry (a driver 403s,
the admin sweep proves it is mounted with a payload that refuses by naming the unknown
field, so the gate test can never land a letterhead). Cases in `settings.test.ts`: the
fields read back beside the rates with `updated_by` stamped; `null` clears a contact
field; an invented field is refused **by name** and the row demonstrably keeps what it
had; a `logo_media_id` naming no live `media` row is refused by naming the id (the
letterhead is a pointer — bytes live in object storage, NF-04 stands — and the papers
refuse to print a logo whose bytes are gone); a blank name is refused because it heads
every document. Frontend: `SettingsPage` sets these beside the rates (the logo uploads
through `POST /api/media/upload` the moment it is chosen — the server's re-encode is the
only validator, and finding out at Save would be the worst time), and both print pages
render what this row says rather than what a component hardcoded.

**Cases** (`bids.test.ts`). The lifecycle joins the tax: an unapproved bid's detail
carries the *current* rate and a computed estimate labelled as an estimate; approval
stamps `bids.tax_rate` (server clock, server reading of settings — a body that names
`tax_rate` is refused by name); the rate is then moved in settings and the approved
bid's money has not moved, asserted to the cent — this is the same sentence BIL-10
tests for prices, charged now against tax. Conversion at a stamped `0.055` against the
canonical $1,200.00: `tax_amount = 66.00`, `total = 1,266.00`, `invoice.tax_rate =
0.055` — the invoice's own columns now disagree with the (moved) system rate, and the
invoice is right, because the invoice is the record. Settings at 0 reproduce the
user's example exactly: total $1,200.00, tax line prints `0.00`. Rounding is SQL's
(`round(subtotal × rate, 2)`), asserted on a subtotal that makes it bite. The receipt
path then does its thing against the tax-inclusive total (BIL-14's arithmetic rebased:
$500 against $1,266.00 owes $766.00), and `amount_paid ≤ total` never needs the
constraint to shout.

**How it could fail.** Storing the percent (5.5) where the decimal (0.055) lives —
caught by asserting the GET shape *and* the arithmetic; reading settings at *conversion*
instead of honoring the stamp (a Tuesday rate hike reaching a signed Monday bid — the
exact thing BIL-16 exists to prevent); computing tax at the keyboard.

**Mutation plan.** Read `company_settings.sales_tax_rate` inside convert instead of
`bids.tax_rate` → the rate-moved-after-approval case reddens. Drop the `< 1` check →
the 150% case reddens. Frontend: multiply at display time with a percent the screen
typed → the print's money stops matching the server's.

## T-BIL-17 — the price list, managed

**Asserts.** The management screen is a faithful rendering of T-BIL-09's server and
adds no client-side doctrine: adding an item sends name/unit/price as typed strings
(money never passes through a float) and the list re-reads — the row appears because
the server sent it, not because the page appended it; editing a price in place is a
PATCH and a re-read (the list is a current reference — BIL-09 made an edit lawful and
T-BIL-09 proved old bids do not move); retiring is a PATCH `is_active: false` that
names its target by id, and the page offers **no delete at all** — a test asserts the
affordance is absent, because "we never delete price history" is only a rule if the
UI cannot violate it; retired rows are hidden by default and shown on request, and
the picker's list (active-only) is the same server predicate, not a client filter.
Server refusals — a negative price, a missing unit — arrive on screen in the
server's sentence, unparaphrased.

**Could fail by:** the retire button shipping a DELETE against a route that refuses
it (the mutation check); the retired list leaking into the picker by a client-side
filter drifting from the server's `WHERE is_active`; price strings passing through
`Number` and landing on the wire as `300` where the row expects `300.00`.

## T-BIL-18 — a site one door away from the bid

**Asserts.** The new-bid dialog's site search keeps BIL-10's bargain exact: typing
finds, nothing more — a test asserts `POST /properties` is untouched while the query
is typed. An empty result offers the button, the button opens the form, the form
creates with the trimmed typed-as-number discipline, and the created site becomes the
pick **by the id the server named back** (a same-named Lot 7 already in the ledger is
why the id, not a re-search, is the pick); choosing it and creating the bid carries
`property_id` of exactly that row. The form requires the address alone — empty
address keeps the create button dead; the legacy customer number is not a field,
which a test pins by absence, because inventing a legacy number is inventing history.
The created row is real: a re-read sees it; the dialog never draws a site it did not
get from the server.

**Could fail by:** the empty-result button shipping a create-on-type (typing would
then make properties the way SCH-12 swore searches do not make billers); the pick
being re-discovered by address text after the create (two Lot 7s is the real world);
the site id reaching the bid as the *payer's* id when the two create paths share
state variables.

## T-SCH-14 — the confirmation hands the clerk to the route (`PropertyDetailPage` → `/routes?date=&focus=`)

**Asserts.** After a successful add, the dialog still shows the confirmation sentence (SCH-13's words, unshortened) **and** an `Adjust stops & publish` action; clicking it lands on `/routes` carrying `date=` the server's `route_date` and `focus=` the server's `route_id` — the ids the response minted, never what the client guessed. The board, given that query, fetches *that* day (not the server default) and opens *that* route: the stop is on screen, and the Publish button is already there.

**Cases** (`PropertyDetailPage.test.tsx`, `RouteComposerPage.test.tsx`). The door asserts the exact query string through a location probe, so a navigation to a bare `/routes` fails the test even though the right screen appears — landing near the answer is not arriving. The board side asserts `forDate('2024-12-05')` was the fetch and the handed route renders its stop; it also proves the draft is publishable from the screen it landed on, which is the point of the whole handoff.

**How it could fail.** A confirmation that only informs (the pre-SCH-14 flow) sends the clerk back through the site list to the board to find a draft they did not name; an auto-navigate that skips the confirmation deletes the moment where a wrong driver is noticed; a `focus` that re-applies on every refresh steals the selection from a clerk two routes down the day. The anchor fires once by ref, and the existing `?date=`-less mount tests keep the no-query path — server default, no selection — exactly as it was.


## T-SCH-15 — booked sites leave the due queue (view + `GET /api/properties/due-queue`)

**Asserts.** A property with an open future stop — pending or arrived, on a draft or
a published route, dated ≥ business_today — is absent from every default filter
(`overdue`, `week`, `due_30`, `all`) and appears when the query passes
`show_scheduled=1`, carrying `scheduled_on` and the route's status and driver so the
page can say *booked, not due* in words. Remove the stop, or unpublish the day with
the stop still terminal-free and re-dated into the past, and the site is back in the
default queue on the next read — the return is computed, not reconciled.

**Cases** (new `due-queue-scheduled.test.ts`). A fixture property gets its own
`last_service_date` (save and restore it around the test — it is a shared corpus row;
a fixture that quietly rewrites the migrated pointer will fail reconciliation on
someone else's machine). Stop appended to a **draft** → hidden from default, present
with `show_scheduled=1`, `route_status: 'draft'` in the payload. **Publish** → still
hidden, and the payload now says `published` — the two statuses must not collapse in
the view. **Terminal stop** (`skipped`) → back in the default queue; this is the case
the whole design hangs on, because a stop that reached an outcome with no service
means no new due date exists anywhere and the queue must ask again. A stop on a
**past** route → invisible to neither world: it cannot hide a queue entry (history is
not a booking) while its own day still shows it.

**How it could fail.** Counting *every* historical stop as booked — one ETL re-run
away from an empty due queue and a business that quietly stops pumping; or counting
only published routes — a clerk uses the SCH-13 handoff, saves the draft, and the
site nags all week, so they learn to distrust the board. The draft half and the
terminal half of the fixture are what distinguish this view from the two adjacent
wrong answers.

## T-SCH-16 — due-date adjustments (`POST/DELETE /api/properties/:id/due-adjustments`)

**Asserts.** POST `{ adjusted_due_date, reason }` on an active site: 201, the row
attributes it to the authed user (`created_by` is read off the token, never the body)
with a server-stamped `created_at`, and `due-queue` immediately reports the site's
effective due date as the adjusted one, `adjusted: true`, `adjustment_reason`
repeating the sentence the office will actually read. A second open adjustment on
the same site is refused **by naming the first** (409 carrying the date on file);
`reason` empty or whitespace is refused; a date on or before the server's today is
refused, because adjusting to the past is the ledger's job (LED-01's correction
route is named in the refusal). DELETE closes the open adjustment (server stamps
`closed_by`/`closed_at`) and the queue's next read shows the generated date again —
the overlay comes off, the computed truth stands.

**Cases** (same suite). The past-date refusal is asserted with the *server's* clock
(`business_today()`), not the body's, the same P10 spine every capture test uses.
The 409's body carries the open adjustment's date. `amount`-style mutation checks:
delete the `uq_one_open_adjustment` guard clause mentally — closing an adjustment and
opening a new one must work (200 after the DELETE), which is why the index is partial
and not just unique; a fixture that only proves "two opens collide" would also be
satisfied by a broken full-unique index that then wedges the site forever. Capture
half: completing a driver stop advances `properties.last_service_date` to the
service date **inside the capture transaction** (an event without its pointer is a
site that nags forever), via GREATEST — a back-dated correction event must not drag
the pointer into the past. The fixture restores the property's own
`last_service_date` afterwards.

**How it could fail.** An `UPDATE properties.next_service_due` implementation — it
would pass a queue-only test and break SCH-11's generated-column guarantee, the
drift suite, and every honest reading of the ledger in one stroke; the assertions
against `next_service_due` being *unchanged* while `due-queue` says otherwise are
the whole point. Or no `closed_at`: adjustment rows would become permanent
overwrites wearing a reason as a costume.


## T-DRV-21 — a service record with no route behind it (`POST /api/ledger/events`)

**Asserts.** An authenticated human of any role — a driver's token is enough — can
file a completed service record against a named site: gallons, waste type, disposal
site, note. The row is `source = 'app'`, `status = 'completed'`, `service_date` is the
**server's** `business_today()` (a body that names `service_date` is refused naming it
— the DRV-08 sentence restated for the new door), `performed_by_pumper_id` comes from
the login's pumper link, never the body, and `properties.last_service_date` advances to
the service date in the same transaction (SCH-16's pointer: a record that leaves the
site nagging the queue is a record the office will learn to ignore). The disposal site
is demanded the way `done` demands it — the county report is assembled by site — and
its refusal names the thing the caller is missing. Missing gallons is *accepted and
warned* (LED-04), exactly as the capture endpoint does; two endpoints, one honesty.

**Cases** (new `service-records.test.ts`). A driver token with a pumper link files a
record: 201, event row matches field for field, pointer moved, warning absent. The same
`client_uuid` three times: 201, 200, 200, **one row**, the first response's id replayed
(DRV-13's contract at a new door — the test sends the replays *after* the first
success, the flaky-phone order). An office token files one too (drivers, office and
admin all may; the gate is authenticated, not role-locked — the office backfills from
paper). No disposal site → 400 naming the site; body names `service_date` → 400 naming
the field; no gallons → 201 with a `warnings` entry; a driver with no pumper link → the
anonymous row plus its warning, never a refusal of the pump-out; unknown site → 404 in
the house sentence. A ledger-guarded teardown deletes the events under
`septic.ledger_repair`, restores each fixture property's own `last_service_date` (save
at plant, restore at teardown — the pointer is a test row now, and this suite owns the
regression of forgetting that), and drops its users.

**How it could fail.** Accepting a body-supplied `service_date` — one checkbox, and the
phone's clock (wrong, or simply a back-dated batch) becomes regulatory history; the
assertion is on `to_char(service_date) = business_today()` for a request sent with a
fabricated field *rejected outright*. Dropping the dedup — three rows for one ditch
submission, three state-report entries, a customer billed a third time. Skipping the
pointer — the feature ships, the queue still nags the site tomorrow, and the office
discovers the record only works halfway.


## T-BIL-19 — the billing queue (`GET /api/ledger/unbilled-events`)

**Asserts.** A completed, current (head-of-chain) service event whose id appears in no
`invoice_lines.service_event_id` is on the list — property, cust #, payer on file, date,
gallons — newest first, with `total` paging metadata and the server's `business_today`.
The four ways an event leaves the list are the whole requirement: an invoice line is
attached (the intended exit); a *correction* supersedes the event (the correction's own
head-row appears — unbilled work is never lost or duplicated by correcting it, and the
superseded original disappears); the date slides out of the window (default 60 days;
`days` widens it, `days=all` opens it fully); or the event is not completed at all.

**Cases** (new `billing-queue.test.ts`). A fresh site + a DRV-20 filed record: on the
queue with its gallons and payer label. Insert an invoice and a line referencing the
event (SQL — invoice creation from this screen is not the feature and stays undecided):
gone from the queue, and the *invoice* it lands on is untouched otherwise. File a
correction over a queue entry: the original vanishes, the correction's head row is now
the entry — the same truck afternoon is one billable thing, never two. A legacy-dated
completed event (SQL-planted, two years back): off the default window, on with
`days=900`, on with `days=all`. Sorting: `sort=payer&dir=asc` and back, and an unknown
sort is refused by naming the options (the column list is whitelisted — the fragment is
interpolated, same doctrine as `DUE_FILTERS`). Teardown is ledger-guarded: events and
invoices under `septic.ledger_repair`, invoice lines first (they cascade from invoices
but precede the property drop), fresh sites and users dropped by id.

**How it could fail.** Reading every row instead of heads: a corrected event then bills
twice — the original and its correction — and the state report's own "heads only"
discipline arrives at billing one migration late. Or matching billing on the *property*
instead of the event: one billed pump-out quietly hides every other pump-out that site
ever had. The correction-pair fixture is what distinguishes head-reading from
row-reading; the line-referenced-by-id fixture is what distinguishes event-matching from
property-matching.


## T-BIL-20 — creating an invoice (`POST /api/invoices`)

**Asserts.** An office user can post an invoice — payer, optional site, one or more
lines — and the created document answers with the totals **the database computed**:
each line `ROUND(quantity × unit_price, 2)`, subtotal the sum, tax the settings rate
(applied only to the stamp, never to a client-sent number, because none exists), zero
for a payer whose `tax_exempt` is true. Each line names exactly one lawful thing; the
four kinds are the four ways a line can be true. An event line must be completed, must
be a chain head, and must be unbilled *in this same transaction after locking the
event rows*: the second clerk to bill the same pump-out gets a 409 naming the invoice
that already names it — not a second invoice, not a silent merge. And the drain promise:
the event is on the billing queue before the POST and gone after it, with no other
mechanism touching the queue.

**Cases** (new `invoice-create.test.ts`). A clean bill: one pump-out event + one
price-list item line, the payer's mailing name on the list response, totals recomputed
from the line numbers (`1.5 × 100 = 150`, tax from settings). A client that sends its
own `total` has it ignored — the assertion is that the response contradicts the lie.
Tax-exempt payer: tax 0.00 whatever the settings rate. A mixed document — one line
taxed, one marked `taxable: false` (0034) — has the rate measured over the taxable line
alone (`round(taxable × rate, 2)`), and both flags are stored and read back line by line on
the detail. Refusals, each naming the next
thing: no payer (404 *No payer has id N*); unknown item (404 naming the item); zero or
negative quantity (400 naming the line number); a line with both an event and an item
(400, contradictory); billing the already-billed event again (409 naming the first
invoice — the same claim, then its retry, is the concurrency test at human speed);
billing a superseded event (409 naming the head). Empty lines 400. The drain: the
event is found on `GET /ledger/unbilled-events` before, absent after, `meta.total`
down by exactly one. Teardown: `septic.ledger_repair` over lines, invoices, events;
payers, ownerships, sites by id.

**How it could fail.** Trusting the client's `amount` and banking a lie the first time
an office laptop sends a fat-fingered total — the bid conversion computes in SQL for
this reason and manual creation must not be the exception. Or checking "already
billed" outside the lock: two clerks, two requests, one pump-out, two invoices, and
the queue never saw either — the check and the insert must live in the same
transaction that locked the event rows. Or the queue growing a *status* column to
mark rows billed: then the invoice and the queue could disagree forever, where today
they cannot even be read apart.
---

## T-DRV-06c/d — the day says who it is for, and says when it is over

**Bug design.** Two September reports, one screen. The first: the office published a day at
12:53, and by 12:56 someone's tablet had logged in with a coworker's autofilled credentials
and drawn three 404s attributed to a driver who had not signed in at all — the empty-day
screen said "Nothing published for you today" and nothing said which *you* it had answered.
The second: close the last stop and the route flips to `done`; `v_driver_dispatch` publishes
only `published|in_progress`, so the post-tap re-check came back 404, the screen classed it
as a failed reload, kept the stale list, and the just-finished card offered `Done` until the
driver reloaded by hand.

**Cases.** RTL, mocked services (`DispatchPage.test.tsx`).
1. `T-DRV-06c`: the empty-day and error-state screens render `Signed in as {name} ({email})`
   from the token's stored user — the message was answering the wrong person, and the screen
   now also says who it answered.
2. `T-DRV-06d`: fixture `[done, arrived]`; the last tap's write resolves 2xx and the re-check
   rejects 404 → a persistent *Day closed* banner appears without any reload, the recorded
   status lands on the card, the day stays readable, and **no action button survives
   anywhere** — a closed day offers nothing a server would refuse.
3. `T-DRV-06d`: the same 404 arrives from a *passive* poll (fake timers, 16 s) while an
   unresolved stop is visible → that is the office taking the day back (DRV-14: the server
   owns the day); the work list is dropped and the server's own sentence replaces it, not a
   completion banner.

**Mutation plan.** Move `if (silent) return` back above the 404 branch → both 06d cases
reddening (frozen list / no banner). Drop the `frozen` guard in `StopActions` → the
no-buttons assertion reddens. Read every 404 as day-closed → case 3 reddens; read every 404
as withdrawal → case 2 reddens. Remove the identity line → 06c reddens on both screens.
