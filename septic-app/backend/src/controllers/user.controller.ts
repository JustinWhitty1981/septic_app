import { Request, Response } from 'express';
import { AppDataSource } from '../config/database';
import { hashPassword } from '../utils/password';
import { passwordValidation } from '../config/auth';
import { internalError } from '../utils/errors';
import { USER_ROLE, UserRole } from '../models/enums';

const INT4_MAX = 2147483647;

function intParam(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= INT4_MAX ? n : null;
}

// Same list the enum migration created; a body naming a fifth role is a typo or an
// attack, and neither reaches the database to find out which.
const isRole = (v: unknown): v is UserRole => (USER_ROLE as readonly string[]).includes(v as string);

const publicUser = (row: any) => ({
  id: row.id,
  first_name: row.first_name,
  last_name: row.last_name,
  email: row.email,
  role: row.role,
  is_active: row.is_active,
  last_login_at: row.last_login_at,
});

const SELECT_COLS =
  'id, first_name, last_name, email, role, is_active, last_login_at';

/**
 * Account operations (AUT-12).
 *
 * scripts/seed-user.ts is a bootstrap tool: it exists because a fleet cannot start
 * with zero logins, not because anyone in the office should be learning ts-node.
 * These two endpoints are the operations surface — create with an explicit role
 * (which the public /register must never allow, AUT-01), and disable/re-enable.
 *
 * Password reset lives here now (resetPassword, below) rather than in a
 * self-service "forgot password" flow: no employee email exists to send a link
 * to, the office is the identity proof, and the legacy corpus's answer to a
 * forgotten password was one shared plaintext one for everyone — this is the
 * version where the reset is a named admin's decision and the old sessions die
 * with the old password.
 *
 * Deliberately absent:
 *   * role changes — nobody has asked to demote someone mid-shift, and the first
 *     version of an endpoint should not include the mutation with the worst blast
 *     radius;
 *   * DELETE — a login is referenced by notes, media, events and quarantine
 *     resolutions. Disabling is the reversible, honest version of removing.
 */

export const createUser = async (req: Request, res: Response): Promise<void> => {
  try {
    const { first_name, last_name, email, password, role } = req.body;

    if (!first_name || !last_name || !email || !password || !role) {
      res.status(400).json({ error: 'first_name, last_name, email, password and role are required' });
      return;
    }
    if (!isRole(role)) {
      res.status(400).json({ error: `role must be one of: ${USER_ROLE.join(', ')}` });
      return;
    }
    if (!passwordValidation.isValid(password)) {
      res.status(400).json({ error: 'Password does not meet requirements', requirements: passwordValidation.getRequirements() });
      return;
    }

    const hash = await hashPassword(password);
    let rows: any[];
    try {
      // TypeORM's query() is not uniform: SELECT and INSERT…RETURNING return the
      // row array, UPDATE/DELETE…RETURNING return [rows, rowCount]. Measured,
      // not assumed — both shapes appear in this file, each matched to its
      // statement.
      rows = await AppDataSource.query(
        `INSERT INTO users (first_name, last_name, email, password_hash, role, is_active)
         VALUES ($1, $2, $3, $4, $5, true)
         RETURNING ${SELECT_COLS}`,
        [first_name, last_name, String(email).toLowerCase(), hash, role],
      );
    } catch (error: any) {
      // The unique violation is the expected collision and the only one worth
      // naming; anything else is a real failure and keeps the internal-error
      // discipline of NF-11.
      if (error?.code === '23505') {
        res.status(409).json({ error: 'User with this email already exists' });
        return;
      }
      throw error;
    }

    res.status(201).json({ user: publicUser(rows[0]) });
  } catch (error) {
    res.status(500).json({ error: internalError(error) });
  }
};

