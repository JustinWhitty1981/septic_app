/**
 * The browser's half of the outbox: IndexedDB, because the queue has to outlive the tab.
 *
 * The reason this is not a `localStorage` array is the one that decides DRV-12 on its own.
 * A driver with no signal closes the phone, puts it in a pocket, and drives forty minutes to
 * the next site. Whatever the app remembered has to still be there when it opens again —
 * and a mobile browser under memory pressure evicts `localStorage` freely, whereas IndexedDB
 * is only cleared on an explicit user action or a quota event. A queue that can be silently
 * thrown away by the operating system is not a queue; it is a suggestion.
 *
 * ## What is deliberately not here
 *
 * Photos. A base64 image in this store would be the largest thing in it by orders of
 * magnitude, and DRV-12's "photos queue locally" is only half honoured: the upload endpoint
 * shipped since (`POST /api/media/upload`), but `captureService` posts to it directly.
 * Queueing that path wants its own blob store keyed by the same `client_uuid`, not a wider
 * row here — and a re-audit against the 16 MB parser, not just a route through this queue.
 *
 * ## One thing the schema cannot express and the code must not pretend otherwise
 *
 * Logging out does not clear this store, and must not. The writes in it are work a person
 * actually did, and wiping them because somebody tapped *sign out* would destroy the only
 * record of a pump-out that the county still needs (P5). The cost is a sharp edge worth
 * naming: if a second driver signs in on the same tablet, the first driver's queued stops
 * replay under the wrong token, come back 404 — the server cannot say "not yours" without
 * confirming the stop exists — and are dropped as refused. That is survivable and it is loud
 * (`onRefused` fires per write), but it is not *good*, and the fix belongs with a per-user
 * queue partition, not with a clear-on-logout that loses data.
 */

import { OutboxStore, QueuedWrite } from './outbox';

const DB_NAME = 'septic-outbox';
const DB_VERSION = 1;
const STORE = 'writes';
const BY_TIME = 'by_enqueued_at';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      // No `keyPath` autoIncrement: `id` is minted by the outbox so that a crash between
      // minting and storing cannot leave a hole that a later retry mistakes for its own.
      const store = db.createObjectStore(STORE, { keyPath: 'id' });
      // The queue is always read oldest-first, so the order lives in an index rather than
      // in whatever order `list()` happens to return.
      store.createIndex(BY_TIME, 'enqueued_at', { unique: false });
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** IndexedDB's callback API, once, so the rest of the file can be awaited. */
function run<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class IdbStore implements OutboxStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private db(): Promise<IDBDatabase> {
    if (!this.dbPromise) this.dbPromise = open();
    return this.dbPromise;
  }

  async list(): Promise<QueuedWrite[]> {
    const db = await this.db();
    const tx = db.transaction(STORE, 'readonly');
    const index = tx.objectStore(STORE).index(BY_TIME);
    const out: QueuedWrite[] = [];

    return new Promise((resolve, reject) => {
      // A cursor over the index, rather than getAll() then sort(): the store is small in
      // normal use, but ordering by an index is what makes "oldest first" a property of the
      // database instead of a habit of the caller.
      //
      // Errors are read off the request and the transaction, not the index — `IDBIndex` has
      // no error event of its own, which is the kind of thing the types catch for you.
      const req = index.openCursor();
      req.onsuccess = (e) => {
        const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
        if (!cursor) return resolve(out);
        out.push(cursor.value as QueuedWrite);
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async add(w: QueuedWrite): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(w);
    await new Promise<void>((resolve, reject) => {
      // Awaiting the *transaction*, not the put request. A request can report success while
      // the transaction still aborts — a queue that lies about having saved something is
      // worse than one that refuses.
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  }

  async update(w: QueuedWrite): Promise<void> {
    return this.add(w);
  }

  async remove(id: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  }

  /** Exposed for the debug screen; nothing in the send path should ever call it. */
  async clear(): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    await run(tx.objectStore(STORE).count());
  }
}
