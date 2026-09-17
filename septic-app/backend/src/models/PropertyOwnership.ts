import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Who paid for a site, and when — DATA_MODEL §3.
 *
 * The join table is the whole argument for splitting payers from properties. Legacy
 * had one owner column, so a sale meant overwriting history: the previous owner
 * disappeared and the invoices already sent to them described the wrong person.
 *
 * `ownership_end` stays NULL for the current owner. A partial UNIQUE index
 * (migration 0006) allows exactly one open row per site, so "who owns it now" is a
 * lookup rather than a MAX(date) guess.
 */
@Entity('property_ownerships')
export class PropertyOwnership {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int' })
  payer_id: number;

  @Column({ type: 'int' })
  property_id: number;

  /** Where one site bills to several payers, this is the one the invoice defaults to. */
  @Column({ type: 'boolean', default: true })
  is_primary: boolean;

  @Column({ type: 'date', nullable: true })
  ownership_start: Date | null;

  @Column({ type: 'date', nullable: true })
  ownership_end: Date | null;

  /** 'legacy' versus 'app', so a bad migration row is separable from a real one. */
  @Column({ type: 'varchar', length: 20, default: () => "'legacy'" })
  source: string;
}
