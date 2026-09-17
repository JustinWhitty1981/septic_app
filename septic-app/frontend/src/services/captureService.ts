import axios from 'axios';

const API_BASE = '/api';

/**
 * Field capture from the browser: notes and photos.
 *
 * Notes queue through the offline outbox like stop status taps (see
 * `offline/dispatchQueue`); this service is the *transport* one enqueue
 * eventually calls, plus the photo path, which today goes straight out.
 *
 * Photos are deliberately not queued yet: the outbox stores JSON, a captured
 * photo is megabytes, and a queue that silently drops when IndexedDB fills is
 * worse than an upload that says "no signal — try again". When photos get an
 * offline queue it will be a blob store with its own eviction rule, and the
 * sha256 dedup server-side (DRV-18) is already built so that a re-send after
 * a crash cannot duplicate.
 *
 * The upload is base64-in-JSON on purpose: one request, one retry, and the
 * server's 16 MB parser on this route alone — every other endpoint keeps the
 * 100 KB body ceiling.
 */

export interface NoteRow {
  id: number;
  client_uuid: string | null;
  author_id: number;
  body: string;
  client_created_at: string;
  created_at: string;
}

export interface UploadResult {
  id: number;
  sha256: string;
  byte_size: number;
  width: number;
  height: number;
  deduplicated?: boolean;
  url: string;
}

export function messageOfCapture(err: unknown): string {
  const e = err as { response?: { data?: { error?: string; message?: string } } };
  return e?.response?.data?.error || e?.response?.data?.message
    || (err instanceof Error ? err.message : 'Upload failed');
}

/**
 * Blob -> bytes. `Blob.arrayBuffer()` is the fast path everywhere modern;
 * the FileReader fallback exists for jsdom, whose Blob predates the method —
 * and for the (older) browser on a field phone, which is the actual audience.
 */
async function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof (blob as { arrayBuffer?: unknown }).arrayBuffer === 'function') {
    return new Uint8Array(await blob.arrayBuffer());
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * Blob -> base64. Chunked because `String.fromCharCode(...bytes)` on a 3 MB
 * photo overflows the argument stack; 0x8000 is the safe chunk size.
 */
function toBase64(bytes: Uint8Array): string {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

/** A captured photo -> the upload endpoint. `file` is a File or Blob. */
export async function uploadPhoto(file: Blob, meta: {
  route_stop_id?: number; service_event_id?: number; property_id?: number;
  caption?: string; client_uuid?: string;
}): Promise<UploadResult> {
  const bytes = await blobBytes(file);
  const res = await axios.post<UploadResult>(`${API_BASE}/media/upload`, {
    image_base64: toBase64(bytes), ...meta,
  }, { timeout: 60_000 });
  return res.data;
}

export const noteService = {
  /** The server answers a retry with the first row and `replay: true` (DRV-13). */
  create: async (body: {
    body: string; route_stop_id?: number; service_event_id?: number;
    property_id?: number; client_uuid?: string; client_created_at?: string;
  }): Promise<NoteRow & { replay?: boolean }> => {
    const res = await axios.post<NoteRow & { replay?: boolean }>(`${API_BASE}/notes`, body);
    return res.data;
  },

  list: async (query: { route_stop_id?: number; service_event_id?: number; property_id?: number })
    : Promise<NoteRow[]> => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v != null) q.set(k, String(v));
    const res = await axios.get<NoteRow[]>(`${API_BASE}/notes?${q.toString()}`);
    return res.data;
  },
};
