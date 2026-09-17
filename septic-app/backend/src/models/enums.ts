/**
 * The Postgres enums in schema `septic_app`, mirrored once.
 *
 * `enumName` is not optional. TypeORM derives a type name from table_column when you
 * omit it, so `users.role` would look for `users_role_enum` — but migration 0001
 * created a type actually called `user_role`. Every INSERT through such an entity
 * fails with "type does not exist", on the first write anybody makes, long after the
 * entity passed review.
 *
 * These are checked against pg_type and pg_enum by tests/entity-schema.test.ts, so a
 * union here that drifts from the database fails the build rather than production.
 */

export const PROPERTY_STATUS = ['active', 'inactive', 'sealed', 'unknown'] as const;
export type PropertyStatus = (typeof PROPERTY_STATUS)[number];

export const EVENT_STATUS = ['scheduled', 'dispatched', 'completed', 'cancelled', 'no_access'] as const;
export type EventStatus = (typeof EVENT_STATUS)[number];

export const TANK_ROLE = ['primary', 'pre_cleanout', 'sand_filter', 'secondary'] as const;
export type TankRole = (typeof TANK_ROLE)[number];

export const INVOICE_STATUS = ['draft', 'open', 'paid', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUS)[number];

export const PAYMENT_METHOD = ['check', 'cash', 'card', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHOD)[number];

export const USER_ROLE = ['admin', 'manager', 'driver', 'office'] as const;
export type UserRole = (typeof USER_ROLE)[number];

/**
 * A route's life is draft → published → in_progress → done, and only the first two
 * transitions belong to the office. `in_progress` and `done` are written by the driver's
 * device, which is a separate slice (DRV-06/07) — the composition endpoints refuse to
 * fake it, because a route marked in_progress by a keyboard in the office is a lie about
 * where the truck is.
 */
export const ROUTE_STATUS = ['draft', 'published', 'in_progress', 'done'] as const;
export type RouteStatus = (typeof ROUTE_STATUS)[number];

/**
 * `arrived` is spelled the way the enum is, not `arrived_at` — the timestamp column is
 * `arrived_at`. Both are in migration 0007 and neither is negotiable now.
 *
 * `no_access` and `skipped` are different answers and stay different: one means the crew
 * stood at the site and could not get in, the other means they never went.
 *
 * **They are not the same to the database either, and the difference is easy to read
 * backwards.** `uq_stop_one_open_route` is partial on `status NOT IN ('done','skipped')`, so
 * exactly two of the five values leave the index. `skipped` leaves it — the site was never
 * attempted, so another truck may have it that day. `no_access` **stays in it**, so a site
 * the crew could not get into remains claimed for the whole date and the composition
 * endpoint refuses to put it on anybody's day again. That is a defensible rule (you are not
 * sending the second truck to a locked gate at 2pm; you reschedule) but it is a decision, and
 * it is not the one a first reading of the 0007 comment suggests. Nothing here changes it:
 * SCH-08 is tested against the predicate as written.
 */
export const STOP_STATUS = ['pending', 'arrived', 'done', 'no_access', 'skipped'] as const;
export type StopStatus = (typeof STOP_STATUS)[number];
