import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

/**
 * The five lookup tables, in one file.
 *
 * Each is a controlled vocabulary the ETL resolves free text against. They live
 * together because they share a shape and a purpose, and because giving five
 * two-column tables five files would make the models directory harder to read, not
 * easier. The entity/schema test in tests/entity-schema.test.ts walks the loaded
 * metadata, so co-locating them costs nothing in coverage.
 *
 * Every one of them keeps the raw string somewhere on the row that used it. That is
 * the recurring rule of this schema: the resolution is a conclusion, the raw text is
 * the evidence, and a migration that keeps only conclusions cannot be audited.
 */

/** Seven real counties, 34 spellings in the source (P3). */
@Entity('counties')
export class County {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 80, unique: true })
  name: string;

  /** Three characters, fixed, because the state publishes them that way and a variable-length code invites '54'. */
  @Column({ type: 'char', length: 3, nullable: true })
  wi_county_fips: string | null;
}

/** What was in the truck. `is_dnr_permitted` decides whether a disposal site may take it. */
@Entity('waste_types')
export class WasteType {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 120, unique: true })
  name: string;

  @Column({ type: 'boolean', default: false })
  is_dnr_permitted: boolean;

  /** True for rows that came from the legacy lookup list rather than being chosen here. */
  @Column({ type: 'boolean', default: true })
  is_legacy_lookup: boolean;
}

/** Where the load went. `dnr_permit_no` is what the county form asks for. */
@Entity('disposal_sites')
export class DisposalSite {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 160, unique: true })
  name: string;

  @Column({ type: 'varchar', length: 40, nullable: true })
  dnr_permit_no: string | null;

  @Column({ type: 'boolean', default: false })
  accepts_slurry: boolean;
}

/** Inlet and outlet baffles are recorded separately and dated separately. */
@Entity('baffle_materials')
export class BaffleMaterial {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 120, unique: true })
  name: string;
}

@Entity('septic_system_types')
export class SepticSystemType {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 120, unique: true })
  name: string;

  /** False marks a non-standard system, which is the one a driver needs warned about. */
  @Column({ type: 'boolean', default: true })
  is_standard: boolean;
}
