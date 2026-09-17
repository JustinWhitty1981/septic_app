import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SortHeader, useClientSort } from '../sort';
import {
  Box, Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Typography, Alert, Paper, Chip, Skeleton, Stack, Button,
  Dialog, DialogTitle, DialogContent, DialogActions, TextField,
  InputAdornment, IconButton,
} from '@mui/material';
import { Visibility, VisibilityOff } from '@mui/icons-material';
import { userService, AccountRow } from '../services/userService';
import { messageOf } from '../services/ledgerService';
import { authService } from '../services/authService';

/**
 * Accounts (AUT-12). Admin-only, and the screen is honest about what
 * "deactivate" does.
 *
 * The server's PATCH advances the account's `tokens_epoch`, which is what
 * makes the AUT-11 promise real: a disabled account's already-issued tokens
 * die with the flip, not at expiry. The epoch column is shown for exactly that
 * reason — it is the receipt. An admin who disables an account and sees the
 * epoch move knows the stolen tablet is out; if it never moves, the promise
 * broke here and not in the login code.
 *
 * No delete, because there is no delete: notes, media, ledger rows and
 * quarantine resolutions name `users.id`, and the FK is RESTRICT on every one
 * of them. An account that ever existed stays referencable forever; `is_active`
 * is the whole off switch.
 *
 * The reset-password button exists because a forgotten password used to have
 * two answers, both bad: an admin at a keyboard with seed-user.ts, or — in the
 * legacy system — one shared plaintext password everyone knew. There is no
 * "forgot password" link anywhere in this app because no employee email exists
 * to carry a link; the identity proof is walking to an admin, and this button
 * is what the walk is for.
 */

const ROLES = ['driver', 'office', 'manager', 'admin'];

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : 'never');

