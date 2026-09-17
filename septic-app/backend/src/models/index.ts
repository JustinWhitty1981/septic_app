/**
 * Every entity in the app, and every one of them maps to a table that exists.
 *
 * This barrel used to export thirteen classes, nine of which described tables the
 * schema no longer has. They compiled, they loaded, and they returned
 * `relation "septic_app.customers" does not exist` to whoever clicked them — because
 * nothing between a decorator and a database ever checked. That gap is now closed by
 * tests/entity-schema.test.ts rather than by care, which is the only kind of closure
 * that survives the next change.
 *
 * Tables with no entity here on purpose: `job_notes`, `media`, `app_setting`, `import_log`,
 * `import_staging`, `schema_migrations`. They exist in the schema and have no feature that
 * reads them yet. An entity is not a courtesy — it is a promise that something will write
 * through it, and each one arrives with the route that needs it.
 *
 * `routes` and `route_stops` kept that promise in this slice. Until it was kept, the promise
 * was the only thing standing between the schema and a feature that had been described for
 * thirteen migrations and never built: `v_driver_dispatch` had returned 0 rows since the day
 * it was created, and `verify_schema.sql` reported `ok` about it every run.
 */
export * from './enums';
export { User } from './User';
export { Property } from './Property';
export { Payer } from './Payer';
export { PropertyOwnership } from './PropertyOwnership';
export { Tank } from './Tank';
export { ServiceEvent } from './ServiceEvent';
export { Pumper } from './Pumper';
export { ServiceType } from './ServiceType';
export { Invoice } from './Invoice';
export { InvoiceLine } from './InvoiceLine';
export { Payment } from './Payment';
export { Inspection } from './Inspection';
export { ImportQuarantine } from './ImportQuarantine';
export { Route } from './Route';
export { RouteStop } from './RouteStop';
export {
  County, WasteType, DisposalSite, BaffleMaterial, SepticSystemType,
} from './lookups';
