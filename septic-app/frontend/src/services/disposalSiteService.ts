import axios from 'axios';
import { messageOf } from './ledgerService';

const API_BASE = '/api';

/**
 * The disposal-site vocabulary (LED-07): the list of places waste is legally
 * allowed to end up, now with the office's hands on it.
 *
 * This service is deliberately separate from `routeService.disposalSites`,
 * which serves the driver's Done dialog. The driver's read and the office's
 * writes meet at one endpoint on purpose — the vocabulary the driver chooses
 * from must be exactly the vocabulary the office maintains — but the code
 * that *changes* that vocabulary belongs to the office, not to the truck, and
 * keeping the two apart is what lets the driver path be read as frozen.
 *
 * The row shape is the server's `SELECT_LIST`: `events_using` is the number
 * the ledger names this site with, shown so a deletion is decided with the
 * consequences on screen. A refusal to delete arrives as a 409 that names the
 * site and the count; `messageOf` surfaces the server's sentence verbatim,
 * because it was written for exactly this moment.
 */

export interface DisposalSiteRow {
  id: number;
  name: string;
  dnr_permit_no: string | null;
  accepts_slurry: boolean | null;
  permitted: boolean;
  events_using: number;
  is_default: boolean;
}

export interface DisposalSiteInput {
  name?: string;
  dnr_permit_no?: string | null;
  accepts_slurry?: boolean | null;
}

const unwrap = (body: any) => {
  if (!body?.success) throw new Error(body?.error || body?.message || 'Request failed');
  return body.data;
};

export const disposalSiteService = {
  list: async (): Promise<DisposalSiteRow[]> =>
    unwrap((await axios.get(`${API_BASE}/disposal-sites`)).data),

  create: async (input: DisposalSiteInput): Promise<DisposalSiteRow> =>
    unwrap((await axios.post(`${API_BASE}/disposal-sites`, input)).data),

  update: async (id: number, input: DisposalSiteInput): Promise<DisposalSiteRow> =>
    unwrap((await axios.patch(`${API_BASE}/disposal-sites/${id}`, input)).data),

  remove: async (id: number): Promise<void> => {
    unwrap((await axios.delete(`${API_BASE}/disposal-sites/${id}`)).data);
  },

  /** The DRV-20 default the Done dialog pre-selects. One row, deliberately. */
  setDefault: async (siteId: number): Promise<void> => {
    unwrap((await axios.patch(`${API_BASE}/disposal-sites/default`, { site_id: siteId })).data);
  },
};

export { messageOf };
