import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One line on an invoice — DATA_MODEL §6.
 *
 * `legacy_product_code` is kept as text next to the resolved `service_type_id`, and
 * the reason is the same as everywhere else in this schema: the code is the evidence
 * and the id is the conclusion. 'PC', '800PC' and '1000PC' are product codes that look
 * like numbers, and a resolution that was wrong is only findable if what it started
 * from is still on the row.
 *
 * `amount` is stored rather than computed because the legacy totals are what the
 * customer was actually billed. Recalculating from quantity x unit_price would
 * silently "correct" historical invoices and break the reconciliation that proves the
 * migration was faithful.
 */
@Entity('invoice_lines')
export class InvoiceLine {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int' })
  invoice_id: number;

  @Column({ type: 'int', nullable: true })
  service_type_id: number | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  legacy_product_code: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  description: string | null;

  @Column({ type: 'numeric', precision: 8, scale: 2, default: 1 })
  quantity: string;

  @Column({ type: 'numeric', precision: 10, scale: 2, default: 0 })
  unit_price: string;

  @Column({ type: 'numeric', precision: 10, scale: 2, default: 0 })
  amount: string;

  /**
   * BIL-16/BIL-20: whether the company sales-tax rate reaches this line. It is
   * intent, not money — the amount of tax is the database's, computed once over
   * the sum of the lines that set this true. Default true is the honest seed:
   * every legacy line was taxed (the rate fell across the whole subtotal), so an
   * all-true document is billed exactly as before the column existed.
   */
  @Column({ type: 'boolean', default: true })
  taxable: boolean;

  /**
   * BIL-01: every line references a service event or a product code
   * (chk_line_reference). A description may accompany the reference; alone it
   * is the free-text line-item style that produced the orphaned legacy rows
   * (BIL-03).
   */
  @Column({ type: 'bigint', nullable: true })
  service_event_id: string | null;
}
