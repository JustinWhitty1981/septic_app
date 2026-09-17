import axios from 'axios';
import { messageOf } from './ledgerService';

const API_BASE = '/api';

/**
 * Payers and ownership — the two reads and one write behind "reassign this
 * site" (SCH-06).
 *
 * Search is required, not a nicety: 7,572 payers, and the reassignment form
 * cannot show them all. The `sites_owned` count on each result is the answer
 * to the only question that matters when two rows have similar names — which
 * one already owns sites?
 *
 * `assign` is an *event*: closing the old row and opening a new one happens in
 * one server transaction, and the response names the closed row so the screen
 * can show what changed without a refetch guessing.
 */

export interface PayerHit {
  id: number;
  name: string | null;
  mailing_address: string | null;
  mailing_city: string | null;
  mailing_state: string | null;
  mailing_zip: string | null;
  legacy_billing_no: number | null;
  sites_owned: number;
}

export interface OwnershipRow {
  id: number;
  payer_id: number;
  payer_name: string | null;
  ownership_start: string;
  ownership_end: string | null;
  is_primary: boolean;
  source: string;
  current: boolean;
}

export const payerService = {
  search: async (q: string): Promise<PayerHit[]> => {
    const res = await axios.get<{ success: boolean; data: PayerHit[] }>(
      `${API_BASE}/payers?q=${encodeURIComponent(q)}`,
    );
    if (!res.data.success) throw new Error('Request failed');
    return res.data.data;
  },

  /**
   * Add a biller (SCH-12) — the form behind the office decision. Deliberately
   * a separate call from `search`: the search box has never created a row and
   * the dialog must not start pretending it does. The response is the same
   * shape `search` returns, so a newly created payer can become the picked
   * one without a re-search guessing which of two Whitties it just made.
   */
  create: async (input: {
    org_name?: string | null; first_name?: string | null; last_name?: string | null;
    mailing_address?: string | null; mailing_city?: string | null;
    mailing_state?: string | null; mailing_zip?: string | null; phone?: string | null;
  }): Promise<PayerHit> => {
    const res = await axios.post<{ success: boolean; data?: PayerHit; message?: string }>(
      `${API_BASE}/payers`, input,
    );
    if (!res.data.success || !res.data.data) {
      throw new Error(res.data.message || 'Request failed');
    }
    return res.data.data;
  },
};

export const ownerService = {
  list: async (propertyId: number): Promise<OwnershipRow[]> => {
    const res = await axios.get<{ success: boolean; data: OwnershipRow[] }>(
      `${API_BASE}/properties/${propertyId}/owners`,
    );
    if (!res.data.success) throw new Error('Request failed');
    return res.data.data;
  },

  assign: async (propertyId: number, payerId: number): Promise<{
    ownership: { id: number }; closed_ownership_id: number | null;
  }> => {
    const res = await axios.post<{ ownership: { id: number }; closed_ownership_id: number | null }>(
      `${API_BASE}/properties/${propertyId}/owners`, { payer_id: payerId },
    );
    return res.data;
  },
};

export function messageOfOwner(err: unknown): string { return messageOf(err); }
