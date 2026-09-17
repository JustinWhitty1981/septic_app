import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

/**
 * A county tank inspection — DATA_MODEL §7.
 *
 * This is a different event from a pump-out and the legacy app kept them in the same
 * table, which is why `prev_owner_first` / `prev_owner_last` exist here and nowhere
 * else. A county inspection asks who owned the tank previously; a pump-out does not
 * care. Collapsing the two lost the answer to a question the county can still ask.
 *
 * The two name columns stay split because that is how the source recorded them and
 * because the county form has two boxes. Concatenating into one field would make the
 * form unfillable without guessing where the first name ends.
 */
@Entity('inspections')
export class Inspection {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int' })
  property_id: number;

  @Column({ type: 'date' })
  inspection_date: Date;

  @Column({ type: 'varchar', length: 100, nullable: true })
  prev_owner_first: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  prev_owner_last: string | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Column({ type: 'int', nullable: true, unique: true })
  legacy_inspect_id: number | null;
}
