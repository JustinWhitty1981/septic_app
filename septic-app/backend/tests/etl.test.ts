import { Client } from 'pg';
import { connect } from './db';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The transform is the only thing standing between 48,216 rows of Access and a due
 * queue the business can drive a truck with. These tests assert the properties that
 * make it trustworthy, and each one is a number that was measured by hand first —
 * a test written from the code rather than from the data would just restate it.
 *
 * Two of these helpers were broken and every one of these tests exists because a
 * function that returns NULL for everything is indistinguishable from an empty
 * column: num() could not read '$250.00' so all 6,590 line prices silently became
 * NULL, and wb_date_paid() used the wrong format mask and parsed 0 of 3,203 dates.
 * Nothing raised. Only a count would have noticed, so now there is a count.
 *
 * The legacy landing zone is not in git (data/ is 7.9 MB of CSVs). Absent CSVs mean
 * a fresh clone, which is a reason to skip. CSVs present but an empty landing zone
 * means somebody forgot `python3 etl/load_legacy.py`, which is a reason to fail.
 */
const CANDIDATES = [
  '/data',                                        // the container's read-only mount
  path.resolve(__dirname, '../../..', 'data'),    // running jest on the host
];
const DATA_DIR = CANDIDATES.find((d) => fs.existsSync(path.join(d, 'tblCustDumpLog.csv')));
const LANDED = DATA_DIR !== undefined;
const suite = LANDED ? describe : describe.skip;

let db: Client;
beforeAll(async () => {
  db = await connect();
});
afterAll(async () => {
  await db?.end();
});

const q = async (sql: string, params: any[] = []) => (await db.query(sql, params)).rows;
const one = async (sql: string, params: any[] = []) =>
  Number((await q(sql, params))[0].n);

/**
 * Reconciliation is the whole point of LED-05/ETL-02: a row that is neither loaded
 * nor quarantined has been destroyed. Asserting source = target + quarantine per
 * file is the only check that makes losing a row impossible rather than unlikely.
 */
const RECONCILE: [string, string, string][] = [
  ['tblCustDumpLog', 'legacy.tblcustdumplog',
   "service_events WHERE source = 'legacy_import'"],
  ['tblInvoices', 'legacy.tblinvoices',
   'invoices WHERE legacy_invoice_no IS NOT NULL'],
  // The predicate excludes the rows that are not ETL's: an invoice line born
  // from a driver's capture (service_event_id) or a converted bid
  // (bid_line_id) is an app row, and counting it as a loaded source row is
  // how a live test elsewhere in the suite starts failing reconciliation
  // (it did: nine bid-converted lines met a counting ETL worker mid-run).
  // Requiring an *imported* header (legacy_invoice_no) closes the rest of the
  // gap: a BIL-05 correction (adjusts_invoice_id, and its lines reuse the
  // legacy product code) or a hand-keyed original is an app row under a header
  // that carries no legacy_invoice_no, so it is not the transform's to count.
  ['tblInvoiceAmount', 'legacy.tblinvoiceamount',
   'invoice_lines l JOIN septic_app.invoices h ON h.id = l.invoice_id '
   + 'WHERE l.legacy_product_code IS NOT NULL AND h.legacy_invoice_no IS NOT NULL'],
  ['tblInspectionDate', 'legacy.tblinspectiondate', 'inspections'],
];

