import axios from 'axios';

const API_BASE = '/api';

/**
 * The client for the bids surface (BIL-09..16): the master price list, the
 * document, the signature, the invoice it becomes.
 *
 * Same rules the rest of this folder learned the hard way: dates are strings
 * (`to_char` on the server, never a parsed `Date`), money is **strings** end to
 * end — every numeric the server sends arrives as a string through
 * node-postgres, and this file keeps them strings rather than letting a float
 * within a pixel of a cent (BIL-04). The only arithmetic the frontend does is
 * the ÷100 the tax field needs on the way in, and it is string-formatted, not
 * multiplied.
 *
 * The lifecycle is the server's (BIL-12): these functions send decisions —
 * approve, decline, convert — and never a status, a total, or a timestamp.
 * A body that tries will hear the field named back (SCH-11's rule).
 */

export interface BidSettings {
  sales_tax_rate: string; // decimal string: '0.0550'
  updated_at: string | null;
  updated_by: string | null;
}

export interface BidItem {
  id: number;
  name: string;
  unit: string;
  unit_price: string; // '300.00'
  is_active: boolean;
  created_at: string;
}

export interface BidLine {
  id: number;
  bid_item_id: number | null;
  item_name: string | null;
  description: string;
  unit: string;
  unit_price: string;
  quantity: string;
  line_total: string; // server-computed; typed into nothing
  sequence_no: number;
}

export interface BidSummary {
  id: number;
  bid_date: string;
  status: 'draft' | 'approved' | 'declined' | 'invoiced';
  payer_name: string;
  site_address: string | null;
  approved_on: string | null;
  invoice_id: number | null;
  subtotal: string;
  line_count: number;
  eff_tax_rate: string;
  tax_estimated: boolean;
  tax_amount: string;
  total: string;
}

export interface BidDetail extends BidSummary {
  payer_id: number;
  property_id: number | null;
  notes: string | null;
  decline_note: string | null;
  bid_tax_rate: string;
  approved_at: string | null;
  declined_at: string | null;
  approved_by_name: string | null;
  mailing_address: string | null;
  mailing_city: string | null;
  mailing_state: string | null;
  mailing_zip: string | null;
  site_city: string | null;
  site_state: string | null;
  site_zip: string | null;
  lines: BidLine[];
}

async function call<T>(path: string, method: 'get' | 'post' | 'patch' | 'delete' = 'get',
                       body?: unknown): Promise<{ data: T; meta?: unknown }> {
  const config = { withCredentials: true };
  const res = method === 'get'
    ? await axios.get(`${API_BASE}${path}`, config)
    : method === 'post'
      ? await axios.post(`${API_BASE}${path}`, body ?? {}, config)
      : method === 'patch'
        ? await axios.patch(`${API_BASE}${path}`, body ?? {}, config)
        : await axios.delete(`${API_BASE}${path}`, config);
  if (res.data?.success === false) {
    throw new Error(res.data.message || 'Request failed');
  }
  return { data: res.data.data, meta: res.data.meta };
}

export const bidService = {
  settings: () => call<BidSettings>('/settings'),

  /**
   * Percent in, decimal out — formatted, not multiplied. 5.5 becomes '0.0550'
   * because the server's CHECK refuses the number a clerk typing 5.5 into a
   * rate field means, and the UI's job is to never hand it one.
   */
  setSalesTax: async (percent: string): Promise<BidSettings> => {
    const p = Number(percent);
    if (!Number.isFinite(p) || p < 0 || p >= 100) {
      throw new Error('a tax rate is a percent below 100 — nothing was changed');
    }
    const rate = (p / 100).toFixed(4);
    const { data } = await call<BidSettings>('/settings/sales-tax', 'patch',
      { sales_tax_rate: rate });
    return data;
  },

  bidItems: (includeRetired = false) =>
    call<BidItem[]>(`/bid-items${includeRetired ? '?include_retired=1' : ''}`),

  createBidItem: (input: { name: string; unit: string; unit_price: string }) =>
    call<BidItem>('/bid-items', 'post', input),

  updateBidItem: (id: number, input: Partial<{ name: string; unit: string;
    unit_price: string; is_active: boolean }>) =>
    call<BidItem>(`/bid-items/${id}`, 'patch', input),

  bids: (status?: string, payerId?: number) => {
    const qs = new URLSearchParams();
    if (status) qs.set('status', status);
    if (payerId) qs.set('payer_id', String(payerId));
    const q = qs.toString();
    return call<BidSummary[]>(`/bids${q ? `?${q}` : ''}`);
  },

  bid: (id: number) => call<BidDetail>(`/bids/${id}`),

  createBid: (input: { payer_id: number; property_id?: number | null; notes?: string }) =>
    call<BidDetail>('/bids', 'post', input),

  addLine: (bidId: number, input:
    | { bid_item_id: number; quantity: string }
    | { description: string; unit: string; unit_price: string; quantity: string }) =>
    call<BidLine>(`/bids/${bidId}/lines`, 'post', input),

  updateLine: (bidId: number, lineId: number, input: Partial<{ description: string;
    unit: string; quantity: string; unit_price: string }>) =>
    call<BidLine>(`/bids/${bidId}/lines/${lineId}`, 'patch', input),

  removeLine: (bidId: number, lineId: number) =>
    call<{ removed: boolean }>(`/bids/${bidId}/lines/${lineId}`, 'delete'),

  approve: (bidId: number) => call<BidDetail>(`/bids/${bidId}/approve`, 'post', {}),

  decline: (bidId: number, note?: string) =>
    call<BidDetail>(`/bids/${bidId}/decline`, 'post', { note: note ?? null }),

  convert: (bidId: number) =>
    call<{ bid_id: number; invoice_id: number; subtotal: string;
           tax_amount: string; total: string }>(`/bids/${bidId}/convert`, 'post', {}),
};
