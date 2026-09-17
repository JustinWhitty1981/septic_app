import { randomBytes } from 'crypto';

/**
 * Turns an unknown thrown value into something safe to put in an HTTP body.
 *
 * Every controller catch block used to do `error: error.message`, which meant a
 * client received Postgres' own words verbatim. With the routes behind a plain
 * `authenticate` and no role check, one low-privilege driver token — what a stolen
 * tablet holds — was enough to walk the schema:
 *
 *   GET /api/customers  ->  {"error":"relation \"septic_app.customers\" does not exist"}
 *   GET /api/properties ->  {"error":"column property.address does not exist"}
 *
 * Those responses name tables and columns and confirm which ones exist, which is a
 * map of the database handed to anyone who bothers to ask. It also leaks through
 * routes that work: a query that merely fails validation reports the constraint it
 * tripped, telling the caller exactly what the column will and will not accept.
 *
 * Deleting the field outright would have been worse than leaving it. These catch
 * blocks do not log — only auth.controller.ts did — so removing the message would
 * have taken the only copy of the error with it, and a production 500 would have
 * become undiagnosable. So the detail is written to the server log, where it belongs,
 * and the client gets a reference that ties their report to that log line.
 *
 * A 500 is chosen deliberately as the boundary: it is by definition a failure the
 * caller cannot act on. Client-actionable messages belong in 4xx responses, which
 * state their own reason and are not routed through here.
 */
export function internalError(error: unknown): string {
  const ref = randomBytes(4).toString('hex').toUpperCase();
  const err = error as Error | undefined;
  // The stack names the controller and line, which is the context the response no
  // longer carries. Logged, never returned.
  console.error(`[E${ref}] ${err && err.stack ? err.stack : String(error)}`);
  return `Internal error ${ref}`;
}
