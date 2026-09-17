import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm';

/**
 * A source row the migration refused to interpret — DATA_MODEL §9.
 *
 * This is the most reviewable table in the schema and the only place a human can
 * correct the migration, so it is written to be read by a person rather than a query:
 *
 *  - `raw` is the original row as JSON, exactly as the CSV had it. Not the cleaned
 *    version — the point is to compare what arrived with what we decided.
 *  - `reason` distinguishes the failures from each other, and the families are not
 *    interchangeable. Measured across the 3,876 rows sitting here now:
 *
 *    | Family | Rows | What it actually means |
 *    |---|---|---|
 *    | `orphan_line_below_window` | 1,709 | line item whose invoice predates the export window |
 *    | `orphan_line_in_gap` | 1,404 | line item whose invoice was never exported at all |
 *    | `inspection_date_unparseable` | 716 | inspection with a blank or unreadable date |
 *    | `invoice_date_missing_or_impossible` | 33 | invoice that cannot be dated |
 *    | `orphan_line_negative_invoice_number` | 6 | invoice number below zero |
 *    | `orphan_line_header_quarantined` | 4 | header row itself was rejected |
 *    | `service_date_unparseable` | 2 | the only two ledger rows the transform refused |
 *    | `orphan_line_past_max` | 1 | line item beyond the last known invoice |
 *    | `amount_paid_exceeds_total` | 1 | paid more than the invoice said |
 *
 *    A single 'invalid' bucket would have merged nine different jobs into one pile.
 *
 *    Note before building a filter on it: `reason` is not a small enum. The
 *    `orphan_line_*` codes carry the invoice number in the string, so 3,876 rows produce
 *    2,944 distinct values. Anything that groups or filters this table has to split on
 *    ':' first, or it will offer the office a 2,944-entry dropdown.
 *  - `resolved_at` / `resolved_by` make the queue drainable. Without them the table is
 *    a permanent pile of shame that nobody can tell is already fixed, and 3,876 rows
 *    is not a backlog, it is a wall.
 *
 *    They record *that* a row was dealt with and *who* dealt with it. There is no
 *    `resolution_note`, so nothing records *what was decided* — which for a table whose
 *    entire purpose is an audit trail is the gap in it. Resolving the six negative invoice
 *    numbers, for instance, leaves no trace of which invoice each was thought to be. The
 *    fix is one nullable text column; it is carried in DATA_MODEL §13 rather than added
 *    here, because this table belongs to a migration and migrations are checksummed.
 *
 * 3,876 rows sit here now. They are not errors to be deleted: they are the difference
 * between a migration that is 99.9% complete and one that can prove it.
 *
 * @see src/controllers/quarantine.controller.ts for the read and resolve endpoints.
 *
 * A correction, because the header of migration 0011 is wrong and cannot be edited:
 *
 * 0011 opens "Nothing is silently dropped during the ETL" and lists four known rejects.
 * Measured against the loaded data, three of the four are wrong and two things really were
 * dropped:
 *
 *   | 0011 claims                          | Measured                                    |
 *   |--------------------------------------|---------------------------------------------|
 *   | 2 malformed service dates            | correct — both are here, `12/21/217`, `4/1/158` |
 *   | 8 malformed next-due dates           | 0 quarantined. `next_service_pump_date` is never read at all (05_service_events.sql:101) |
 *   | 1 Range value of '189871'            | not rejected — loaded into `properties.plss_range` |
 *   | 1 Contract Date of '11/11/1111'      | there are 2, and both were silently nulled  |
 *
 * `contract_date` is read through `wb_date()` at 03_people_and_places.sql:144 with no
 * quarantine INSERT beside it, so the two `11/11/1111` rows became `ownership_start IS
 * NULL` with no trace. `range` is the PLSS range of the parcel — the legal land description,
 * whose real values look like `13`, `20A`, `25NE` — and `pg_temp.clean()` does not validate
 * it, so `'189871'` is in the column now.
 *
 * The migration file itself is left exactly as it is. `scripts/migrate.ts` stores a sha256
 * of every migration and refuses to run on a mismatch, and migration-integrity.test.ts
 * recomputes them, so a comment edit is a schema drift event. That is the right trade —
 * the alternative is a checksum that nobody can trust — but it means the correction lives
 * here and in DATA_MODEL §13, and anyone reading only the migration will be misled. That is
 * the cost of putting a claim about data inside a checksummed artifact, and it is worth
 * knowing rather than pretending the comment can be quietly fixed.
 */
@Entity('import_quarantine')
export class ImportQuarantine {
  @PrimaryGeneratedColumn()
  id: number;

  /** Which of the nine source files, so a bad file can be fixed upstream and re-run. */
  @Column({ type: 'text' })
  source_file: string;

  /** One-based line in that file, including the header. The only way back to the paper. */
  @Column({ type: 'int' })
  row_no: number;

  /** The row verbatim. Anything the ETL inferred has already been thrown away by here. */
  @Column({ type: 'jsonb' })
  raw: Record<string, unknown>;

  @Column({ type: 'text' })
  reason: string;

  /** Set by whoever fixed it. NULL means still waiting. */
  @Column({ type: 'timestamptz', nullable: true })
  resolved_at: Date | null;

  /** users.id, not a name: a name is a string that can be wrong about who fixed it. */
  @Column({ type: 'int', nullable: true })
  resolved_by: number | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'quarantined_at' })
  quarantined_at: Date;
}
