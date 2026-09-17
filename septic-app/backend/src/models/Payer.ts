import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm';

/**
 * Whoever gets the bill — DATA_MODEL §3.
 *
 * The separation is the point: a site and the party that pays for it are different
 * things that change on different clocks. Legacy conflated them, which is why one
 * household with three rental properties appeared as three "customers" and the
 * headcount was wrong (P2).
 *
 * Nothing here is NOT NULL. The source supplies no email for a single one of the 7,572
 * payers, and no phone for 7,454 of them, so a NOT NULL on either would have failed the
 * import rather than recorded the gap.
 */
@Entity('payers')
export class Payer {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', nullable: true, unique: true })
  legacy_billing_no: number | null;

  /**
   * Tried before the name pair when a display name is assembled. 7,543 of 7,572 payers
   * have an organisation or at least one name; the remaining 29 have none of the three
   * and render as `Payer #id`, which is honest, rather than as an empty string that a
   * bill then gets addressed to.
   */
  @Column({ type: 'varchar', length: 200, nullable: true })
  org_name: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  first_name: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  last_name: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  email: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  mailing_address: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  mailing_city: string | null;

  @Column({ type: 'char', length: 2, nullable: true })
  mailing_state: string | null;

  @Column({ type: 'varchar', length: 10, nullable: true })
  mailing_zip: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  phone: string | null;

  @Column({ type: 'varchar', length: 10, nullable: true })
  phone_ext: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  alt_phone: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  fax: string | null;

  @Column({ type: 'boolean', default: false })
  tax_exempt: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  /** Display name, in the order the source itself uses: organisation, then person. */
  get displayName(): string {
    return (
      this.org_name ||
      [this.first_name, this.last_name].filter(Boolean).join(' ') ||
      `Payer #${this.id}`
    );
  }
}
