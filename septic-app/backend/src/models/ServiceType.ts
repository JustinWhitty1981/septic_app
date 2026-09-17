import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

/**
 * The price list — DATA_MODEL §6.
 *
 * `is_legacy_catalog` is the column that keeps the app honest about its own history.
 * All 99 codes in this table came out of the legacy product list, and all 3,466 invoice
 * lines reference one, so today every row is legacy and the flag reads as noise. That is
 * the reason to write it down now: the first service type added by hand will be the first
 * row where it is false, and from that day the two kinds of price mean different things —
 * one with a history behind it and one chosen this afternoon. A report that mixes them
 * without saying so presents a guess as a measurement.
 *
 * `default_price` is NULL for all 99 rows. The legacy product table carried descriptions
 * only; the prices lived on the invoice lines, where all 3,466 of them have one. So the
 * price list has no prices in it, and inventing some here would put a number on a screen
 * that no invoice has ever agreed to. Read prices from `invoice_lines.unit_price`.
 */
@Entity('service_types')
export class ServiceType {
  @PrimaryGeneratedColumn()
  id: number;

  /** The legacy product code, kept as text: 'PC', '800PC', '1000PC' are codes, not numbers. */
  @Column({ type: 'varchar', length: 20, unique: true })
  code: string;

  @Column({ type: 'varchar', length: 255 })
  description: string;

  @Column({ type: 'numeric', precision: 10, scale: 2, nullable: true })
  default_price: string | null;

  @Column({ type: 'boolean', default: true })
  is_active: boolean;

  @Column({ type: 'boolean', default: true })
  is_legacy_catalog: boolean;
}
