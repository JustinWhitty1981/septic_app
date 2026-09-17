import axios from 'axios';

const API_BASE = '/api';

/**
 * The invoice book, as the office sees it: read, create, and one correction.
 *
 * Creation (BIL-20) arrived when the office said what the price book was
 * actually for: not a number the screen could guess, but a list a human
 * points at, line by line, next to the work. `create` therefore sends
 * references, quantities and unit prices — never totals. Every amount on an
 * invoice is computed server-side (BIL-04); what the browser believes about
 * arithmetic is not an input to anything.
 *
 * `adjust` is the correction door (BIL-05): the original is never edited,
 * and the adjustment names it. The dialog that calls this shows the
 * original's lines next to the form for exactly that reason.
 */

export interface InvoiceRow {
  id: number;
  legacy_invoice_no: number | null;
  invoice_date: string;
  kind: 'invoice' | 'credit' | 'adjustment';
  status: string;
  subtotal: string;
  tax_amount: string;
  total: string;
  amount_paid: string;
  payer_name: string | null;
  adjusted_by: number | null;
  /** Server-computed: what the account truly owes after every correction in the
   *  chain — NOT `total − amount_paid`, which is the header alone and calls a
   *  discounted-and-paid invoice a $20 debt. 0 for a correction document (it is a
   *  document, not a collectible). */
  balance?: number;
}

export interface NewInvoice {
  id: number; payer_id: number; property_id: number | null;
  payer_name: string | null; invoice_date: string;
  subtotal: string; tax_rate: string; tax_amount: string; total: string;
  status: string;
}

export interface InvoiceLine {
  id: number;
  service_event_id: string | null;
  legacy_product_code: string | null;
  service_type_id: number | null;
  description: string | null;
  quantity: string;
  unit_price: string;
  amount: string;
  /** BIL-16: whether the rate reached this line. Absent on legacy rows that
   * predate 0034; the server treats a line as taxable unless it says false. */
  taxable?: boolean;
}

export interface PaymentRow {
  id: number;
  amount: string;
  method: string;
  note: string | null;
  reference: string | null;
  paid_at: string | null;
  /** NULL on the 3,199 legacy rows: they arrived before there were logins. */
  received_by: string | null;
}

export interface InvoiceDetail extends InvoiceRow {
  payer_id: number;
  property_id: number | null;
  adjusts_invoice_id: number | null;
  /** Netted across the correction chain: what is truly owed (BIL-07). Never a
   *  raw `total − amount_paid`, which calls a discounted-and-paid bill a debt. */
  balance: number;
  // Present only on the detail endpoint (the print view needs one document,
  // one request).
  mailing_address?: string | null;
  mailing_city?: string | null;
  mailing_state?: string | null;
  mailing_zip?: string | null;
  site_address?: string | null;
  site_city?: string | null;
  lines: InvoiceLine[];
  payments: PaymentRow[];
  /** The correction chain this document belongs to (BIL-05): the original and every
   * adjustment that answered it, oldest first — the complaint-grade history. */
  history?: AdjustmentEntry[];
  /** BIL-05 × BIL-08: the head of this chain folded into the ONE paper the office
   * can mail — the bill's own lines, then each correction as its own signed line,
   * netted to the balance the customer truly owes. Server-computed (BIL-07); the
   * print view renders these numbers and adds none of its own. */
  statement?: InvoiceStatement;
}

/** One correction inside a consolidated statement: its own signed lines plus the
 * reason that justified it, so the mailed document shows the correction and why. */
export interface StatementAdjustment {
  id: number;
  invoice_date: string;
  kind: 'invoice' | 'credit' | 'adjustment';
  adjust_reason: string | null;
  total: string;
  lines: InvoiceLine[];
}

/** One reconciling line the server computed for the printed statement: a
 *  correction (naming the document it was filed under) or a receipt, with the
 *  running balance already summed (BIL-07 — the paper adds up in front of the
 *  customer, so the browser adds none of it). */
export interface StatementLedgerEntry {
  kind: 'adjustment' | 'payment';
  id: number;
  date: string | null;
  ref: string | null;
  label: string;
  amount: string;
  running: string;
}

export interface InvoiceStatement {
  invoice_id: number;
  display_number: string;
  subtotal: string;
  tax_amount: string;
  total: string;
  amount_paid: string;
  /** Netted across the whole correction chain — what is truly owed, not the
   *  header's `total − amount_paid`. */
  balance_due: string;
  /** The head bill's own lines, as issued. */
  lines: InvoiceLine[];
  /** The payments-and-adjustments ledger that draws the total down to
   *  `balance_due`. Server-computed; printed, never recalculated. */
  ledger: StatementLedgerEntry[];
  adjustments: StatementAdjustment[];
}

