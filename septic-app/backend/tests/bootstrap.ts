import { Client } from 'pg';

/**
 * Build the fixture world on a blank database.
 *
 * Many suites pick their stage props out of what the migrated database
 * already holds — "an active property nobody has booked today", "a site the
 * ledger names", "a legacy invoice to stand in for the book" — because on the
 * migration machine those rows are 61 years of company history and always
 * there. On a clean install they are not, and a suite that cannot find a
 * stage prop is indistinguishable from a feature that does not work, which
 * teaches the wrong lesson to whoever deploys this repo first.
 *
 * So: build the props before any suite runs (jest globalSetup), consistently.
 * Every date-shaped fact has the event behind it that the reconciliation
 * suites hunt for — a last_service_date with nothing in the ledger to
 * justify it is exactly the inconsistency those suites (correctly) fail on,
 * and a fixture that fights the schema's own invariant is the crime, not the
 * proof.
 *
 * Every block is guarded on its own table being empty, so on a corpus
 * database the whole function is a no-op. Nothing here pretends to be
 * company data: the names say Fixture, the ownership rows say 'synthetic',
 * and the invoices live in a legacy_invoice_no range (7000xx) the real book
 * never reaches.
 */
async function seed(db: Client, sql: string, whenTableEmpty: string): Promise<void> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM septic_app.${whenTableEmpty} LIMIT 1`);
  if (rowCount) return;
  await db.query(sql);
}

export async function ensureSeed(): Promise<void> {
  const db = new Client({
    host: process.env.DATABASE_HOST || 'postgres',
    port: Number(process.env.DATABASE_PORT || 5432),
    user: process.env.DATABASE_USER || 'septic_dev',
    password: process.env.DATABASE_PASSWORD || 'septic_dev_pw',
    database: process.env.DATABASE_NAME || 'septic',
  });
  await db.connect();
  try {
    const migrated = await db.query(
      `SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'septic_app' AND table_name = 'properties'`);
    if (!migrated.rowCount) {
      throw new Error(
        'bootstrap: septic_app.properties does not exist — run `npm run migrate` first.');
    }

    // Two sites: one is not enough, "move the default" needs somewhere to
    // move to (T-DRV-20), and a company with zero sites cannot complete a
    // stop lawfully (LED-03) — which is a real answer, but not one any of
    // these suites is about.
    await db.query(`
      INSERT INTO septic_app.disposal_sites (name, accepts_slurry)
      VALUES ('Fixture Farm', true), ('Fixture Slurry Storage', false)
      ON CONFLICT (name) DO NOTHING`);

    // A default site is the office's chosen guess, never an invention — so
    // it is set only where nobody has ever chosen one.
    await db.query(`
      UPDATE septic_app.company_settings
         SET default_disposal_site_id =
               (SELECT min(id) FROM septic_app.disposal_sites)
       WHERE id = 1
         AND default_disposal_site_id IS NULL
         AND EXISTS (SELECT 1 FROM septic_app.disposal_sites)`);

    // The driver the dispatch fixture hands yesterday's route to. The hash
    // is not a password anyone can log in with; no suite authenticates as
    // this row, they only need a driver_id to point a route at.
    await db.query(`
      INSERT INTO septic_app.users (email, password_hash, first_name, last_name, role)
      SELECT 'dispatch-fixture@septic.test',
             '$2b$12$fixturerownotapassword00000000000000000000000000000000',
             'Dispatch', 'Fixture', 'driver'
       WHERE NOT EXISTS (SELECT 1 FROM septic_app.users
                          WHERE email = 'dispatch-fixture@septic.test')`);

    // The bench of bookable sites. Ids land after every legacy id on a
    // corpus machine, and the guard means they never appear there at all.
    // Wide on purpose: a suite that dies before its teardown leaves its
    // bookings behind, and one exhausted day makes every later suite fail
    // for a reason that is not its own.
    await seed(db, `
      INSERT INTO septic_app.properties
            (site_address, site_city, site_state, legacy_cust_number)
      SELECT 'Fixture Way ' || (1000 + g), 'Testville', 'WI', g
        FROM generate_series(1, 240) AS g`, 'properties');

    await seed(db, `
      INSERT INTO septic_app.payers (org_name, mailing_city, mailing_state)
      SELECT 'Fixture Holdings ' || g, 'Testville', 'WI'
        FROM generate_series(1, 12) AS g`, 'payers');

    // One current owner per property, like the partial-unique index demands;
    // 'synthetic' so a reconciliation can always tell these rows' parentage.
    await seed(db, `
      INSERT INTO septic_app.property_ownerships
            (payer_id, property_id, ownership_start, source)
      SELECT pa.id, pr.id, current_date - 365, 'synthetic'
        FROM (SELECT id, row_number() OVER (ORDER BY id) rn
                FROM septic_app.payers) pa
        JOIN (SELECT id, row_number() OVER (ORDER BY id) rn
                FROM septic_app.properties) pr ON pr.rn = pa.rn`, 'property_ownerships');

    // A service on every second bench site, so the due queue has a spine:
    // dates are spread so that next_service_due falls on both sides of
    // business_today() (never on it — 0006 events today would poison the
    // "free property on business_today" picks every route suite depends on).
    // The property's last_service_date is then set FROM the event, the way a
    // completion at the truck sets it: date and ledger agree by construction.
    await seed(db, `
      INSERT INTO septic_app.service_events
            (client_uuid, property_id, service_date, status, gallons_pumped,
             waste_type_id, disposal_site_id, source)
      SELECT gen_random_uuid(), pr.id,
             business_today() - (((pr.rn * 37) % 1580 + 7)::int),
             'completed', 900 + pr.rn,
             (SELECT id FROM septic_app.waste_types ORDER BY name LIMIT 1),
             (SELECT id FROM septic_app.disposal_sites ORDER BY id LIMIT 1),
             'app'
        FROM (SELECT id, row_number() OVER (ORDER BY id) rn
                FROM septic_app.properties
               WHERE site_address LIKE 'Fixture Way %') pr
       WHERE pr.rn % 2 = 0`, 'service_events');

    await db.query(`
      UPDATE septic_app.properties p
         SET last_service_date = e.service_date
        FROM septic_app.service_events e
       WHERE e.property_id = p.id
         AND p.site_address LIKE 'Fixture Way %'
         AND p.last_service_date IS DISTINCT FROM e.service_date`);

    // Tank shapes, including the composite the driver card has to survive:
    // two rows whose raw strings carry letters ('800PC', '1500w.fltr'),
    // measured out of the corpus rather than invented.
    await seed(db, `
      INSERT INTO septic_app.tanks (property_id, sequence_no, role, capacity_gallons, has_filter, raw_text)
      SELECT id, 1, 'primary', 800, false, '800PC'
        FROM septic_app.properties
       WHERE site_address LIKE 'Fixture Way %'
         AND (right(site_address, 3)::int % 5) = 0;
      INSERT INTO septic_app.tanks (property_id, sequence_no, role, capacity_gallons, has_filter, raw_text)
      SELECT id, 2, 'secondary', 1500, true, '1500w.fltr'
        FROM septic_app.properties
       WHERE site_address LIKE 'Fixture Way %'
         AND (right(site_address, 3)::int % 5) = 0;
      INSERT INTO septic_app.tanks (property_id, sequence_no, role, capacity_gallons, has_filter, raw_text)
      SELECT id, 1, 'primary', 1500, false, '1500 triple'
        FROM septic_app.properties
       WHERE site_address LIKE 'Fixture Way %'
         AND (right(site_address, 3)::int % 5) = 1;
      INSERT INTO septic_app.tanks (property_id, sequence_no, role, capacity_gallons, has_filter, raw_text)
      SELECT id, 1, 'primary', 1000 + (right(site_address, 3)::int % 4) * 50,
             false, (1000 + (right(site_address, 3)::int % 4) * 50)::text
        FROM septic_app.properties
       WHERE site_address LIKE 'Fixture Way %'
         AND (right(site_address, 3)::int % 5) > 1`, 'tanks');

    // The awkward fields the dispatch payload suites read back: an opt-out,
    // a county raw spelling that differs from the lookup's own name (the
    // two columns must not be satisfiable by returning one value twice), a
    // raw spelling that never resolved to a lookup row, and memos long
    // enough to prove nothing truncates. A few inactive sites too, so
    // "lists every status when none is asked for" has a when to answer.
    await db.query(`
      UPDATE septic_app.properties SET status = 'inactive'
       WHERE site_address LIKE 'Fixture Way %'
         AND (right(site_address, 3)::int % 40) = 37`);

    await db.query(`
      UPDATE septic_app.properties SET reminder_opt_out = true
       WHERE site_address LIKE 'Fixture Way %'
         AND (right(site_address, 3)::int % 3) = 0
         AND NOT reminder_opt_out`);

    await db.query(`
      UPDATE septic_app.properties p
         SET county_id = c.id, county_raw = c.name || ' County'
        FROM septic_app.counties c
       WHERE p.site_address LIKE 'Fixture Way %'
         AND p.county_id IS NULL
         AND c.id = (SELECT min(id) FROM septic_app.counties)
         AND (right(p.site_address, 3)::int % 4) = 1`);

    // A raw spelling that resolved to nothing (Waushara is not in the
    // seeded county list) — the stop card must be able to say "no county"
    // from a row that still carries a string.
    await db.query(`
      UPDATE septic_app.properties SET county_raw = 'Waushara'
       WHERE site_address LIKE 'Fixture Way %'
         AND county_id IS NULL AND county_raw IS NULL
         AND (right(site_address, 3)::int % 13) = 5`);

    await db.query(`
      UPDATE septic_app.properties SET legacy_memo =
          'Park left of the barn; dog in the yard, call ahead. Tank is north-west of house.'
       WHERE site_address LIKE 'Fixture Way %'
         AND legacy_memo IS NULL
         AND (right(site_address, 3)::int % 7) = 3`);

    // Yesterday, published then closed, one terminal stop: the media/notes
    // suites attach to "any real stop", and on a blank database yesterday
    // has to exist too. Yesterday, not today, so no day-view suite trips
    // over it; terminal, because a done route with open stops contradicts
    // the rule that closes it.
    await seed(db, `
      WITH d AS (SELECT id FROM septic_app.users
                  WHERE email = 'dispatch-fixture@septic.test' LIMIT 1),
           r AS (
        INSERT INTO septic_app.routes (route_date, driver_id, truck_label, status, started_at, completed_at)
        SELECT business_today() - 1, d.id, 'FIX-1', 'done',
               now() - interval '1 day', now() - interval '23 hours'
          FROM d
        RETURNING id)
      INSERT INTO septic_app.route_stops (route_id, property_id, sequence_no, status, resolved_at)
      SELECT r.id, p.id, 1, 'skipped', now() - interval '23 hours'
        FROM r, (SELECT id FROM septic_app.properties
                  WHERE site_address LIKE 'Fixture Way %' ORDER BY id LIMIT 1) p`, 'routes');

    // The book: a handful of legacy-style invoices (7000xx — a range the
    // real ledger's numbers never reach) so the billing suites have an
    // original to adjust, a paid header, and a partially-paid one whose
    // status the receipt trigger derives from a real receipt.
    await seed(db, `
      WITH pr AS (
        SELECT id, row_number() OVER (ORDER BY id) rn
          FROM septic_app.properties
         WHERE site_address LIKE 'Fixture Way %')
      INSERT INTO septic_app.invoices
            (legacy_invoice_no, payer_id, property_id, invoice_date,
             subtotal, tax_rate, tax_amount, total, amount_paid, status)
      SELECT 700000 + pr.rn,
             CASE WHEN pr.rn <= 4 THEN 1
                  WHEN pr.rn <= 6 THEN 2
                  WHEN pr.rn <= 8 THEN 3
                  ELSE 4
             END,
             pr.id,
             business_today() - ((pr.rn * 11 + 20)::int),
             -- The payer with several bills of different sizes and different
             -- luck paying them: the balance sort needs two of one payer's
             -- invoices where the total order and the balance order disagree.
             CASE pr.rn WHEN 1 THEN 400.00 WHEN 2 THEN 250.00 WHEN 3 THEN 300.00
                  ELSE 250.00 END,
             0, 0,
             CASE pr.rn WHEN 1 THEN 400.00 WHEN 2 THEN 250.00 WHEN 3 THEN 300.00
                  ELSE 250.00 END,
             CASE pr.rn WHEN 1 THEN 400.00 WHEN 2 THEN 100.00 WHEN 3 THEN 300.00
                  ELSE 0 END,
             CASE pr.rn WHEN 1 THEN 'paid' WHEN 2 THEN 'partial' WHEN 3 THEN 'paid'
                  ELSE 'open' END::septic_app.invoice_status
        FROM pr WHERE pr.rn <= 10`, 'invoices');

    // The receipts behind the paid headers. amount_paid is stated here rather
    // than derived: the re-sum lives in the app's write path, not in a
    // trigger, and this seed enters through the database's side door — the
    // header and the receipts must agree because both say the same thing.
    await seed(db, `
      INSERT INTO septic_app.payments (invoice_id, amount, method, paid_at)
      SELECT i.id, CASE WHEN i.legacy_invoice_no = 700001 THEN 400.00
                        WHEN i.legacy_invoice_no = 700002 THEN 100.00
                        WHEN i.legacy_invoice_no = 700003 THEN 300.00
                   END, 'check', i.invoice_date + 5
        FROM septic_app.invoices i
       WHERE i.legacy_invoice_no IN (700001, 700002, 700003)`, 'payments');

    // The quarantine families, at fixture scale. The nine names and their
    // shapes are the migration machine's (measured 2026-09-16: nine families
    // hide 2,944 distinct reasons, and that gap is the whole point of the
    // families endpoint). The gap is kept proportional — the trap stays
    // live — while the table stays small enough to seed on a laptop.
    await seed(db, `
      INSERT INTO septic_app.import_quarantine (source_file, row_no, raw, reason)
      SELECT f.file, g.n,
             jsonb_build_object('line_no', 700000 + g.n, 'csv_row', g.n),
             f.family || ': ' || (700000 + g.n)
        FROM (VALUES
            ('orphan_line_in_gap',             'tblInvoiceDetails.csv', 2000),
            ('orphan_line_below_window',       'tblInvoiceDetails.csv',  120),
            ('inspection_date_unparseable',    'tblInspectionDate.csv',   40),
            ('invoice_date_missing_or_impossible', 'tblInvoices.csv',     16),
            ('orphan_line_header_quarantined', 'tblInvoices.csv',          3),
            ('orphan_line_negative_invoice_number', 'tblInvoiceDetails.csv', 3),
            ('orphan_line_past_max',           'tblInvoiceDetails.csv',    1),
            ('service_date_unparseable',       'tblCustDumpLog.csv',       2),
            ('amount_paid_exceeds_total',      'tblBilling.csv',           1)
        ) AS f(family, file, n)
        CROSS JOIN LATERAL generate_series(1, f.n) AS g(n)`, 'import_quarantine');
  } finally {
    await db.end();
  }
}