export const setActive = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = intParam(req.params.id);
    if (id === null) {
      res.status(404).json({ error: 'User id must be a positive integer' });
      return;
    }
    const { is_active } = req.body;
    if (typeof is_active !== 'boolean') {
      res.status(400).json({ error: 'is_active must be a boolean' });
      return;
    }

    // An admin who disables themself locks the API out for everyone: there is no
    // second admin guaranteed, no recovery flow, and `authenticate` (AUT-11) will
    // refuse their tokens the moment the flag drops. Refuse the footgun at the
    // boundary rather than documenting it in an outage post-mortem.
    if (!is_active && id === req.user!.userId) {
      res.status(400).json({ error: 'You cannot deactivate your own account' });
      return;
    }

    // Narrow UPDATE (AUT-09's rule): a full-row save would clobber columns another
    // admin or the login flow changed in between. On deactivation the session
    // epoch also advances (AUT-11): `is_active = false` makes `authenticate`
    // refuse the token *while it holds*, but a refusal conditioned on a flag is
    // a pause, not a revocation — re-enabling would hand the tablet its session
    // back. Staff are disabled for reasons (suspension, a compromise being
    // investigated); the re-entry condition after that must be a fresh login.
    const [rows] = await AppDataSource.query(
      `UPDATE users
          SET is_active = $2,
              tokens_epoch = tokens_epoch + (CASE WHEN $2 THEN 0 ELSE 1 END),
              updated_at = now()
        WHERE id = $1
        RETURNING ${SELECT_COLS}`,
      [id, is_active],
    );

    if (!rows.length) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({ user: publicUser(rows[0]) });
  } catch (error) {
    res.status(500).json({ error: internalError(error) });
  }
};

/**
 * Reset one account's password (AUT-12, closes the thread the table's absence
 * comment used to carry).
 *
 * Why an admin action and not a self-service "forgot password" link: no
 * employee email exists in this system to send one to, and the identity proof
 * the office already has is the office itself. The legacy corpus is the
 * warning label — it ran one shared plaintext password precisely because
 * nobody had this endpoint — so the requirements here are that the reset is
 * attributable (admin-only router, and the audit trail is that admin's token)
 * and that it lands clean: the same AUT-06 policy as creation (a reset that
 * accepted anything would re-create the shared-weak-password corpus through
 * the front door), and `tokens_epoch` advances like it does for deactivation,
 * because a "reset" that left the stolen tablet's session alive would reset
 * the password and nothing else. That includes resetting your own account —
 * the changed-password sessions die too, which is what makes a self-reset a
 * real change and not a rename.
 */
export const resetPassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = intParam(req.params.id);
    if (id === null) {
      res.status(404).json({ error: 'User id must be a positive integer' });
      return;
    }
    const { password } = req.body ?? {};
    if (typeof password !== 'string' || password.length === 0) {
      res.status(400).json({ error: 'password is required' });
      return;
    }
    if (!passwordValidation.isValid(password)) {
      res.status(400).json({ error: 'Password does not meet requirements', requirements: passwordValidation.getRequirements() });
      return;
    }

    const hash = await hashPassword(password);
    // UPDATE…RETURNING answers [rows, rowCount] (the one TypeORM rule), and the
    // epoch moves exactly like setActive's: the password stopped being a
    // secret the moment this landed, and every session minted under it should
    // know that. Narrow UPDATE, AUT-09's rule — a full-row save here could
    // clobber a deactivation that happened a keystroke earlier.
    const [rows] = await AppDataSource.query(
      `UPDATE users
          SET password_hash = $2, tokens_epoch = tokens_epoch + 1, updated_at = now()
        WHERE id = $1
        RETURNING ${SELECT_COLS}`,
      [id, hash],
    );

    if (!rows.length) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({ user: publicUser(rows[0]) });
  } catch (error) {
    res.status(500).json({ error: internalError(error) });
  }
};

/**
 * The account list (AUT-12's read half).
 *
 * `password_hash` is not in the column list. Not "filtered out before the
 * response" — absent from the SELECT, so no future refactor that spreads the
 * row into a response can leak it by accident. `tokens_epoch` is shown because
 * the admin screen it serves has to display *why* a disabled account cannot
 * log in with its old token: the epoch moved, and this column is the receipt.
 */
export const listUsers = async (req: Request, res: Response): Promise<unknown> => {
  try {
    const rows = await AppDataSource.query(
      `SELECT id, email, first_name, last_name, role::text AS role,
              is_active, last_login_at, created_at, tokens_epoch
         FROM septic_app.users
        ORDER BY is_active DESC, last_name, first_name`,
    );
    return res.json({ success: true, data: rows });
  } catch (error) {
    return res.status(500).json({ error: internalError(error) });
  }
};
