import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm';
import { ROUTE_STATUS, RouteStatus } from './enums';

/**
 * One driver's day — DATA_MODEL §6, the primary feature.
 *
 * This entity arrived late on purpose. `models/index.ts` said a table with no entity is a
 * table with no feature that writes it, and for thirteen migrations that was true of
 * `routes`: the table existed, the view over it existed, and nothing in the application
 * could put a row in it. `v_driver_dispatch` has returned 0 rows since the day it was
 * created. This file is the promise that something now writes through it.
 *
 * Two things worth knowing before using it.
 *
 *  - **`UNIQUE (route_date, driver_id)` is the whole scheduling model.** 2.34 active
 *    pumpers means the schedule is a list of lists, not a matrix: one driver, one day, one
 *    route. There is no second route to reconcile and no partial-day merge to reason about.
 *  - **`route_date` is a `date`, not a `timestamptz`.** A route is a calendar day. A day
 *    stored with an instant attached is a day that changes date when the tablet's timezone
 *    does, and a driver's list would depend on where the phone was set.
 *
 * `version` is the optimistic lock for two tablets open on one route. It is read and
 * incremented by the reorder endpoint (SCH-10) and nothing else — a lock nobody holds is
 * worse than no lock, because it looks like concurrency control.
 *
 * @see src/controllers/route.controller.ts
 * @see src/controllers/dispatch.controller.ts
 */
@Entity('routes')
export class Route {
  @PrimaryGeneratedColumn()
  id: number;

  /**
   * Never compared to the clock in application code. "Today" comes from
   * `business_today()` (P10 / NF-02), which is the difference between a sane queue and a
   * plausible-looking wrong one against the frozen dev snapshot at 2024-12-02.
   */
  @Column({ type: 'date' })
  route_date: Date;

  /** users.id — the login, not the pumper. `users.pumper_id` is the bridge, and it is NULL for both seeded users today. */
  @Column({ type: 'int' })
  driver_id: number;

  /** Free text, because the truck is labelled with a marker, not a foreign key. */
  @Column({ type: 'varchar', length: 30, nullable: true })
  truck_label: string | null;

  @Column({
    type: 'enum', enum: ROUTE_STATUS, enumName: 'route_status', default: () => "'draft'",
  })
  status: RouteStatus;

  /** Driver-side timestamps. Nothing in the composition slice writes either one. */
  @Column({ type: 'timestamptz', nullable: true })
  started_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  completed_at: Date | null;

  @Column({ type: 'int', default: 0 })
  version: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  /**
   * There is no `updated_at` on this table — migration 0007 has `created_at` only, and
   * `entity-schema.test.ts` fails the build if an entity claims a column the database does
   * not have. Last-touch is `version`, which is what the reorder endpoint compares against:
   * an integer that moves only when somebody changed the day, rather than a timestamp that
   * also moves when the row was merely read by a reporting query.
   */
}
