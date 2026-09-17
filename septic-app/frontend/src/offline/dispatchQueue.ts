/**
 * Driver writes, expressed as things that can be queued.
 *
 * This file exists so the rules about *what a truck is allowed to claim* live in one place
 * instead of being re-derived at every button. The server enforces all of them anyway — a
 * device is a hostile client with a nice UI — but a client that habitually sends an illegal
 * body is a client whose queue fills up with 400s.
 */

import { SendResult, Sender, QueuedWrite } from './outbox';
import { StopStatus } from '../services/routeService';

/** What a driver may set. `pending` is absent on purpose: a truck cannot un-visit a site. */
export type DeviceStopStatus = Extract<StopStatus, 'arrived' | 'done' | 'no_access' | 'skipped'>;

/** The same four, as a value, so a queued body can be checked rather than trusted. */
const DEVICE_STATUSES: readonly DeviceStopStatus[] = ['arrived', 'done', 'no_access', 'skipped'];

/**
 * The transitions a driver can actually reach, mirroring the server's machine:
 * `arrived` only from `pending`, and nothing at all once a stop is terminal.
 *
 * Derived from the server rather than invented here. A button the server will refuse is
 * worse than no button: it looks like the app is broken, and on a jobsite with one bar of
 * signal the driver cannot tell the two apart.
 */
export function allowedNext(from: StopStatus): DeviceStopStatus[] {
  if (from === 'pending') return ['arrived', 'no_access', 'skipped'];
  if (from === 'arrived') return ['done', 'no_access'];
  return [];
}

/**
 * Fields the server assigns and a device must never send. Mirrors `SERVER_OWNED` in
 * `dispatch.controller.ts`; a body carrying any of them is refused with a 400 there, so
 * building one here would be a write that is guaranteed to fail after the signal returns.
 */
export const SERVER_OWNED_FIELDS = [
  'service_date', 'arrived_at', 'completed_at', 'resolved_at',
  'performed_by_pumper_id', 'source', 'property_id', 'route_id', 'sequence_no',
] as const;

export interface StopStatusInput {
  status: DeviceStopStatus;
  /** Only meaningful with `done`. The server bounds it and files the ledger row from it. */
  gallons_pumped?: number;
  /** Required with `done`: the server refuses a disposal that does not say where it went. */
  disposal_site_id?: number;
  disposal_method?: string;
}

/**
 * Build the queued write for a driver tapping a stop.
 *
 * ## The field that is missing on purpose
 *
 * No `version`. The endpoint accepts it for optimistic concurrency, and an online screen
 * should keep using it — but a *queued* write is one that is, by construction, late. Pinning
 * the version the driver saw means the office re-ordering the day while the truck was in a
 * field turns every queued completion into a 409, and the driver's actual work is thrown
 * away because a number moved.
 *
 * That is safe here only because three stronger checks run regardless of the version: the
 * transition machine refuses impossible state changes, ownership refuses another driver's
 * stop, and `client_uuid` refuses a duplicate of this same write. Between them they cover
 * every collision an offline day can actually produce, and they answer it the way DRV-14
 * demands — by ownership, with no merge. A device that sends a version is claiming it knows
 * the current state of a day it has not spoken to in an hour. It does not.
 */
export function stopStatusWrite(
  stopId: number,
  input: StopStatusInput
): { method: string; path: string; body: Record<string, unknown> } {
  const body: Record<string, unknown> = { status: input.status };
  if (input.gallons_pumped !== undefined) body.gallons_pumped = input.gallons_pumped;
  if (input.disposal_site_id !== undefined) body.disposal_site_id = input.disposal_site_id;
  if (input.disposal_method !== undefined) body.disposal_method = input.disposal_method;
  return { method: 'PATCH', path: `/api/dispatch/stops/${stopId}/status`, body };
}

/**
 * Read a queued write back into the stop it belongs to.
 *
 * Sits beside `stopStatusWrite` rather than in the screen that needs it, because the two
 * share the URL shape and only one of them should own it. A second copy of that pattern,
 * written later by whoever builds the badge, is the kind of thing that quietly stops working
 * when the route changes and the badge goes blank on a day full of unsent work.
 */
export function parseStopStatusWrite(
  w: QueuedWrite
): { stopId: number; status: DeviceStopStatus; gallons: number | null } | null {
  const match = /^\/api\/dispatch\/stops\/(\d+)\/status$/.exec(w.path);
  if (!match) return null;
  const body = w.body as { status?: unknown; gallons_pumped?: unknown } | null;
  if (!body || typeof body.status !== 'string') return null;
  if (DEVICE_STATUSES.indexOf(body.status as DeviceStopStatus) === -1) return null;
  const gallons = typeof body.gallons_pumped === 'number' ? body.gallons_pumped : null;
  return { stopId: Number(match[1]), status: body.status as DeviceStopStatus, gallons };
}

/**
 * Send a queued write with whatever credentials the device currently holds.
 *
 * The token is read at send time, not at enqueue time. A write queued on Monday and sent
 * Wednesday must go out under Wednesday's session; baking the token into the queue would
 * either send a dead credential or, worse, keep working quietly after the driver who made
 * the write had left the company.
 */
export function makeFetchSender(getToken: () => string | null): Sender {
  return async (w: QueuedWrite): Promise<SendResult> => {
    const token = getToken();
    const res = await fetch(w.path, {
      method: w.method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(w.body),
    });
    // A body that is not JSON is still a verdict; the status is what the queue branches on.
    const body = await res.json().catch(() => undefined);
    return { status: res.status, body };
  };
}