const UsersPage: React.FC = () => {
  const [rows, setRows] = useState<AccountRow[]>([]);
  const sorter = useClientSort<AccountRow>(rows, {
    name: (u) => `${u.last_name} ${u.first_name}`, email: (u) => u.email,
    role: (u) => u.role, last_login: (u) => u.last_login_at,
    epoch: (u) => u.tokens_epoch, status: (u) => (u.is_active ? 'active' : 'disabled'),
  }, 'name', 'asc');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', password: '', role: 'driver' });
  const [createBusy, setCreateBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [resetting, setResetting] = useState<AccountRow | null>(null);
  const [resetPw, setResetPw] = useState('');
  const [resetBusy, setResetBusy] = useState(false);
  const [showResetPw, setShowResetPw] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const navigate = useNavigate();
  const me = authService.getUser();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await userService.list());
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const submitCreate = async () => {
    setCreateBusy(true);
    setCreateError(null);
    try {
      await userService.create(form);
      setCreating(false);
      setForm({ first_name: '', last_name: '', email: '', password: '', role: 'driver' });
      await load();
    } catch (e) {
      setCreateError(messageOf(e));
    } finally {
      setCreateBusy(false);
    }
  };

  const toggleActive = async (u: AccountRow) => {
    setError(null);
    try {
      await userService.setActive(u.id, !u.is_active);
      await load();
    } catch (e) {
      setError(messageOf(e));
    }
  };

  const openReset = (u: AccountRow) => {
    setResetting(u); setResetPw(''); setResetError(null); setShowResetPw(false);
  };

  const submitReset = async () => {
    if (!resetting) return;
    setResetBusy(true);
    setResetError(null);
    const self = resetting.id === me?.id;
    try {
      await userService.resetPassword(resetting.id, resetPw);
      setResetting(null);
      if (self) {
        // The reset advanced this very account's epoch: every remaining call
        // this page makes is already a dead token's call. Saying so and ending
        // the session is truer than letting the next request's 401 discover
        // it mid-table — the interceptor's ?expired= screen reads exactly
        // right here: the session is over, sign in with the new password.
        authService.logout();
        navigate('/login?expired=true');
        return;
      }
      await load();
    } catch (e) {
      setResetError(messageOf(e));
    } finally {
      setResetBusy(false);
    }
  };

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Typography variant="h5">Accounts</Typography>
        <Button variant="contained" onClick={() => setCreating(true)}>New account</Button>
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {loading && !rows.length && <Skeleton variant="rectangular" height={320} />}

      <TableContainer component={Paper}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <SortHeader label="Name" field="name" sort={sorter.sort} onSort={sorter.onSort} />
              <SortHeader label="Email" field="email" sort={sorter.sort} onSort={sorter.onSort} />
              <SortHeader label="Role" field="role" sort={sorter.sort} onSort={sorter.onSort} />
              <SortHeader label="Last login" field="last_login" sort={sorter.sort} onSort={sorter.onSort} />
              <SortHeader label="Token epoch" field="epoch" sort={sorter.sort} onSort={sorter.onSort} align="right" />
              <SortHeader label="Status" field="status" sort={sorter.sort} onSort={sorter.onSort} />
              <TableCell />
            </TableRow>
          </TableHead>
          <TableBody>
            {sorter.sorted.map((u) => (
              <TableRow key={u.id} hover>
                <TableCell>{u.first_name} {u.last_name}</TableCell>
                <TableCell>{u.email}</TableCell>
                <TableCell><Chip size="small" label={u.role} /></TableCell>
                <TableCell>{when(u.last_login_at)}</TableCell>
                <TableCell align="right">{u.tokens_epoch}</TableCell>
                <TableCell>
                  <Chip size="small" color={u.is_active ? 'success' : 'default'}
                    label={u.is_active ? 'active' : 'disabled'} />
                </TableCell>
                <TableCell align="right">
                  {/* Offered on your own row too — unlike disabling. Changing
                      your own password is the legitimate case, and the dialog
                      says plainly that it will sign this device out. */}
                  <Button size="small" aria-label={`Reset password for ${u.email}`}
                    onClick={() => openReset(u)}>
                    Reset password
                  </Button>
                  {/* The server refuses to let you deactivate yourself; the
                      screen agrees, so the refusal never has to be explained. */}
                  {u.id !== me?.id && (
                    <Button size="small" color={u.is_active ? 'error' : 'success'}
                      onClick={() => toggleActive(u)}>
                      {u.is_active ? 'Disable' : 'Enable'}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      <Dialog open={creating} onClose={() => !createBusy && setCreating(false)} maxWidth="xs" fullWidth>
        <DialogTitle>New account</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1} sx={{ mt: 1 }}>
            <TextField label="First name" size="small" value={form.first_name}
              onChange={(e) => setForm({ ...form, first_name: e.target.value })} />
            <TextField label="Last name" size="small" value={form.last_name}
              onChange={(e) => setForm({ ...form, last_name: e.target.value })} />
            <TextField label="Email" size="small" value={form.email}
              autoComplete="off"
              onChange={(e) => setForm({ ...form, email: e.target.value })} />
            {/* autoComplete="new-password" and the toggle are load-bearing, not
                cosmetic: an unmarked type="password" field inside a dialog is
                what password managers autofill over — the account gets created
                with the manager's guess and the typed password never arrives. */}
            <TextField label="Password" size="small" type={showPassword ? 'text' : 'password'}
              name="new-user-password" autoComplete="new-password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              helperText="10+ characters, upper, lower, digit and a symbol — the server enforces it"
              InputProps={{
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton aria-label="toggle password visibility" edge="end"
                      onClick={() => setShowPassword((v) => !v)}>
                      {showPassword ? <VisibilityOff /> : <Visibility />}
                    </IconButton>
                  </InputAdornment>
                ),
              }}
            />
            <TextField label="Role" size="small" select SelectProps={{ native: true }}
              value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </TextField>
          </Stack>
          {createError && <Alert severity="error" sx={{ mt: 1 }}>{createError}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreating(false)} disabled={createBusy}>Cancel</Button>
          <Button variant="contained" onClick={submitCreate} disabled={createBusy}>Create</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!resetting} onClose={() => !resetBusy && setResetting(null)}
        maxWidth="xs" fullWidth>
        <DialogTitle>Reset password{resetting?.id === me?.id ? ' — your own account' : ''}</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" sx={{ mt: 1 }}>
            {resetting?.id === me?.id
              ? 'Signing the new password in everywhere ends every session this account holds — including this screen. You will return to the sign-in page.'
              : `${resetting?.first_name} ${resetting?.last_name} signs in with the new password immediately, and every session from the old one — a lost tablet included — stops working now, not at expiry.`}
          </Typography>
          <Stack spacing={1} sx={{ mt: 2 }}>
            {/* Same load-bearing autofill guard as the create form: an
                unmarked password field in a dialog is where password managers
                paste the admin's own credential. */}
            <TextField label="New password" size="small" type={showResetPw ? 'text' : 'password'}
              name="reset-user-password" autoComplete="new-password" autoFocus
              value={resetPw} onChange={(e) => setResetPw(e.target.value)}
              helperText="10+ characters, upper, lower, digit and a symbol — the server enforces it"
              InputProps={{
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton aria-label="toggle password visibility" edge="end"
                      onClick={() => setShowResetPw((v) => !v)}>
                      {showResetPw ? <VisibilityOff /> : <Visibility />}
                    </IconButton>
                  </InputAdornment>
                ),
              }}
            />
          </Stack>
          {resetError && <Alert severity="error" sx={{ mt: 1 }}>{resetError}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setResetting(null)} disabled={resetBusy}>Cancel</Button>
          <Button variant="contained" onClick={submitReset} disabled={resetBusy || !resetPw}>
            Reset password
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default UsersPage;
