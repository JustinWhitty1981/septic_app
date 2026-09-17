import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm';
import { EVENT_STATUS, EventStatus } from './enums';

/**
 * A pump-out that happened — DATA_MODEL §5, the ledger the whole app is built on.
 *
 * Two columns exist purely to keep the migration honest:
 *
 *  - `cert_unresolved` / `cert_as_recorded` hold a pumper certificate the ETL could
 *    not match, verbatim, with a flag. 4,685 of 48,214 events are in that state, and
 *    all 4,685 still carry the string. Silently dropping the certificate would have
 *    destroyed the only evidence that the match failed, and a DNR audit cannot be
 *    reconstructed from a clean-looking NULL.
 *
 *  - `source` distinguishes 'legacy_import' from a row a driver entered on a phone.
 *    Without it, a 2019 row and a 2026 row are indistinguishable, and every migration
 *    bug becomes indistinguishable from an app bug.
 *
 * `gallons_pumped` is nullable and 19,200 of 48,214 rows have no value — two fifths of
 * the ledger. Those rows are LOADED, not quarantined (LED-04): quarantining them would
 * empty the due queue while the dashboard reported success.
 */
@Entity('service_events')
export class ServiceEvent {
  @PrimaryGeneratedColumn()
  id: number;

  /**
   * Client-generated, and the reason the app can survive a driver tapping save twice
   * on a bad signal.
   *
   * **The index behind this is plain `UNIQUE (client_uuid)`, not a partial one.** The first
   * version of this comment claimed it was partial, which is what the schema *should* look
   * like for a column 48,214 legacy rows leave NULL, and is not what 0006 wrote. It still
   * behaves correctly — Postgres treats NULLs as distinct in a unique index, so that many
   * missing uuids do not collide — which is exactly why the wrong comment survived: the
   * behaviour is identical either way and only the description was false. Recorded here
   * rather than quietly corrected because an index that is not partial is also an index that
   * is maintained for every legacy row.
   */
  @Column({ type: 'uuid', nullable: true })
  client_uuid: string | null;

  @Column({ type: 'int' })
  property_id: number;

  @Column({ type: 'int', nullable: true })
  performed_by_pumper_id: number | null;

  @Column({ type: 'boolean', default: false })
  cert_unresolved: boolean;

  @Column({ type: 'varchar', length: 20, nullable: true })
  cert_as_recorded: string | null;

  @Column({ type: 'date' })
  service_date: Date;

  @Column({
    type: 'enum', enum: EVENT_STATUS, enumName: 'event_status', default: () => "'completed'",
  })
  status: EventStatus;

  @Column({ type: 'numeric', precision: 8, scale: 1, nullable: true })
  gallons_pumped: string | null;

  @Column({ type: 'int', nullable: true })
  waste_type_id: number | null;

  @Column({ type: 'text', nullable: true })
  waste_note: string | null;

  @Column({ type: 'int', nullable: true })
  disposal_site_id: number | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  disposal_method: string | null;

  @Column({ type: 'date', nullable: true })
  disposal_date: Date | null;

  @Column({ type: 'varchar', length: 30, nullable: true })
  dnr_permit_number: string | null;

  @Column({ type: 'numeric', precision: 4, scale: 2, nullable: true })
  ph_before: string | null;

  @Column({ type: 'numeric', precision: 4, scale: 2, nullable: true })
  ph_after: string | null;

  @Column({ type: 'int', nullable: true })
  duration_minutes: number | null;

  @Column({ type: 'date', nullable: true })
  county_form_date: Date | null;

  @Column({ type: 'varchar', length: 16, default: () => "'legacy_import'" })
  source: string;

  /**
   * LED-01: a correction is a new row that names the event it replaces. An
   * event is superseded iff another event names it — the chain is the state,
   * so there is no 'superseded' column that could disagree with it.
   */
  @Column({ type: 'bigint', nullable: true })
  corrects_event_id: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
