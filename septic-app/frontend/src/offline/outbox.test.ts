/**
 * T-DRV-12 — the offline queue.
 *
 * DRV-12's own verify line is `manual: airplane mode after launch, complete 3 stops,
 * restore, confirm all 3 land`, and that check still has to happen on a phone: nothing here
 * can prove a service worker caches the shell or that a real IndexedDB survives an iOS
 * memory-pressure kill.
 *
 * What these tests do cover is the half that a manual walk-through cannot. Driving three
 * stops by hand confirms the happy path once. It does not confirm what happens when the
 * tablet dies between the send and the delete, when the token expires over a weekend, or
 * when the office re-orders the day while the truck is out of coverage — and those are the
 * failures that lose a pump-out. So the queue's storage, sender and clock are injected, and
 * each test scripts the specific way one of them misbehaves.
 */

import {
  Outbox, QueuedWrite, SendResult, Verdict,
  classify, AUTH_STATUSES, REFUSED_STATUSES,
} from './outbox';
import { stopStatusWrite, SERVER_OWNED_FIELDS } from './dispatchQueue';
import { MemoryStore } from './memoryStore';

interface Harness {
  outbox: Outbox;
  store: MemoryStore;
  /** Every send the queue attempted, in order, with the body it was given. */
  sent: QueuedWrite[];
  refused: QueuedWrite[];
  authLost: QueuedWrite[];
}

/**
 * `respond(w, callIndex)` decides the verdict for the nth attempt at write `w`. Returning an
 * Error stands in for a dead radio — a rejection, not a status code, which is a different
 * branch of the queue for good reason.
 */
function harness(respond: (w: QueuedWrite, call: number) => number | Error = () => 200): Harness {
  const store = new MemoryStore();
  const sent: QueuedWrite[] = [];
  const refused: QueuedWrite[] = [];
  const authLost: QueuedWrite[] = [];
  const calls = new Map<string, number>();
  let seq = 0;
  let clock = 1000;

  const outbox = new Outbox({
    store,
    newUuid: () => `00000000-0000-4000-8000-${String(++seq).padStart(6, '0')}`,
    now: () => (clock += 1000),
    send: async (w): Promise<SendResult> => {
      sent.push({ ...w });
      const n = (calls.get(w.id) ?? 0) + 1;
      calls.set(w.id, n);
      const verdict = respond(w, n);
      if (verdict instanceof Error) throw verdict;
      return { status: verdict, body: { success: verdict < 300 } };
    },
    hooks: { onRefused: (w) => refused.push(w), onAuthLost: (w) => authLost.push(w) },
  });

  return { outbox, store, sent, refused, authLost };
}

const enqueueStop = (h: Harness, stopId: number, status: 'arrived' | 'done' | 'no_access' | 'skipped') =>
  h.outbox.enqueue({
    method: 'PATCH',
    path: `/api/dispatch/stops/${stopId}/status`,
    // The uuid is minted by the queue, which is the point; this call passes none.
    body: { status },
  });

