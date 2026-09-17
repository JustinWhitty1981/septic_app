import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';
import { TANK_ROLE, TankRole } from './enums';

/**
 * One physical tank at a site — DATA_MODEL §4.
 *
 * `raw_text` is NOT NULL on purpose. It is the string the source actually contained
 * ('1000+1250', '2-2000', '1000+'), and it is the only way anybody can later check
 * whether the parse was right. Dropping it would make the derived columns unfalsifiable:
 * we would have a clean number and no way to prove we earned it.
 *
 * `sequence_no` and `role` are derived from that string and are editable, because a
 * crew standing at the lid is the authority on which tank is which. The CHECK in
 * migration 0006 guarantees one primary tank per property — a job cannot be scheduled
 * against a site whose primary tank is ambiguous.
 */
@Entity('tanks')
export class Tank {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int' })
  property_id: number;

  @Column({ type: 'smallint' })
  sequence_no: number;

  @Column({ type: 'enum', enum: TANK_ROLE, enumName: 'tank_role' })
  role: TankRole;

  /**
   * Nullable because the source is honest about being wrong: '2200-2600 total' is a
   * range, not a capacity, and guessing the midpoint would put a made-up number in the
   * column the due date is calculated from.
   */
  @Column({ type: 'int', nullable: true })
  capacity_gallons: number | null;

  @Column({ type: 'boolean', default: false })
  has_filter: boolean;

  @Column({ type: 'varchar', length: 100 })
  raw_text: string;
}
