import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm';
import { INVOICE_STATUS, InvoiceStatus } from './enums';

/**
 * An invoice — DATA_MODEL §6.
 *
 * `payer_id` is NOT NULL and `property_id` is nullable. That asymmetry is the schema's
 * opinion, not the data's: all 3,249 loaded invoices do name a site, so the nullable
 * column has never actually been exercised. It stays nullable because an invoice raised
 * against a payer alone — a callout that went nowhere, a deposit — is a thing that can
 * happen, and the alternative is refusing to bill it. Making the site mandatory would
 * quarantine such an invoice; making the payer optional would create bills nobody can be
 * chased for.
 *
 * READ THIS BEFORE WRITING TO `amount_paid`. It is a denormalised copy of
 * SUM(payments.amount) for this invoice, and there is no trigger, no generated column
 * and no CHECK keeping it there — I checked pg_trigger, the only triggers on this
 * table are FK constraint triggers. The ETL reconciled the two at import and the
 * application has owned the agreement ever since: an insert into payments that forgets
 * to update invoices.amount_paid silently understates what a customer owes, and the
 * number on the invoice is the one people trust.
 *
 * Measured on the loaded data: 3,199 payments totalling $980,833.95, matching
 * sum(invoices.amount_paid) to the cent, with zero invoices disagreeing individually.
 * tests/schema-invariants.test.ts asserts that per invoice, because a total that
 * matches while the invoices behind it do not is two errors cancelling out.
 *
 * A trigger or a generated column is the real fix. Until one exists, write payments and
 * amount_paid in one transaction.
 */
@Entity('invoices')
export class Invoice {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', nullable: true, unique: true })
  legacy_invoice_no: number | null;

  @Column({ type: 'int' })
  payer_id: number;

  @Column({ type: 'int', nullable: true })
  property_id: number | null;

  /** Set when the invoice is for one specific pump-out, so a bill can be argued about. */
  @Column({ type: 'bigint', nullable: true })
  service_event_id: number | null;

  @Column({ type: 'date' })
  invoice_date: Date;

  @Column({ type: 'numeric', precision: 10, scale: 2, default: 0 })
  subtotal: string;

  /** Stored as a rate, not a percentage: 0.055, so `subtotal * tax_rate` is the tax. */
  @Column({ type: 'numeric', precision: 5, scale: 4, default: 0 })
  tax_rate: string;

  @Column({ type: 'numeric', precision: 10, scale: 2, default: 0 })
  tax_amount: string;

  @Column({ type: 'numeric', precision: 10, scale: 2, default: 0 })
  total: string;

  @Column({ type: 'numeric', precision: 10, scale: 2, default: 0 })
  amount_paid: string;

  /**
   * 'draft' exists because the legacy export had no status at all and every row
   * arrived as 'open'. 'void' rather than a delete: a voided invoice has to stay in
   * the ledger or the totals stop reconciling.
   */
  @Column({
    type: 'enum', enum: INVOICE_STATUS, enumName: 'invoice_status', default: () => "'open'",
  })
  status: InvoiceStatus;

  /**
   * BIL-05: 'credit' and 'adjustment' rows correct the book by addition, never
   * by rewrite, and must name the invoice they correct (chk_adjust_links).
   * 'invoice' is everything the legacy corpus ever was.
   */
  @Column({ type: 'varchar', length: 16, default: () => "'invoice'" })
  kind: string;

  @Column({ type: 'int', nullable: true })
  adjusts_invoice_id: number | null;

  /**
   * Who created the document, read from the login (0035). NULL is the legacy
   * import — a real row whose author predates every login here — not "anonymous
   * by choice". Never taken from a request body.
   */
  @Column({ type: 'int', nullable: true })
  created_by: number | null;

  /**
   * BIL-05: the human reason a correction was filed, required on an adjustment
   * or credit (chk_adjust_explains) and NULL on an original — a bill needs no
   * apology. This is the sentence a customer complaint is answered from.
   */
  @Column({ type: 'text', nullable: true })
  adjust_reason: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
