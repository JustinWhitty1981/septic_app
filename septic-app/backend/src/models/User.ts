import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { USER_ROLE, UserRole } from './enums';

/**
 * Re-exported so `import { UserRole } from '../models/User'` keeps working at the six
 * call sites. The definition lives in ./enums.ts beside the other seven, because the
 * entity-schema test walks every entity's enum columns and can only check values that
 * are declared in one place.
 */
export type { UserRole };
export const USER_ROLES: readonly UserRole[] = USER_ROLE;

/**
 * Mirrors the `user_role` enum in db/migrations/0001_foundation.sql.
 *
 * The old vocabulary was admin | manager | technician. `technician` became `driver`
 * and `office` was added, because the schema separates the person who pumps
 * (`pumpers`, a regulatory identity) from the person who logs in (`users`) — a
 * driver is the primary PWA user and office staff have logins but no certification.
 */
@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 255, unique: true })
  email: string;

  @Column({ type: 'varchar', length: 255 })
  password_hash: string;

  @Column({ type: 'varchar', length: 100 })
  first_name: string;

  @Column({ type: 'varchar', length: 100 })
  last_name: string;

  /**
   * `enumName: 'user_role'` is not decoration. Without it TypeORM derives the type
   * name from table and column — `users_role_enum` — which is not what migration 0001
   * created, and every INSERT would fail with `type does not exist`. The previous
   * version of this file worked around that by declaring the column varchar, which
   * reads fine but leaves the value set unchecked. Naming the real enum instead lets
   * tests/entity-schema.test.ts compare these four labels against pg_enum.
   */
  @Column({
    type: 'enum', enum: USER_ROLE, enumName: 'user_role', default: () => "'driver'",
  })
  role: UserRole;

  @Column({ type: 'boolean', default: true })
  is_active: boolean;

  // Nullable: a pumper may never get a login, and office staff have one without a
  // certification. UNIQUE so one certification cannot back two accounts.
  @Column({ type: 'integer', nullable: true, unique: true })
  pumper_id: number | null;

  // Fleet of shared tablets: "when did anyone last use this account".
  @Column({ type: 'timestamptz', nullable: true })
  last_login_at: Date | null;

  // AUT-11: login embeds this epoch in the token; logout increments it and
  // every older token dies. A counter, not a clock — see 0018/0019 for why the
  // timestamp version could not tell two same-second events apart.
  @Column({ type: 'integer', default: 0 })
  tokens_epoch: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
