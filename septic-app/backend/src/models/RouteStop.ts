import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';
import { STOP_STATUS, StopStatus } from './enums';

/**
 * One site on one driver's day — DATA_MODEL §6.
 *
 * `sequence_no` is the deliverable. A driver's day is ~4 stops peaking near 13, so the
 * order is not metadata to be sorted client-side; it is the thing the office decided when
 * it built the day. `UNIQUE (route_id, sequence_no)` makes a duplicate order impossible and
 * the reorder endpoint rewrites the whole run in one statement (SCH-10) so a half-applied
 * order cannot exist.
 *
 * **Read this before trusting the index on this table.** Migration 0007 says:
 *
 *     -- A property should not sit on two live routes on the same day.
 *     CREATE UNIQUE INDEX uq_stop_one_open_route
 *         ON route_stops (property_id, route_id)
 *         WHERE status NOT IN ('done', 'skipped');
 *
 * The key is `(property_id, route_id)`. Since `routes` is already `UNIQUE (route_date,
 * driver_id)`, that index only prevents a property appearing **twice on the same route**.
 * Two drivers on the same date can both be assigned cust #3494 and the database will not
 * object — which is exactly the failure the comment says it prevents. It cannot be fixed in
 * place (checksummed migration), and it cannot be expressed as an index at all: `route_date`
 * lives on the parent row, a partial index cannot reach a parent, and a generated column may
 * only read its own row.
 *
 * So the rule is enforced in the composition endpoint, under an advisory lock keyed on
 * `(property_id, route_date)`, and `T-SCH-08` proves it holds. Recorded as SCH-08 and in
 * DATA_MODEL §13 rather than left as a comment nobody can act on.
 *
 * @see src/controllers/route.controller.ts `assertNotRoutedThatDay`
 */
@Entity('route_stops')
export class RouteStop {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int' })
  route_id: number;

  @Column({ type: 'int' })
  property_id: number;

  /**
   * Set when the stop is completed, which is the write that belongs to the next slice
   * (DRV-07). Nullable because a stop exists long before anything was pumped at it.
   */
  @Column({ type: 'bigint', nullable: true })
  service_event_id: string | null;

  @Column({ type: 'smallint' })
  sequence_no: number;

  @Column({
    type: 'enum', enum: STOP_STATUS, enumName: 'stop_status', default: () => "'pending'",
  })
  status: StopStatus;

  /** Driver-side. The server assigns these, never the device (DRV-08). */
  @Column({ type: 'timestamptz', nullable: true })
  arrived_at: Date | null;

  /** Written by `done` and by nothing else. See `resolved_at`. */
  @Column({ type: 'timestamptz', nullable: true })
  completed_at: Date | null;

  /**
   * The instant the stop left the working list, whether it ended `done`, `no_access` or
   * `skipped`. `completed_at` cannot carry that meaning for the last two without stating a
   * falsehood about a truck that never emptied anything, so 0017 split the two.
   */
  @Column({ type: 'timestamptz', nullable: true })
  resolved_at: Date | null;

  /**
   * The replay defence NF-03 requires of any table a phone writes, and `route_stops` only
   * became one in this slice. Nullable, and NULLs stay distinct in the unique index, so the
   * office's own writes are unaffected.
   */
  @Column({ type: 'uuid', nullable: true })
  client_uuid: string | null;

  @Column({ type: 'int', default: 0 })
  version: number;
}
