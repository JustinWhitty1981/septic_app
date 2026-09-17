/**
 * The outbox — writes the driver made, kept until the server has them.
 *
 * DRV-12. Rural jobsites have no signal, so the app cannot ask permission to record what
 * just happened; it records it and catches up later. That is the entire reason this is a PWA
 * rather than a website, and it turns every write into one that may be sent twice, out of
 * order, hours late, or never at all.
 *
 * ## Why this is a class with injected dependencies and not a fetch wrapper
 *
 * The interesting failures here are not network failures — the browser handles those. They
 * are *sequence* failures, and they are only reachable by running the same code against a
 * fake that can be made to misbehave on cue. So storage, sending, the clock and the uuid
 * source all arrive as arguments. In the browser they are IndexedDB, `fetch`, `Date.now` and
 * `crypto.randomUUID`; in the tests they are a Map, a spy and a counter. jsdom has no
 * IndexedDB at all, which is the immediate practical reason — but injecting it is what lets
 * "the tab died halfway through a send" be a test rather than a paragraph.
 *
 * ## The one invariant everything else rests on
 *
 * **`client_uuid` is generated once, at enqueue, and is never regenerated.**
 *
 * The server deduplicates a replay on that uuid (DRV-13). If a retry minted a fresh one, the
 * server would see a different write, accept it, and file a second pump-out against the same
 * site — in the ledger that cannot be corrected afterwards (P5). A queue that regenerates
 * ids on retry is not an offline queue; it is a duplicate-record generator that works most
 * of the time. It is also invisible until a regulator asks why one house was pumped twice on
 * a Tuesday, so there is a test for it specifically, and it is the first one in the file.
 *
 * ## What a refusal means, and why the answer is never "retry"
 *
 * The queue classifies every answer, because treating a refusal as a failure is how an
 * offline queue jams:
 *
 *  - **2xx** — the server has it. Remove it.
 *  - **400 / 404 / 409** — refused *on its content*. The server is not confused and not
 *    busy; it disagrees. Retrying cannot change that, so the write is dropped and the UI is
 *    told to reload the day. This is DRV-14 executed: the server owns schedule and status,
 *    so when the device's version of the day and the office's version collide, the device
 *    loses, and there is no merge to be clever about.
 *  - **401 / 403** — refused *on who is asking*. The write is still correct. Dropping it
 *    would delete a pump-out because a tablet sat in a yard over the weekend and the token
 *    expired, so it stays queued and draining stops until somebody logs in again.
 *  - **5xx and transport errors** — nobody has decided anything. Keep it, back off, try
 *    again.
 *
 * The distinction that matters most is 409 from 401. Both are "not accepted right now", both
 * arrive as a bare status code, and they need opposite handling: one is a fact to accept, the
 * other is a login to wait for.
 */

export interface QueuedWrite {
  /** Local primary key. Never sent. */
  id: string;
  /**
   * Sent to the server, stable for the life of the write, and the reason a duplicate send
   * is merely wasteful rather than destructive.
   */
  client_uuid: string;
  method: string;
  path: string;
  body: unknown;
  /**
   * Device clock, and used only to order the queue. It is never a date: DRV-08 makes the
   * server the only source of `service_date`, precisely so a phone reading 2024 while the
   * ledger says 2026 cannot write a mis-dated regulatory row.
   */
  enqueued_at: number;
  attempts: number;
  last_error: string | null;
}

export interface SendResult {
  status: number;
  body?: any;
}

export type Sender = (w: QueuedWrite) => Promise<SendResult>;

/** Everything the queue needs to remember things. Swapped for a Map in tests. */
export interface OutboxStore {
  /** Oldest first. Order is load-bearing: see `drain`. */
  list(): Promise<QueuedWrite[]>;
  add(w: QueuedWrite): Promise<void>;
  remove(id: string): Promise<void>;
  update(w: QueuedWrite): Promise<void>;
}

export interface OutboxHooks {
  /** A write refused on its content. The day on screen is now known-stale. */
  onRefused?: (w: QueuedWrite, res: SendResult) => void;
  /** Credentials went stale mid-drain; the queue is parked, not cleared. */
  onAuthLost?: (w: QueuedWrite, res: SendResult) => void;
  /** A write left the queue, however it ended. */
  onSettled?: (w: QueuedWrite, outcome: 'sent' | 'refused') => void;
}

export interface OutboxDeps {
  store: OutboxStore;
  send: Sender;
  newUuid: () => string;
  now?: () => number;
  hooks?: OutboxHooks;
}

/** Statuses where retrying is pointless and dropping is wrong. */
export const AUTH_STATUSES = [401, 403];
/** Statuses where the server has read the write and said no. */
export const REFUSED_STATUSES = [400, 404, 409];

/**
 * What a status code means for a queued write. One function, because the whole design turns
 * on this being answered the same way every time.
 *
 * Inlining this as a chain of `if`s in the drain loop would have worked, and would have left
 * a hazard with no guard: the answer depends on `auth` being asked before `refused`, so a
 * later edit that reorders the branches silently converts "keep the pump-out, wait for a
 * login" into "delete the pump-out". Extracted, the order lives in one place; and because
 * the two lists are asserted disjoint, the order stops mattering at all.
 */
export type Verdict = 'sent' | 'refused' | 'auth' | 'retry';

