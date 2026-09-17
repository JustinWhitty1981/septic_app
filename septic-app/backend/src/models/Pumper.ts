import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Whoever holds the septic pump contractor license — DATA_MODEL §5.
 *
 * Deliberately NOT a `users` row. A pumper is a licensing fact about a person who
 * performed a job; a user is an credential that can log in. Most pumpers will never
 * log in, and tying the two together would mean deleting a driver's licence record
 * every time you revoked their app access.
 *
 * `certification_number` is unique, and the ETL matches on it case- and
 * punctuation-insensitively: '4031948' and '4031948 ' are the same contractor, and
 * treating them as two would split one pumpers' history in half.
 */
@Entity('pumpers')
export class Pumper {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 20, unique: true })
  certification_number: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  license_number: string | null;

  @Column({ type: 'varchar', length: 100 })
  first_name: string;

  @Column({ type: 'varchar', length: 100 })
  last_name: string;

  @Column({ type: 'varchar', length: 160, nullable: true })
  company: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  phone: string | null;

  @Column({ type: 'boolean', default: true })
  is_active: boolean;

  /** The certificate string exactly as the source wrote it, when it needed normalising. */
  @Column({ type: 'varchar', length: 20, nullable: true })
  legacy_raw_cert: string | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;
}
