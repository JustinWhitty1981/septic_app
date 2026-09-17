import axios from 'axios';

const API_BASE = '/api';

/**
 * Accounts receivable (BIL-07). One row per payer that owes money, recomputed
 * by the server on every call — the same rule the state report learned from
 * `tblStateReports`: a stored balance is a balance that drifts.
 *
 * The `credit_balances` meta count is part of the contract, not decoration:
 * a paid-then-voided legacy invoice leaves someone owing *them* money, and
 * those payers are invisible in the list by design (balance > 0 is the chase
 * list). The count makes the invisible population visible without putting a
 * negative number in front of a collector dialing a phone.
 */

export interface ReceivableRow {
  payer_id: number;
  payer_name: string | null;
  billed: string;
  collected: string;
  balance: string;
  oldest_open: string | null;
  open_invoices: number;
}

export interface ReceivablesMeta {
  payers_owing: number;
  total_receivable: string;
  credit_balances: number;
}

export const receivablesService = {
  list: async (q?: string): Promise<{ data: ReceivableRow[]; meta: ReceivablesMeta }> => {
    const res = await axios.get(`${API_BASE}/receivables`, {
      params: q && q.trim() ? { q } : undefined,
    });
    if (!res.data.success) throw new Error('Request failed');
    return { data: res.data.data, meta: res.data.meta };
  },
};