export interface Meta {
  total: number; page: number; limit: number;
  sort?: string; dir?: 'asc' | 'desc';
}

/** One document in an invoice's correction chain (BIL-05) — the original and each
 * adjustment that answered it, so a complaint can be read as a timeline. The who is
 * the author the login recorded (null on the legacy rows); the why is the reason an
 * adjustment had to carry. */
export interface AdjustmentEntry {
  id: number;
  legacy_invoice_no: number | null;
  kind: 'invoice' | 'credit' | 'adjustment';
  invoice_date: string;
  status: string;
  subtotal: string;
  tax_amount: string;
  total: string;
  amount_paid: string;
  adjusts_invoice_id: number | null;
  adjust_reason: string | null;
  created_by: number | null;
  created_by_name: string | null;
  created_on: string | null;
}

interface Envelope<T> { success: boolean; data: T; meta?: Meta }

/** The server's own words, surfaced from an axios failure. */
export function messageOf(err: unknown): string {
  const e = err as { response?: { data?: { error?: string; message?: string } } };
  return e?.response?.data?.error || e?.response?.data?.message
    || (err instanceof Error ? err.message : 'Request failed');
}

async function call<T>(path: string, method: 'get' | 'post' = 'get', body?: unknown)
  : Promise<{ data: T; meta?: Meta }> {
  const res = method === 'get'
    ? await axios.get<Envelope<T>>(`${API_BASE}${path}`)
    : await axios.post<Envelope<T>>(`${API_BASE}${path}`, body);
  if (!res.data.success) throw new Error((res.data as any).message || 'Request failed');
  return { data: res.data.data, meta: res.data.meta };
}

export const invoiceService = {
  list: (params: {
    status?: string | null; payerId?: number | null; page?: number; limit?: number;
    sort?: string; dir?: 'asc' | 'desc';
  } = {}) => {
    const q = new URLSearchParams();
    if (params.status) q.set('status', params.status);
    if (params.payerId) q.set('payer_id', String(params.payerId));
    if (params.page) q.set('page', String(params.page));
    if (params.limit) q.set('limit', String(params.limit));
    if (params.sort) q.set('sort', params.sort);
    if (params.dir) q.set('dir', params.dir);
    return call<InvoiceRow[]>(`/invoices?${q.toString()}`);
  },

  /** BIL-20. Lines name one lawful thing each (event | item | legacy
   * product); quantity and price are the office's, and every total is the
   * database's. Refusals come back as sentences naming the next thing
   * needed — an already-billed event arrives with the invoice number on
   * it. */
  create: (input: {
    payer_id: number; property_id?: number | null;
    lines: Array<{
      service_event_id?: string | number | null;
      bid_item_id?: number | null;
      legacy_product_code?: string | null;
      description: string; quantity: string; unit_price: string;
      // Intent, not money (BIL-16): which lines the rate reaches. The amount of
      // tax is computed server-side over the taxable lines; default taxable.
      taxable?: boolean;
    }>;
  }): Promise<{ invoice: NewInvoice; line_count: number }> =>
    call<{ invoice: NewInvoice; line_count: number }>('/invoices', 'post', input)
      .then((r) => ({ invoice: r.data.invoice, line_count: r.data.line_count })),

  get: async (id: number): Promise<InvoiceDetail> =>
    (await call<InvoiceDetail>(`/invoices/${id}`)).data,

  /** Record a receipt (BIL-06). The server re-sums the rows into the header
   * and derives open/partial/paid; overpayment comes back naming the balance. */
  pay: async (id: number, body: {
    amount: number; method?: string; reference?: string; note?: string;
    client_uuid?: string;
  }): Promise<{ payment: PaymentRow; invoice: { status: string; amount_paid: string; balance: number } }> => {
    const res = await axios.post(`/api/invoices/${id}/payments`, body);
    return res.data as any;
  },

  /**
   * Post a linked adjustment. `lines` carries signed amounts — a negative
   * line_total on a positive-kind invoice, or a full credit. The server
   * refuses lines that reference neither a service event nor a legacy product
   * code (BIL-01), so the dialog builds them from the original's lines.
   */
  adjust: async (id: number, lines: Array<{
    service_event_id?: number | null;
    legacy_product_code?: string | null;
    service_type_id?: number | null;
    description?: string;
    quantity: number;
    unit_price: number;
  }>, reason: string): Promise<InvoiceRow & { adjusts_invoice_id: number }> => {
    const res = await axios.post<{ invoice: InvoiceRow & { adjusts_invoice_id: number } }>(
      `${API_BASE}/invoices/${id}/adjust`, { lines, reason },
    );
    return res.data.invoice;
  },
};
