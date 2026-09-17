import axios from 'axios';

const API_BASE = '/api';

/**
 * The one-row company settings (0027's table): the sales-tax rate every bid and
 * new invoice reads, the payment terms every printed invoice states on its
 * face, and the letterhead identity (0037) — name, logo, address, email, phone —
 * that every printed invoice and bid carries. Set once by the office, never
 * retyped per document — which is the point of surfacing it on its own screen
 * instead of only inside the bid form, where a global value looked like a
 * per-job one.
 */
export interface CompanySettings {
  sales_tax_rate: string;
  payment_term_days: number;
  late_fee_rate_monthly: string;
  company_name: string;
  logo_media_id: number | null;
  address: string | null;
  email: string | null;
  phone: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

/** The identity fields of one PATCH /settings/company (null clears a field). */
export interface CompanyIdentity {
  company_name?: string | null;
  logo_media_id?: number | null;
  address?: string | null;
  email?: string | null;
  phone?: string | null;
}

interface Envelope<T> { success: boolean; data: T }

export function messageOf(err: unknown): string {
  const e = err as { response?: { data?: { message?: string; error?: string } } };
  return e?.response?.data?.message || e?.response?.data?.error
    || (err instanceof Error ? err.message : 'Request failed');
}

async function call<T>(path: string, method: 'get' | 'patch' = 'get', body?: unknown): Promise<T> {
  const res = method === 'get'
    ? await axios.get<Envelope<T>>(`${API_BASE}${path}`)
    : await axios.patch<Envelope<T>>(`${API_BASE}${path}`, body);
  if (!res.data.success) throw new Error((res.data as any).message || 'Request failed');
  return res.data.data;
}

export const settingsService = {
  get: (): Promise<CompanySettings> => call<CompanySettings>('/settings'),

  /** A decimal rate (0.055 = 5.5%). The UI multiplies by 100 so the field means
   *  what the clerk types; the server refuses a percent-as-rate. */
  setSalesTax: (rate: string | number): Promise<CompanySettings> =>
    call<CompanySettings>('/settings/sales-tax', 'patch', { sales_tax_rate: rate }),

  setPaymentTerms: (days: number, lateRateMonthly: string | number): Promise<CompanySettings> =>
    call<CompanySettings>('/settings/payment-terms', 'patch',
      { payment_term_days: days, late_fee_rate_monthly: lateRateMonthly }),

  /** The letterhead the papers print: name, logo, contact block — set once. */
  setCompany: (identity: CompanyIdentity): Promise<CompanySettings> =>
    call<CompanySettings>('/settings/company', 'patch', identity),

  /**
   * The logo's bytes as an object URL. Fetched, not pointed at: /api/media/:id/raw
   * rides the Bearer header (the bucket is private and presigned URLs were
   * refused on purpose), so a bare <img src> could never authenticate.
   */
  async getLogoUrl(id: number): Promise<string> {
    const res = await axios.get<Blob>(`${API_BASE}/media/${id}/raw`, { responseType: 'blob' });
    return URL.createObjectURL(res.data);
  },
};
