/**
 * Puts the offline layer in the page, once.
 *
 * Two halves meet here: the outbox (which remembers writes) and the service worker (which
 * remembers the app). Both are singletons with the same lifetime as the tab, and neither is
 * something a component should own — a queue that is rebuilt on re-render is a queue that
 * forgets, and the whole point is that it must not.
 */

import { Outbox, QueuedWrite } from './outbox';
import { chooseStore } from './memoryStore';
import { makeFetchSender } from './dispatchQueue';
import authService from '../services/authService';

/**
 * A v4 uuid, from whichever source this browser will give us.
 *
 * The fallback is not decoration. `crypto.randomUUID` exists only in secure contexts, so a
 * tablet pointed at the dev server over a LAN address — `http://192.168.1.12:3000`, which is
 * exactly how somebody tests this on a real phone — has no `randomUUID` at all. Without the
 * branch below, every enqueue on that device throws, and the failure looks like the offline
 * queue being broken rather than like the page not being served over HTTPS.
 */
/** Exported for DRV-20: a record filed from a phone over http:// needs the
 * same secure-context-safe mint the queue uses. */
export function newUuid(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

let outbox: Outbox | null = null;

/**
 * Everything a screen needs to show the truth about unsent work.
 *
 * A count alone is not enough. The card has to say *which* stop is sitting on a queued
 * `done`, and a driver who is told "2 unsent" cannot tell whether the stop in front of them
 * is one of them — which is the difference between tapping again and driving on.
 */
export interface QueueSnapshot {
  pending: QueuedWrite[];
  /** Writes the server refused on their facts, with the server's own reason. */
  refused: Array<{ path: string; message: string }>;
  /** Draining stopped because the session went stale. The writes are untouched. */
  parked: boolean;
}

const EMPTY: QueueSnapshot = { pending: [], refused: [], parked: false };

let last: QueueSnapshot = EMPTY;
const listeners = new Set<(s: QueueSnapshot) => void>();
const refused: Array<{ path: string; message: string }> = [];

function notify(): void {
  listeners.forEach((fn) => fn(last));
}

/** Re-read the queue and tell everybody. Cheap: the queue is a handful of rows. */
async function refresh(): Promise<void> {
  const box = getOutbox();
  last = {
    pending: await box.pending(),
    refused: refused.slice(),
    parked: box.isParked,
  };
  notify();
}

/** Lets a screen subscribe to the queue without owning it. */
export function onQueueChange(fn: (s: QueueSnapshot) => void): () => void {
  listeners.add(fn);
  // Hand the new subscriber what is already known, or a screen that mounts after the last
  // drain renders an empty badge until something else happens to move the queue.
  fn(last);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * The one queue this tab has.
 *
 * The token is read at send time through a closure rather than captured here, because the
 * person who logs in is not necessarily the person whose writes are in the queue, and the
 * session that works on Wednesday is not the one that worked on Monday.
 */
export function getOutbox(): Outbox {
  if (!outbox) {
    outbox = new Outbox({
      store: chooseStore(),
      send: makeFetchSender(() => authService.getToken()),
      newUuid,
      hooks: {
        onSettled: () => { void refresh(); },
        // The server's sentence is the useful half. "A done stop cannot be marked arrived"
        // is worth more to a driver than an icon, and it is the only version of that message
        // that will ever be seen on a jobsite, so it is kept rather than reduced to a flag.
        onRefused: (w, res) => {
          const body = res.body as { message?: string } | undefined;
          refused.push({ path: w.path, message: body?.message || `Rejected (${res.status})` });
        },
        onAuthLost: () => { /* parked is read from the box on refresh */ },
      },
    });
  }
  return outbox;
}

/**
 * Re-read and broadcast.
 *
 * Exported because a screen that just took a tap must not announce it to itself. `record`
 * used to set its own state and stop, which made the card change and left the header badge
 * showing nothing — two numbers on one screen disagreeing about the same queue, in front of
 * the only person who cannot afford to work out which one is lying.
 */
export async function refreshQueue(): Promise<void> {
  await refresh();
}

/** Clear the refusal list once the screen has acted on it. */
export function dismissRefused(): void {
  refused.length = 0;
  void refresh();
}

/**
 * Start it. Safe to call more than once, and safe in a browser that will not register the
 * worker — the queue still works, it just does not survive the tab.
 */
export function startOffline(): void {
  const box = getOutbox();

  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
      void box.drain().then(refresh);
    });
    // Deliberately not on `offline`: there is nothing to send, and draining into a dead
    // radio is how a queue turns a working phone into a hot one.
    void refresh();
  }

  // The shell cache and the dev server do not mix, and this line is the only
  // cure. CRA's dev bundle has a fixed filename (no hashes in development),
  // and `sw.js` answers the shell cache-first — so every dev reload, hard or
  // not, hands the browser yesterday's bundle until the network copy arrives
  // a request too late. The visible symptom is a screen stuck on an old
  // build that no amount of refreshing fixes. Development machines have
  // network by definition; the offline path this worker exists for is
  // verified against production builds (and in jsdom). Phones that
  // registered the worker during dev need it unregistered once —
  // DevTools → Application → Service workers — after this lands.
  if (process.env.NODE_ENV === 'development') return;

  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  navigator.serviceWorker
    .register('/sw.js')
    .then((reg) => {
      // Drain on a fresh worker too: a deploy that lands while the driver is in range is a
      // good moment to catch up, and the page is about to reload anyway.
      reg.addEventListener('activate', () => {
        void box.drain().then(refresh);
      });
    })
    .catch(() => {
      // Not silence. `capabilities.ts` reads the same absence and puts it on the screen,
      // because the usual cause here is that the app is served over http:// to a phone on
      // the VPN, and a driver would have no way to find that out from a rejected promise.
      void refresh();
    });
}