describe('T-DRV-12: the outbox', () => {
  it('mints client_uuid once and never regenerates it across retries', async () => {
    // The headline invariant. If this ever breaks, every retry becomes a brand-new write in
    // the eyes of the server, which files a second pump-out for a site that was pumped once
    // — and a wrong ledger row is the one thing this application cannot correct afterwards.
    const h = harness((w, call) => (call < 3 ? new Error('offline') : 200));

    await enqueueStop(h, 41, 'done');
    await h.outbox.drain();
    await h.outbox.drain();
    await h.outbox.drain();

    expect(h.sent).toHaveLength(3);
    const uuids = new Set(h.sent.map((w) => (w.body as any).client_uuid ?? w.client_uuid));
    expect(uuids.size).toBe(1);
    expect(h.store.rows).toHaveLength(0);
  });

  it('puts the idempotency key in the body the server actually reads', async () => {
    // The queue holds `client_uuid` as a column of its own, but the endpoint reads it out of
    // the JSON body. A queue that mints the key and keeps it to itself produces a write that
    // looks idempotent in every test of the queue and is not one at the server — so what is
    // asserted here is the payload that leaves the building, not the row that was stored.
    const h = harness();
    await h.outbox.enqueue(stopStatusWrite(41, { status: 'done', gallons_pumped: 350 }));

    await h.outbox.drain();

    const body = h.sent[0].body as Record<string, unknown>;
    expect(body.client_uuid).toBe(h.sent[0].client_uuid);
    expect(body.status).toBe('done');
  });

  it('sends writes in the order the driver made them', async () => {
    // arrived-then-done replayed out of order would have `done` land first and the queued
    // `arrived` come back refused against a stop the server already closed.
    const h = harness();
    await enqueueStop(h, 41, 'arrived');
    await enqueueStop(h, 41, 'done');
    await enqueueStop(h, 42, 'arrived');

    await h.outbox.drain();

    expect(h.sent.map((w) => `${w.path}:${(w.body as any).status}`)).toEqual([
      `/api/dispatch/stops/41/status:arrived`,
      `/api/dispatch/stops/41/status:done`,
      `/api/dispatch/stops/42/status:arrived`,
    ]);
  });

  it('drains an empty queue without sending anything', async () => {
    const h = harness();
    await expect(h.outbox.drain()).resolves.toBe('empty');
    expect(h.sent).toHaveLength(0);
  });

  it('drops a write the server refused on its facts, and never retries it', async () => {
    // DRV-14. A 409 is not the server being busy; it is the server disagreeing. Retrying
    // cannot change the answer, and leaving the write in place jams everything behind it.
    // So the device loses, the write goes, and the UI is told to look at the day again.
    const h = harness(() => 409);
    await enqueueStop(h, 41, 'done');

    await h.outbox.drain();

    expect(h.sent).toHaveLength(1);
    expect(h.store.rows).toHaveLength(0);
    expect(h.refused).toHaveLength(1);
  });

  it('keeps a pump-out when the login went stale, rather than deleting it', async () => {
    // The opposite handling of the same-looking problem. A tablet left in a yard over the
    // weekend comes back with an expired token; dropping the queue there would destroy the
    // only record of work somebody actually did.
    let status = 401;
    const h = harness(() => status);
    await enqueueStop(h, 41, 'done');

    await expect(h.outbox.drain()).resolves.toBe('parked-auth');
    expect(h.store.rows).toHaveLength(1);
    expect(h.outbox.isParked).toBe(true);
    expect(h.authLost).toHaveLength(1);

    // Sign in again and the same write — not a new one — goes out.
    status = 200;
    await expect(h.outbox.drain()).resolves.toBe('drained');
    expect(h.outbox.isParked).toBe(false);
    expect(h.store.rows).toHaveLength(0);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[0].client_uuid).toBe(h.sent[1].client_uuid);
  });

  it('stops the pass at the first dead radio and records why the write is still here', async () => {
    // Sequential timeouts on a phone with two bars and 8% battery is its own failure mode.
    const h = harness((w, call) => (call === 1 ? new Error('Failed to fetch') : 200));
    await enqueueStop(h, 41, 'arrived');
    await enqueueStop(h, 42, 'arrived');

    await expect(h.outbox.drain()).resolves.toBe('kept-trying');

    expect(h.sent).toHaveLength(1);
    expect(h.store.rows).toHaveLength(2);
    const stuck = h.store.rows.find((r) => r.path.includes('/41/'));
    expect(stuck?.attempts).toBe(1);
    expect(stuck?.last_error).toBe('Failed to fetch');
  });

  it('keeps a write the server could not answer but carries on with the rest', async () => {
    // 503 is not a dead radio — the connection works and the app is talking to something.
    // Stopping the whole pass over one bad response would hold up unrelated stops.
    const h = harness((w) => (w.path.includes('/41/') ? 503 : 200));
    await enqueueStop(h, 41, 'arrived');
    await enqueueStop(h, 42, 'arrived');

    await h.outbox.drain();

    expect(h.store.rows).toHaveLength(1);
    expect(h.store.rows[0].path).toContain('/41/');
    expect(h.store.rows[0].last_error).toBe('HTTP 503');
  });

  it('re-sends the same uuid when the delete after an accepted send fails', async () => {
    // The crash window: the server has the write, the device has not forgotten it. Delete-
    // after-acknowledge means the worst case is a duplicate request that the server answers
    // with the original row — never a lost one.
    const h = harness();
    await enqueueStop(h, 41, 'done');
    h.store.failNextRemove = true;

    await expect(h.outbox.drain()).resolves.toBe('kept-trying');
    expect(h.store.rows).toHaveLength(1);

    await h.outbox.drain();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[0].client_uuid).toBe(h.sent[1].client_uuid);
    expect(h.store.rows).toHaveLength(0);
  });

  it('keeps two taps on one stop as two writes instead of merging them', async () => {
    // DRV-14 says no merge logic exists, and this is exactly where it would be tempted to
    // appear. The device does not reconcile `arrived` and `done` into one request; it sends
    // both in order and lets the server's transition machine decide what is still true.
    const h = harness();
    await enqueueStop(h, 41, 'arrived');
    await enqueueStop(h, 41, 'done');

    await h.outbox.drain();

    expect(h.sent).toHaveLength(2);
    expect(h.sent[0].client_uuid).not.toBe(h.sent[1].client_uuid);
  });

  it('does not run two drains at once', async () => {
    // `online` fires on more than the moment the antenna comes back, and a second drain
    // racing the first would send everything twice. Wasteful, and only harmless *because*
    // the uuid holds — which is not a reason to rely on it.
    const store = new MemoryStore();
    let inFlight = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });

    const outbox = new Outbox({
      store,
      newUuid: () => '00000000-0000-4000-8000-000001',
      now: () => 1,
      send: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await gate;
        inFlight -= 1;
        return { status: 200 };
      },
    });
    await outbox.enqueue({ method: 'PATCH', path: '/api/dispatch/stops/41/status', body: {} });

    const first = outbox.drain();
    const second = outbox.drain();
    release();
    await Promise.all([first, second]);

    expect(peak).toBe(1);
    expect(store.rows).toHaveLength(0);
  });

  it('builds a stop write that claims nothing the server owns', () => {
    // DRV-08 and DRV-06 together: a device that sends its own clock or its own date is the
    // bug the server was built to refuse, and a queued write carrying one is guaranteed to
    // fail at exactly the moment the driver finally has signal.
    const w = stopStatusWrite(41, {
      status: 'done', gallons_pumped: 350, disposal_site_id: 106,
    });

    expect(w.method).toBe('PATCH');
    expect(w.path).toBe('/api/dispatch/stops/41/status');
    expect(w.body.status).toBe('done');
    expect(w.body.gallons_pumped).toBe(350);
    // The server refuses a `done` that does not name where the waste went,
    // and refused-on-facts writes are dropped — the site has to ride inside
    // the queued body, not arrive as a second request that can fail alone.
    expect(w.body.disposal_site_id).toBe(106);
    for (const field of SERVER_OWNED_FIELDS) {
      expect(w.body).not.toHaveProperty(field);
    }
    // Deliberate, and the reason is on `stopStatusWrite`: a queued write is a late write,
    // and pinning a version would throw away real work because the office re-ordered a day.
    expect(w.body).not.toHaveProperty('version');
  });
});

