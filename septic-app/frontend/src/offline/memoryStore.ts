/**
 * A queue that lives for as long as the tab does.
 *
 * Not a test double that happens to ship. `IdbStore` is unavailable in private browsing on
 * iOS, in some hardened enterprise webviews, and on any browser that refused the origin
 * storage access — and in every one of those the driver still has to be able to record a
 * pump-out. Losing the write because the *durable* store was missing would be the app
 * failing at the thing it exists to do, so it degrades to this instead, and `capabilities.ts`
 * says so on the screen: work is kept, but only until the tab closes.
 *
 * It is also what the tests run against, for the mundane reason that jsdom has no IndexedDB.
 * Sharing the real fallback rather than keeping a second fake means the code under test is
 * the code that runs when a phone refuses to store anything.
 */

import { OutboxStore, QueuedWrite } from './outbox';

export class MemoryStore implements OutboxStore {
  /** Exposed for tests and for the debug screen; nothing in the send path reads it. */
  rows: QueuedWrite[] = [];

  /** Makes the next `remove` fail once, to exercise the crash window. */
  failNextRemove = false;

  async list(): Promise<QueuedWrite[]> {
    return this.rows.map((r) => ({ ...r })).sort((a, b) => a.enqueued_at - b.enqueued_at);
  }

  async add(w: QueuedWrite): Promise<void> {
    this.rows = this.rows.filter((r) => r.id !== w.id).concat({ ...w });
  }

  async update(w: QueuedWrite): Promise<void> {
    return this.add(w);
  }

  async remove(id: string): Promise<void> {
    if (this.failNextRemove) {
      this.failNextRemove = false;
      throw new Error('QuotaExceededError');
    }
    this.rows = this.rows.filter((r) => r.id !== id);
  }
}

/**
 * The store to use on this device, chosen once.
 *
 * Probing with `typeof indexedDB` rather than trying to open and catching: a browser that
 * blocks storage can hang or throw at open time in ways that differ per vendor, and the
 * queue should not spend a driver's first tap finding out.
 */
export function chooseStore(): OutboxStore {
  const hasIdb = typeof indexedDB !== 'undefined' && indexedDB !== null;
  return hasIdb ? new IdbStoreLazy() : new MemoryStore();
}

/**
 * Deferred so that merely importing this module — which the tests do — does not touch
 * `indexedDB` in an environment where constructing the real store would fail on import.
 */
class IdbStoreLazy implements OutboxStore {
  private inner: OutboxStore | null = null;

  private async target(): Promise<OutboxStore> {
    if (!this.inner) {
      const mod = await import('./idbStore');
      this.inner = new mod.IdbStore();
    }
    return this.inner;
  }

  async list(): Promise<QueuedWrite[]> { return (await this.target()).list(); }
  async add(w: QueuedWrite): Promise<void> { return (await this.target()).add(w); }
  async update(w: QueuedWrite): Promise<void> { return (await this.target()).update(w); }
  async remove(id: string): Promise<void> { return (await this.target()).remove(id); }
}
