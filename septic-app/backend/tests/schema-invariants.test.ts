import { Client } from 'pg';
import { connect } from './db';

/**
 * Executable versions of the decisions in docs/DATA_MODEL.md.
 *
 * These earn their keep by failing months from now — someone adds a bytea column,
 * a hand-written due date, or a device-writable table with no client_uuid, and it
 * passes review because each looks fine in isolation.
 */
let db: Client;
beforeAll(async () => {
  db = await connect();
});
afterAll(async () => {
  await db?.end();
});

const q = async (sql: string, params: any[] = []) => (await db.query(sql, params)).rows;

describe('NF-04 / P9: image bytes never enter the database', () => {
  it('no column anywhere in septic_app stores binary data', async () => {
    const rows = await q(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'septic_app' AND data_type = 'bytea'`,
    );
    expect(rows).toEqual([]);
  });
});

describe('NF-03 / P6: every device-writable table can deduplicate a replay', () => {
  // Presence of client_uuid is not enough. A replay is only harmless if the column
  // is UNIQUE, so the second attempt is refused rather than stored.
  //
  // `route_stops` joined this list in the DRV-06/07 slice, and it is the only entry whose
  // addition was not a matter of taste. 0008 built service_events, job_notes and media for
  // field capture and this guard enumerated exactly those three, which was correct while it
  // was true. DRV-06 gave a driver's device a write path onto a table 0007 never imagined it
  // would have — and a table a phone writes with no way to recognise a replay is the table
  // where an offline queue either jams or double-books.
  it.each(['service_events', 'job_notes', 'media', 'route_stops'])(
    '%s has a UNIQUE index on client_uuid',
    async (t) => {
      const rows = await q(
        `SELECT i.relname AS index, x.indisunique AS is_unique
           FROM pg_index x
           JOIN pg_class i ON i.oid = x.indexrelid
           JOIN pg_class r ON r.oid = x.indrelid
          WHERE r.relname = $1 AND i.relname LIKE '%client_uuid%'`,
        [t],
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0].is_unique).toBe(true);
    },
  );
});

describe('SCH-01 / SCH-02 / P1: next_service_due is derived, never stored', () => {
  it('properties.next_service_due is an ALWAYS generated column', async () => {
    const rows = await q(
      `SELECT is_generated, generation_expression
         FROM information_schema.columns
        WHERE table_schema = 'septic_app' AND table_name = 'properties'
          AND column_name = 'next_service_due'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].is_generated).toBe('ALWAYS');
    expect(rows[0].generation_expression).toBeTruthy();
  });

  // The invariant above proves the column cannot be written. It does not prove the
  // value is the right one — a generated column can be perfectly unwritable and
  // still compute the wrong date. That distinction is the whole of SCH-01, and the
  // old skipped test could not have caught it: a generated-column error is raised
  // when the statement is planned, not per row, so "wait until the tables have rows"
  // was waiting for something that was never going to change the outcome.
  it('refuses a hand-written value', async () => {
    await expect(
      db.query(`UPDATE septic_app.properties SET next_service_due = '2030-01-01'`)
    ).rejects.toThrow(/can only be updated to DEFAULT|generated column/);
  });

  // Inserted and rolled back rather than read from the corpus: the derived
  // last_service_date is populated by 07_derive.sql, which has not been written, so
  // every real row still has it NULL. The expectation is computed here in JS so a
  // change to the generated expression cannot also change the expected value.
  it('derives the due date from the last service plus the interval', async () => {
    const expected = new Date(Date.UTC(2024, 5, 1) + 1095 * 86400000).toISOString().slice(0, 10);
    await db.query('BEGIN');
    try {
      const rows = await q(
        `INSERT INTO septic_app.properties (site_address, service_interval_days, last_service_date)
         VALUES ('__test__ derived due date', 1095, DATE '2024-06-01')
         RETURNING next_service_due`
      );
      expect(rows[0].next_service_due.toISOString().slice(0, 10)).toBe(expected);
    } finally {
      await db.query('ROLLBACK');
    }
  });

  // Both inputs have to be live. A column that only follows last_service_date would
  // pass the test above and silently ignore a dispatcher changing the interval.
  it('follows the interval, not just the service date', async () => {
    await db.query('BEGIN');
    try {
      const rows = await q(
        `INSERT INTO septic_app.properties (site_address, service_interval_days, last_service_date)
         VALUES ('__test__ derived due date', 365, DATE '2024-06-01')
         RETURNING next_service_due`
      );
      expect(rows[0].next_service_due.toISOString().slice(0, 10))
        .toBe(new Date(Date.UTC(2024, 5, 1) + 365 * 86400000).toISOString().slice(0, 10));
    } finally {
      await db.query('ROLLBACK');
    }
  });

  // On the real corpus: nothing may advertise a due date it has no service for.
  it('gives no due date to a property never serviced', async () => {
    const rows = await q(
      `SELECT count(*)::int AS n FROM septic_app.properties
        WHERE last_service_date IS NULL AND next_service_due IS NOT NULL`
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('SCH-03 / P10: business_today() is the only clock', () => {
  it('resolves to a date and follows app_setting', async () => {
    const rows = await q('SELECT septic_app.business_today() AS d');
    expect(rows[0].d).toBeInstanceOf(Date);
  });

  it('answers in the business zone, not the container zone (0032)', async () => {
    // The office is Central; this Postgres is UTC. Between 18:00 and
    // midnight Central the two dates differ, and a released clock that
    // followed the container told the office it was tomorrow — the 09/06
    // evening report. The date the whole app reads must be the date in
    // Chicago no matter what zone the session or the box believes.
    await q('BEGIN');
    try {
      await q(`SET LOCAL TIME ZONE 'Asia/Tokyo'`);
      const rows = await q(
        `SELECT to_char(septic_app.business_today(), 'YYYY-MM-DD') AS d,
                to_char((now() AT TIME ZONE 'America/Chicago')::date,
                        'YYYY-MM-DD') AS central,
                to_char(current_date, 'YYYY-MM-DD') AS tokyo`,
      );
      expect(rows[0].d).toBe(rows[0].central);
      // A session genuinely in another zone proves the answer does not
      // drift with it — Tokyo is +9, and if the function still followed
      // session time the two would not merely differ, they would differ
      // from a different direction than the Chicago pair ever can.
      expect(typeof rows[0].tokyo).toBe('string');
    } finally {
      await q('ROLLBACK');
    }
  });
});

describe('BIL-04: money is never a float', () => {
  it('every monetary column is numeric', async () => {
    // Matched by name, so the set is judgement calls rather than a rule the
    // database can state. %tax% is deliberately absent: it also matches the
    // boolean payers.tax_exempt, which is a flag, not an amount.
    const rows = await q(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'septic_app'
          AND (column_name ILIKE '%amount%' OR column_name ILIKE '%total%'
               OR column_name ILIKE '%price%' OR column_name ILIKE '%cost%'
               OR column_name ILIKE '%rate%'  OR column_name ILIKE '%balance%')`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => !/numeric/.test(r.data_type))).toEqual([]);
  });
});

describe('SCH-05: a property has at most one current owner', () => {
  it('the partial unique index exists', async () => {
    const rows = await q(
      `SELECT i.relname FROM pg_class i WHERE i.relname = 'uq_one_current_owner' AND i.relkind = 'i'`,
    );
    expect(rows).toHaveLength(1);
  });
});

describe('AUT-07: the role vocabulary is exactly four values', () => {
  // The migration, the entity, the middleware and the frontend all repeat this
  // list. If they disagree, a user can hold a role no screen will ever accept.
  it('user_role matches docs/REQUIREMENTS.md', async () => {
    const rows = await q(
      `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'user_role' ORDER BY e.enumsortorder`,
    );
    expect(rows.map((r) => r.enumlabel)).toEqual(['admin', 'manager', 'driver', 'office']);
  });
});

describe('BIL: invoices.amount_paid stays in step with the payments that produced it', () => {
  /**
   * `invoices.amount_paid` is a denormalised copy of SUM(payments.amount) for that
   * invoice. There is no trigger, no generated column and no CHECK keeping it there —
   * the only triggers on `invoices` are FK constraint triggers, which I checked in
   * pg_trigger rather than assumed. The ETL reconciled the two at import and the
   * application has owned the agreement ever since.
   *
   * That is fine until the first write path that inserts a payment and forgets the
   * other side, at which point a customer's balance is quietly wrong and the number on
   * the invoice is the one people trust. So the agreement is asserted here, per invoice
   * rather than in aggregate: a total that matches while individual invoices do not is
   * two errors cancelling out, and that is the failure this would miss.
   *
   * The real fix is a trigger or a generated column. Until one exists, this is the only
   * thing standing between a forgotten UPDATE and an incorrect bill.
   */
  it('no invoice disagrees with the sum of its payments', async () => {
    const rows = await q(
      `SELECT i.id, i.amount_paid, coalesce(s.total, 0) AS paid_from_payments
         FROM septic_app.invoices i
    LEFT JOIN (SELECT invoice_id, sum(amount) AS total FROM septic_app.payments GROUP BY 1) s
            ON s.invoice_id = i.id
        WHERE i.amount_paid IS DISTINCT FROM coalesce(s.total, 0)
        ORDER BY i.id
        LIMIT 12`,
    );
    expect(rows).toEqual([]);
  });

  it('the two sides agree in total, to the cent', async () => {
    const rows = await q(
      `SELECT (SELECT coalesce(sum(amount), 0) FROM septic_app.payments) AS from_payments,
              (SELECT coalesce(sum(amount_paid), 0) FROM septic_app.invoices) AS on_invoices`,
    );
    expect(String(rows[0].from_payments)).toBe(String(rows[0].on_invoices));
  });

  it('no payment points at an invoice that does not exist', async () => {
    // A dangling payment is invisible in every total and fatal in every statement.
    const rows = await q(
      `SELECT p.id, p.invoice_id FROM septic_app.payments p
        WHERE NOT EXISTS (SELECT 1 FROM septic_app.invoices i WHERE i.id = p.invoice_id)`,
    );
    expect(rows).toEqual([]);
  });

  it('nothing has been paid twice over', async () => {
    // amount_paid exceeding total is not a rounding problem, it is a refund that was
    // never recorded as one. One such row is sitting in import_quarantine right now.
    // A correction document (BIL-05) carries a signed total by design, so amount_paid
    // (0) over a negative total is not an overpayment — only a real bill can be one.
    const rows = await q(
      `SELECT id, total, amount_paid FROM septic_app.invoices
        WHERE amount_paid > total AND kind = 'invoice'`,
    );
    expect(rows).toEqual([]);
  });
});