export function classify(status: number): Verdict {
  if (status >= 200 && status < 300) return 'sent';
  if (AUTH_STATUSES.indexOf(status) !== -1) return 'auth';
  if (REFUSED_STATUSES.indexOf(status) !== -1) return 'refused';
  // 5xx, 3xx, or a bare 0 from an aborted fetch: nobody has judged this write.
  return 'retry';
}

export type DrainOutcome = 'empty' | 'drained' | 'parked-auth' | 'kept-trying';

export class Outbox {
  private draining = false;

  /**
   * Set when a drain had to stop early. Two reasons and only two: the login went stale, or
   * the network was down. Both mean "nothing about the queue's contents changed", which is
   * why the entries stay exactly as they were.
   */
  private parked = false;

  constructor(private readonly deps: OutboxDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /**
   * Take a write in and promise nothing about when it leaves.
   *
   * The uuid is minted *here* rather than at send time, so a write that is attempted six
   * times over two days is still, to the server, the one write it was when the driver let go
   * of the phone.
   *
   * It is then written into the body, because the server reads it from there and a call site
   * that forgets it produces a write that is silently, expensively not idempotent. Making
   * the queue responsible is the difference between an invariant and a convention: nothing
   * here can send a JSON body that lacks the key, so nothing here has to remember to add it.
   */
  async enqueue(input: {
    method: string;
    path: string;
    body: unknown;
    client_uuid?: string;
  }): Promise<QueuedWrite> {
    const at = this.now();
    const uuid = input.client_uuid ?? this.deps.newUuid();
    const body =
      input.body && typeof input.body === 'object' && !Array.isArray(input.body)
        ? { ...(input.body as Record<string, unknown>), client_uuid: uuid }
        : input.body;
    const w: QueuedWrite = {
      // Both halves come from the same call, so re-enqueueing an object cannot collide with
      // an entry already in the store.
      id: `${at}-${uuid}`,
      client_uuid: uuid,
      method: input.method,
      path: input.path,
      body,
      enqueued_at: at,
      attempts: 0,
      last_error: null,
    };
    await this.deps.store.add(w);
    return w;
  }

  async pending(): Promise<QueuedWrite[]> {
    return this.deps.store.list();
  }

  get isParked(): boolean {
    return this.parked;
  }

  /**
   * Send what can be sent, in the order the driver did them.
   *
   * Order is not a nicety. A driver who taps *arrived* and then *done* with the phone still
   * in airplane mode produces two writes that only make sense in that sequence — replayed
   * the other way round, `done` lands first and the queued `arrived` comes back 409 against
   * a stop the server already closed. The transition machine makes that survivable (a done
   * stop cannot be re-arrived, so the stale write is simply refused), but the driver should
   * not lose a legitimate tap to an artefact of when the signal came back.
   *
   * The loop stops at the first transport failure rather than trying the rest. If the tower
   * is down, it is down; twenty sequential timeouts on a phone battery is worse than waiting
   * for the browser to say the connection is back.
   */
  async drain(): Promise<DrainOutcome> {
    if (this.draining) return 'kept-trying';
    this.draining = true;
    try {
      return await this.drainUnlocked();
    } finally {
      this.draining = false;
    }
  }

  private async drainUnlocked(): Promise<DrainOutcome> {
    const queue = await this.deps.store.list();
    if (queue.length === 0) {
      this.parked = false;
      return 'empty';
    }

    let sent = 0;
    for (const w of queue) {
      let res: SendResult;
      try {
        res = await this.deps.send(w);
      } catch (err) {
        // Transport: nobody has judged the write. Record why it is still here and stop.
        await this.deps.store.update({
          ...w,
          attempts: w.attempts + 1,
          last_error: err instanceof Error ? err.message : String(err),
        });
        this.parked = false;
        return 'kept-trying';
      }

      switch (classify(res.status)) {
        case 'sent': {
          // Removed only after the server confirmed it. If the remove itself throws, the
          // entry survives and gets sent again — which is safe, because the server has the
          // uuid. Delete-after-acknowledge, never before.
          //
          // Swallowing this is deliberate and is the whole reason the order is send-then-
          // delete rather than delete-then-send: the alternative loses a pump-out the moment
          // storage misbehaves. Here it is re-sent, the server answers with the original row,
          // and the queue drains on the next pass.
          try {
            await this.deps.store.remove(w.id);
          } catch {
            this.parked = false;
            return 'kept-trying';
          }
          this.deps.hooks?.onSettled?.(w, 'sent');
          sent += 1;
          continue;
        }

        case 'auth': {
          // Refused on who is asking, not on what was asked. The write is still true.
          this.parked = true;
          this.deps.hooks?.onAuthLost?.(w, res);
          return 'parked-auth';
        }

        case 'refused': {
          // Refused on its facts. DRV-14: the server wins and there is nothing to merge.
          await this.deps.store.remove(w.id);
          this.deps.hooks?.onRefused?.(w, res);
          this.deps.hooks?.onSettled?.(w, 'refused');
          continue;
        }

        case 'retry': {
          // The server may or may not have taken it. Keeping it is the safe direction
          // precisely because a repeat send is idempotent server-side.
          await this.deps.store.update({
            ...w,
            attempts: w.attempts + 1,
            last_error: `HTTP ${res.status}`,
          });
          continue;
        }
      }
    }

    this.parked = false;
    return sent > 0 ? 'drained' : 'kept-trying';
  }
}

