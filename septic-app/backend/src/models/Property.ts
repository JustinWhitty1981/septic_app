import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { PROPERTY_STATUS, PropertyStatus } from './enums';

/**
 * A septic system at a site — not a person.
 *
 * This is the hub of the model, and the rename that makes the rebuild worth doing:
 * legacy `tblCustomers` always held sites, and the wrong word had propagated into
 * every screen, table and headcount in the old app (P2, DATA_MODEL §3).
 *
 * There are deliberately no relation decorators on this class or on any other entity
 * in src/models/. The previous set mapped them, and the import graph they created
 * (Property -> CustomerProperty -> Customer -> Appointment -> WisconsinStateReport)
 * is the reason nine entities pointing at deleted tables could not be removed without
 * touching nine others. Plain foreign-key columns keep every entity one file that can
 * be read, changed and deleted on its own. Joins belong in the query that needs them.
 */
@Entity('properties')
export class Property {
  @PrimaryGeneratedColumn()
  id: number;

  /** Crews say "cust #3494" on the radio. A natural key, not a curiosity (P2). */
  @Column({ type: 'int', nullable: true, unique: true })
  legacy_cust_number: number | null;

  /** 'Eubanks Rental', 'Zommers Property' — what the legacy app displayed as a name. */
  @Column({ type: 'varchar', length: 200, nullable: true })
  payer_label: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  site_address: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  site_city: string | null;

  @Column({ type: 'char', length: 2, nullable: true })
  site_state: string | null;

  @Column({ type: 'varchar', length: 10, nullable: true })
  site_zip: string | null;

  @Column({ type: 'int', nullable: true })
  county_id: number | null;

  /**
   * County exactly as recorded. county_id is the derived value; this is the evidence
   * it was derived from (P3), and 34 spellings for 7 counties means the derivation is
   * sometimes a guess. Never rewritten by the app.
   */
  @Column({ type: 'text', nullable: true })
  county_raw: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  town: string | null;

  // '25SE', '6NE' — text always. Cast to int and '6NE' becomes an error at 3am.
  @Column({ type: 'varchar', length: 10, nullable: true })
  plss_section: string | null;

  @Column({ type: 'varchar', length: 10, nullable: true })
  plss_range: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  parcel_id: string | null;

  /** 5,120 distinct across 5,168 filled, so it is not unique and must not be indexed as if it were. */
  @Column({ type: 'varchar', length: 30, nullable: true })
  permit_number: string | null;

  @Column({ type: 'int', nullable: true })
  system_type_id: number | null;

  // Field notes: what a driver actually reads at the truck.
  @Column({ type: 'text', nullable: true })
  tank_location_note: string | null;

  @Column({ type: 'text', nullable: true })
  jobsite_location_note: string | null;

  @Column({ type: 'text', nullable: true })
  pump_style_note: string | null;

  @Column({ type: 'text', nullable: true })
  chamber_pump_note: string | null;

  @Column({ type: 'text', nullable: true })
  system_condition_note: string | null;

  @Column({ type: 'int', nullable: true })
  baffle_inlet_material_id: number | null;

  @Column({ type: 'date', nullable: true })
  baffle_inlet_date: Date | null;

  @Column({ type: 'int', nullable: true })
  baffle_outlet_material_id: number | null;

  @Column({ type: 'date', nullable: true })
  baffle_outlet_date: Date | null;

  /** Legacy holds '1 1/2' as a unicode fraction; the ETL turns that into 1.5. */
  @Column({ type: 'numeric', precision: 4, scale: 2, nullable: true })
  hose_count: string | null;

  @Column({ type: 'date', nullable: true })
  pump_installed_date: Date | null;

  @Column({ type: 'int', default: 1095 })
  service_interval_days: number;

  /** Maintained by the ledger, never by a user. Written only by etl/transform/07_derive.sql. */
  @Column({ type: 'date', nullable: true })
  last_service_date: Date | null;

  /**
   * GENERATED ALWAYS AS (last_service_date + service_interval_days) STORED.
   *
   * insert:false and update:false are what stop TypeORM putting this column in an
   * INSERT list; without them every write fails. It cannot be hand-edited into
   * disagreement with its inputs, which is the whole point of P1 — the legacy
   * Next Service Date disagreed with the arithmetic in 32,396 of 45,804 rows because
   * somebody typed over it.
   */
  @Column({ type: 'date', nullable: true, generatedType: 'STORED', insert: false, update: false })
  next_service_due: Date | null;

  @Column({ type: 'boolean', default: false })
  reminder_opt_out: boolean;

  @Column({
    type: 'enum', enum: PROPERTY_STATUS, enumName: 'property_status', default: () => "'active'",
  })
  status: PropertyStatus;

  /** P3: 7,427 verbatim legacy memos, immutable. */
  @Column({ type: 'text', nullable: true })
  legacy_memo: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