describe('T-DRV-12: reading a verdict out of a status code', () => {
  /**
   * The drain loop used to decide this with three `if`s in a row, and a mutation that moved
   * the auth check below the refused check passed every test in this file while quietly
   * deleting a driver's work whenever a token expired. These cases exist so that answer has
   * to be said out loud, once, rather than implied by the order of some code.
   */
  const cases: Array<[number, Verdict]> = [
    [200, 'sent'],
    [201, 'sent'],
    [204, 'sent'],
    [400, 'refused'],
    [404, 'refused'],
    [409, 'refused'],
    [401, 'auth'],
    [403, 'auth'],
    [500, 'retry'],
    [502, 'retry'],
    [503, 'retry'],
    [0, 'retry'],
  ];

  it.each(cases)('classifies %i as %s', (status, expected) => {
    expect(classify(status)).toBe(expected);
  });

  it('never puts a status in both the retry-forever bucket and the throw-it-away bucket', () => {
    // The one assertion that makes the order inside `classify` irrelevant. If 401 ever lands
    // in REFUSED_STATUSES, the two branches disagree about an expired login and this fails
    // here instead of in a ledger that is missing a pump-out.
    const overlap = AUTH_STATUSES.filter((s) => REFUSED_STATUSES.indexOf(s) !== -1);
    expect(overlap).toEqual([]);
  });
});
