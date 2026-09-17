import axios from 'axios';
import { messageOf } from './ledgerService';

const API_BASE = '/api';

/**
 * Account administration (AUT-12). Admin-only at the server; the menu hides it
 * for everyone else.
 *
 * Disabling is the whole story here. `PATCH /api/users/:id` with
 * `{is_active: false}` advances the account's `tokens_epoch`, which is what
 * actually kills a stolen tablet's live session — flipping the boolean alone
 * would leave the JWT good until it expires. The screen shows the epoch for
 * that reason: it is the receipt that the logout-revokes-sessions promise
 * fired.
 */

export interface AccountRow {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  role: 'admin' | 'manager' | 'office' | 'driver';
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  tokens_epoch: number;
}

export function messageOfAccount(err: unknown): string { return messageOf(err); }

export const userService = {
  list: async (): Promise<AccountRow[]> => {
    const res = await axios.get<{ success: boolean; data: AccountRow[] }>(`${API_BASE}/users`);
    if (!res.data.success) throw new Error('Request failed');
    return res.data.data;
  },

  create: async (body: {
    email: string; password: string; first_name: string; last_name: string; role: string;
  }): Promise<AccountRow> => {
    const res = await axios.post<{ success?: boolean; data?: AccountRow; user?: AccountRow }>(
      `${API_BASE}/users`, body,
    );
    return res.data.data ?? (res.data.user as AccountRow);
  },

  setActive: async (id: number, is_active: boolean): Promise<void> => {
    await axios.patch(`${API_BASE}/users/${id}`, { is_active });
  },

  /**
   * Set a new password for an account (AUT-12). There is no "forgot password"
   * to link to — no employee mail exists to carry a link — so a forgotten
   * password is a walk to an admin, and this is what the admin's button calls.
   * The server advances the account's epoch like a deactivation does: every
   * session minted under the old password dies at the moment this lands,
   * including the resetter's own if they reset their own account.
   */
  resetPassword: async (id: number, password: string): Promise<AccountRow> => {
    const res = await axios.post<{ user?: AccountRow; data?: AccountRow }>(
      `${API_BASE}/users/${id}/password`, { password },
    );
    return res.data.user ?? (res.data.data as AccountRow);
  },
};