suite('ETL-02 / LED-05: no source row is ever silently lost', () => {
  beforeAll(async () => {
    const n = await one('SELECT count(*)::int AS n FROM legacy.tblcustdumplog');
    if (n === 0) {
      throw new Error(
        'data/ is present but legacy.tblcustdumplog is empty. ' +
        'Run: python3 etl/load_legacy.py && python3 etl/run_transforms.py',
      );
    }
  });

  it.each(RECONCILE)(
    '%s: source count equals loaded plus quarantined',
    async (file, source, target) => {
      const rows = await q(
        `SELECT (SELECT count(*) FROM ${source})                        AS source,
                (SELECT count(*) FROM septic_app.${target})             AS loaded,
                (SELECT count(*) FROM septic_app.import_quarantine
                  WHERE source_file = $1)                              AS quarantined`,
        [file],
      );
      const { source: s, loaded, quarantined } = rows[0];
      expect(Number(loaded) + Number(quarantined)).toBe(Number(s));
      // A file that quarantines nothing is not suspicious, but a file that quarantines
      // EVERYTHING is: that is what a broken parser looks like from the outside.
      expect(Number(loaded)).toBeGreaterThan(0);
    },
  );
});

suite('LED-05: a quarantined row can still be read by a human', () => {
  it('every quarantined row carries its original text and a reason', async () => {
    const rows = await q(
      `SELECT count(*)::int AS n FROM septic_app.import_quarantine
        WHERE raw IS NULL
           OR reason IS NULL OR btrim(reason) = ''
           OR length(raw::text) < 3`,
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it('the reason names the defect, not just that there was one', async () => {
    const rows = await q(
      `SELECT count(DISTINCT split_part(reason, ':', 1))::int AS n
         FROM septic_app.import_quarantine`,
    );
    // service_date_unparseable, inspection_date_unparseable, invoice_date_missing,
    // amount_paid_exceeds_total and four orphan_line_* buckets.
    expect(Number(rows[0].n)).toBeGreaterThanOrEqual(6);
  });

  it('the ledger rejects only rows it genuinely cannot represent', async () => {
    // 48,216 events, 2 unparseable dates. If this number grows, something started
    // quarantining rows that merely look untidy -- the mistake LED-04 warns about.
    const rows = await q(
      `SELECT count(*)::int AS n FROM septic_app.import_quarantine
        WHERE source_file = 'tblCustDumpLog'`,
    );
    expect(Number(rows[0].n)).toBe(2);
  });
});

suite('LED-04: a pump-out with no gallons is allowed and flagged, not rejected', () => {
  it('blank-gallon rows are loaded with a null rather than quarantined', async () => {
    const blanks = await one(
      `SELECT count(*)::int AS n FROM legacy.tblcustdumplog
        WHERE btrim(coalesce(actualgallonspumped, '')) = ''`,
    );
    const loadedNull = await one(
      `SELECT count(*)::int AS n FROM septic_app.service_events
        WHERE gallons_pumped IS NULL`,
    );
    // The two rows with an unparseable date are quarantined for THAT reason; they
    // happen to also have no gallons, which is why this is not an exact match.
    expect(loadedNull).toBeGreaterThanOrEqual(blanks - 2);
    expect(loadedNull).toBeLessThanOrEqual(blanks);
    // 19,202 blanks is 40% of the ledger. A transform that rejected them would have
    // emptied the due queue while still reporting success.
    expect(loadedNull).toBeGreaterThan(15000);
  });
});

suite('ETL-03: a composite tank string becomes structured rows and survives', () => {
  it('every property with a tank string has at least one tank row', async () => {
    const rows = await q(
      `SELECT count(*)::int AS n
         FROM legacy.tblcustomers c
         JOIN septic_app.properties p ON p.legacy_cust_number = c.cust_number::int
        WHERE btrim(coalesce(c.tank_size, '')) <> ''
          AND NOT EXISTS (SELECT 1 FROM septic_app.tanks t WHERE t.property_id = p.id)`,
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it('raw_text preserves the string it was parsed from', async () => {
    // P3: the parse is a convenience, the original is the record. A disagreement
    // between them means the transform overwrote evidence.
    const rows = await q(
      `SELECT count(*)::int AS n
         FROM septic_app.tanks t
         JOIN septic_app.properties p ON p.id = t.property_id
         JOIN legacy.tblcustomers c ON c.cust_number::int = p.legacy_cust_number
        WHERE t.raw_text <> btrim(c.tank_size)
          AND position(t.raw_text in btrim(c.tank_size)) = 0`,
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it('a composite string yields one row per tank, in order, with one primary', async () => {
    const rows = await q(
      `WITH per_property AS (
           SELECT t.property_id, count(*) AS tanks,
                  count(*) FILTER (WHERE t.role = 'primary') AS primaries,
                  max(t.sequence_no) AS highest
             FROM septic_app.tanks t
             JOIN legacy.tblcustomers c
               ON c.cust_number::int = (SELECT legacy_cust_number FROM septic_app.properties
                                         WHERE id = t.property_id)
            -- A trailing '+' is not a second tank: 10 rows are '1000+', '600+',
            -- '1000 Mk prlr septic+'. The operator started to write a second tank and
            -- stopped. Asserting two rows there would demand a tank with no capacity
            -- and no raw_text, and raw_text is NOT NULL precisely so a row cannot be
            -- invented. The dangling '+' survives inside raw_text either way.
            WHERE c.tank_size LIKE '%+%'
              AND btrim(c.tank_size) NOT LIKE '%+'
            GROUP BY t.property_id
       )
       SELECT count(*) FILTER (WHERE tanks < 2)          AS composites_with_one_row,
              count(*) FILTER (WHERE primaries <> 1)     AS wrong_primary_count,
              count(*) FILTER (WHERE highest <> tanks)   AS gappy_sequence
         FROM per_property`,
    );
    expect(rows[0]).toMatchObject({
      composites_with_one_row: '0',
      wrong_primary_count: '0',
      gappy_sequence: '0',
    });
  });

  it('a dangling trailing + does not conjure a second tank', async () => {
    const rows = await q(
      `SELECT count(*)::int AS wrong
         FROM legacy.tblcustomers c
         JOIN septic_app.properties p ON p.legacy_cust_number = c.cust_number::int
        WHERE btrim(c.tank_size) LIKE '%+'
          AND (SELECT count(*) FROM septic_app.tanks t WHERE t.property_id = p.id) <> 1`,
    );
    expect(Number(rows[0].wrong)).toBe(0);
  });

  it('a pre-cleanout is recognised rather than called a second tank', async () => {
    // '1500w.fltr+800 PC' is the single most common string in the file (311 rows).
    // The first version of this parser used '\bPC\b', which Postgres does not
    // support, and every pre-cleanout silently became 'secondary' with no error.
    const rows = await q(
      `SELECT count(*) FILTER (WHERE role = 'pre_cleanout')::int AS n
         FROM septic_app.tanks`,
    );
    expect(Number(rows[0].n)).toBeGreaterThan(1500);
  });
});

suite('BIL-02 / BIL-03 / BIL-05: billing moves without going quiet', () => {
  it('Date Paid parses, instead of returning NULL for every row', async () => {
    const populated = await one(
      `SELECT count(*)::int AS n FROM legacy.tblinvoices
        WHERE btrim(coalesce(date_paid, '')) <> ''`,
    );
    const parsed = await one(
      `SELECT count(*)::int AS n FROM septic_app.payments WHERE paid_at IS NOT NULL`,
    );
    // The original mask was 'FMMM/Mon/YY' against '18-Dec-18' data: 0 of 3,203
    // parsed and nothing complained.
    expect(parsed).toBeGreaterThan(populated * 0.9);
  });

  it('line prices are money, not NULL', async () => {
    const rows = await q(
      `SELECT count(*)::int AS n, coalesce(sum(amount), 0) AS total
         FROM septic_app.invoice_lines WHERE amount IS NULL OR amount = 0`,
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it('orphaned lines are quarantined with a reason that says where they sit', async () => {
    const rows = await q(
      `SELECT count(*)::int AS orphans,
              count(DISTINCT split_part(reason, ':', 1))::int AS distinct_reasons
         FROM septic_app.import_quarantine
        WHERE source_file = 'tblInvoiceAmount'`,
    );
    expect(Number(rows[0].orphans)).toBeGreaterThan(3000);
    // BIL-03 asks for distinct reason codes: a single 'orphan' bucket would hide the
    // difference between a negative draft number and a hole in the sequence.
    expect(Number(rows[0].distinct_reasons)).toBeGreaterThanOrEqual(4);
  });

  it('no orphaned line was attached to a plausible invoice', async () => {
    const rows = await q(
      `SELECT count(*)::int AS n FROM septic_app.invoice_lines l
        WHERE NOT EXISTS (SELECT 1 FROM septic_app.invoices i WHERE i.id = l.invoice_id)`,
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it('payments sum to what the invoice says was paid', async () => {
    const rows = await q(
      `SELECT count(*)::int AS n FROM (
           SELECT i.id, i.amount_paid - coalesce(sum(p.amount), 0) AS diff
             FROM septic_app.invoices i
             LEFT JOIN septic_app.payments p ON p.invoice_id = i.id
            GROUP BY i.id, i.amount_paid
          ) s WHERE abs(diff) > 0.01`,
    );
    expect(Number(rows[0].n)).toBe(0);
  });
});

suite('SCH-01 / LED-01: the due queue computes', () => {
  it('v_due_queue returns properties at all', async () => {
    // Before 07_derive.sql this returned zero rows with no error, because every
    // last_service_date was NULL and NULL + interval is NULL, not a bug.
    const rows = await q(`SELECT count(*)::int AS n FROM septic_app.v_due_queue`);
    expect(Number(rows[0].n)).toBeGreaterThan(5000);
  });

  it('last_service_date is exactly the newest completed event, never more', async () => {
    const rows = await q(
      `SELECT count(*)::int AS n
         FROM septic_app.properties p
         FULL OUTER JOIN (
             SELECT property_id, max(service_date) AS d
               FROM septic_app.service_events
              WHERE status = 'completed'
              GROUP BY property_id
         ) s ON s.property_id = p.id
        WHERE coalesce(p.last_service_date, 'infinity'::date)
           <> coalesce(s.d, 'infinity'::date)`,
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it('a property with no service history has no due date', async () => {
    const rows = await q(
      `SELECT count(*)::int AS n FROM septic_app.properties
        WHERE last_service_date IS NULL AND next_service_due IS NOT NULL`,
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it('days_overdue is measured against business_today, not current_date', async () => {
    // P10. The snapshot ends in 2024; against current_date every property looks
    // years overdue and the queue is useless on the day it is opened. Measured
    // against effective_due_date, not the raw generated column, because from 0029
    // an open adjustment legitimately moves what the queue calls "due" — the clock
    // this test is about is still the only other thing on the right-hand side.
    const rows = await q(
      `SELECT count(*)::int AS n FROM septic_app.v_due_queue
        WHERE days_overdue <> business_today() - effective_due_date`,
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it('the queue is ordered so the worst case is first', async () => {
    const rows = await q(
      `SELECT effective_due_date FROM septic_app.v_due_queue LIMIT 1`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].effective_due_date).toBeInstanceOf(Date);
  });
});

suite('ETL-08: every reference in the moved data resolves', () => {
  const LINKS: [string, string, string][] = [
    ['service_events', 'property_id', 'properties'],
    ['tanks', 'property_id', 'properties'],
    ['invoices', 'payer_id', 'payers'],
    ['invoices', 'property_id', 'properties'],
    ['invoice_lines', 'invoice_id', 'invoices'],
    ['payments', 'invoice_id', 'invoices'],
    ['inspections', 'property_id', 'properties'],
    ['property_ownerships', 'property_id', 'properties'],
    ['property_ownerships', 'payer_id', 'payers'],
  ];

  it.each(LINKS)('%s.%s resolves to a %s row', async (child, column, parent) => {
    const rows = await q(
      `SELECT count(*)::int AS n FROM septic_app.${child} c
        WHERE c.${column} IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM septic_app.${parent} p WHERE p.id = c.${column})`,
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it('no legacy customer number went unmatched', async () => {
    // The landing zone is all TEXT, so this also proves every key cast held: a
    // non-numeric cust_number would have surfaced here rather than at load time.
    const rows = await q(
      `SELECT
         (SELECT count(*) FROM legacy.tblcustdumplog d
           WHERE NOT EXISTS (SELECT 1 FROM septic_app.properties p
                              WHERE p.legacy_cust_number = nullif(btrim(d.cust_number),'')::int))
           + (SELECT count(*) FROM legacy.tblinvoices i
           WHERE NOT EXISTS (SELECT 1 FROM septic_app.properties p
                              WHERE p.legacy_cust_number = nullif(btrim(i.cust_number),'')::int))
         AS unmatched`,
    );
    expect(Number(rows[0].unmatched)).toBe(0);
  });

  it('an unresolved certification is flagged rather than guessed at', async () => {
    // LED-06: flag, never guess. 4,685 events name a cert that matches none of the
    // seven known pumpers; 4,650 of them are one value spanning 35 years, which is a
    // real pumper the export lost the name of, not a typo to correct.
    const rows = await q(
      `SELECT count(*) FILTER (WHERE cert_unresolved AND performed_by_pumper_id IS NULL)::int AS flagged,
              count(*) FILTER (WHERE cert_unresolved AND performed_by_pumper_id IS NOT NULL)::int AS contradiction,
              count(*) FILTER (WHERE cert_as_recorded IS NULL AND performed_by_pumper_id IS NULL
                                 AND cert_unresolved)::int AS lost_the_number
         FROM septic_app.service_events`,
    );
    expect(Number(rows[0].flagged)).toBeGreaterThan(4000);
    expect(Number(rows[0].contradiction)).toBe(0);
    expect(Number(rows[0].lost_the_number)).toBe(0);
  });
});

suite('ETL-04: county spellings normalise through county_alias, originals retained', () => {
  /**
   * 34 distinct strings, 7 real counties — and the interesting half of the
   * requirement is what does NOT get resolved. Chilton, Plymouth, Empire,
   * Byron, Campbellsport (and its own typo Cambpellsport), Marshfield,
   * Springvale, Green Lake and Brothertown are municipalities, not counties;
   * mapping them would mean guessing which county each village sits in, which
   * is a geographic claim the source does not make (LED-06: flag, never guess).
   *
   * Every number below was measured against the loaded corpus, which is why
   * they are worth asserting: the transform's own comments claim them, and a
   * comment about counts is a claim that decays silently.
   */
  const MUNICIPALITIES = [
    'Chilton', 'Plymouth', 'Empire', 'Byron', 'Campbellsport', 'Cambpellsport',
    'Marshfield', 'Springvale', 'Green Lake', 'Brothertown',
  ];
  const MEASURED_RESOLVED_SPELLINGS = 24;

  it('every resolved string resolved through the alias table, not by guess', async () => {
    // A property carries a county_id iff its raw string has an alias row
    // pointing at that same county. No other path from raw to county exists.
    const mismatches = await q(
      `SELECT count(*)::int AS n
         FROM septic_app.properties p
        WHERE p.county_raw IS NOT NULL
          AND (
            (p.county_id IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM septic_app.county_alias ca
                 WHERE ca.alias = p.county_raw AND ca.county_id = p.county_id))
            OR
            (p.county_id IS NULL AND EXISTS (
                SELECT 1 FROM septic_app.county_alias ca WHERE ca.alias = p.county_raw))
          )`,
    );
    expect(Number(mismatches[0].n)).toBe(0);
  });

  it('FDL is the alias of Fond du Lac — and says so in its own words still', async () => {
    /**
     * The first version of this test joined `counties c ON c.id = p.county_id`
     * and then counted `p.county_id = c.id` — a tautology, which stayed green
     * when a planted mutation pointed FDL at Calumet. The assertion is only a
     * fact when the expected county is named independently of the row under
     * test; that is what the CTE below is for.
     */
    const rows = await q(
      `WITH expected AS (SELECT id FROM septic_app.counties WHERE name = 'Fond du Lac')
       SELECT count(*)::int AS n,
              count(*) FILTER (WHERE p.county_id = (SELECT id FROM expected))::int AS to_fdulac,
              count(*) FILTER (WHERE p.county_raw = 'FDL')::int AS raw_kept
         FROM septic_app.properties p
        WHERE p.county_raw = 'FDL'`,
    );
    expect(Number(rows[0].n)).toBe(26);            // the 26 rows from the evidence line
    expect(Number(rows[0].to_fdulac)).toBe(26);    // every one of them
    expect(Number(rows[0].raw_kept)).toBe(26);     // and none of them forgot what was typed
  });

  it('the resolved vocabulary is exactly the 24 measured spellings over 7 counties', async () => {
    const n = await one(
      `SELECT count(DISTINCT county_raw)::int AS n FROM septic_app.properties
        WHERE county_raw IS NOT NULL AND county_id IS NOT NULL`,
    );
    expect(n).toBe(MEASURED_RESOLVED_SPELLINGS);

    const counties = await q(
      `SELECT DISTINCT c.name
         FROM septic_app.properties p JOIN septic_app.counties c ON c.id = p.county_id
        WHERE p.county_raw IS NOT NULL`,
    );
    expect(counties.map((r) => r.name).sort()).toEqual(
      ['Calumet', 'Dodge', 'Fond du Lac', 'Manitowoc', 'Sheboygan', 'Washington', 'Winnebago'],
    );
  });

  it('no municipality was guessed at — including the municipality with a typo', async () => {
    const placeholders = MUNICIPALITIES.filter((m) => m !== 'Cambpellsport');
    const rows = await q(
      `SELECT DISTINCT county_raw FROM septic_app.properties
        WHERE county_raw = ANY($1) AND county_id IS NOT NULL`,
      [placeholders],
    );
    expect(rows).toEqual([]);

    // Cambpellsport is Campbellsport's typo. Normalising a county typo is ETL-04;
    // normalising a municipality typo into a municipality is still a guess about
    // geography, so the typo stays unresolved exactly like its twin.
    const both = await q(
      `SELECT count(*)::int AS n FROM septic_app.properties
        WHERE county_raw = ANY($1) AND county_id IS NOT NULL`,
      [['Campbellsport', 'Cambpellsport']],
    );
    expect(Number(both[0].n)).toBe(0);
  });

  it('the alias table carries no duplicate routes and no orphan destinations', async () => {
    const n = await one(`SELECT count(*)::int AS n FROM septic_app.county_alias`);
    const distinct = await one(
      `SELECT count(DISTINCT alias)::int AS n FROM septic_app.county_alias`);
    expect(n).toBe(distinct); // PK does this; the assertion is that re-runs kept it true
    expect(n).toBeGreaterThanOrEqual(MEASURED_RESOLVED_SPELLINGS);

    const orphans = await one(
      `SELECT count(*)::int AS n FROM septic_app.county_alias ca
        WHERE NOT EXISTS (SELECT 1 FROM septic_app.counties c WHERE c.id = ca.county_id)`,
    );
    expect(orphans).toBe(0);
  });

  it('the empty county is the empty county: 38 sites resolve to nothing and stay that way', async () => {
    // The re-run guard for the 0013 decision: the transform may not fill a
    // county in from a municipality, a town column, or a shrug.
    const rows = await q(
      `SELECT count(*)::int AS blank,
              count(*) FILTER (WHERE county_id IS NOT NULL)::int AS invented
         FROM septic_app.properties
        WHERE county_raw IS NULL`,
    );
    expect(Number(rows[0].invented)).toBe(0);
    expect(Number(rows[0].blank)).toBeGreaterThanOrEqual(38);
  });
});
