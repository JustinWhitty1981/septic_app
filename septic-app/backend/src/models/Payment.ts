import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm';
import { PAYMENT_METHOD, PaymentMethod } from './enums';

/**
 * A payment against one invoice — DATA_MODEL §6.
 *
 * `amount` and `method` are the only two NOT NULL columns with no default, which is
 * the schema refusing to guess: a payment of an unknown amount, or of unknown kind,
 * cannot be reconciled or deposited. Every other column here is optional because the
 * source is often silent — 3,203 legacy payment dates arrived in a format the first
 * parser read as zero dates.
 *
 * Payments are never updated to change `amount`; they are voided and re-entered, so
 * the ledger keeps the shape of what the office actually did.
 */
@Entity('payments')
export class Payment {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int' })
  invoice_id: number;

  @Column({ type: 'numeric', precision: 10, scale: 2 })
  amount: string;

  @Column({ type: 'enum', enum: PAYMENT_METHOD, enumName: 'payment_method' })
  method: PaymentMethod;

  /** Cheque number, card authorisation, or whatever the office wrote on the receipt. */
  @Column({ type: 'varchar', length: 50, nullable: true })
  reference: string | null;

  @Column({ type: 'date', nullable: true })
  paid_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
