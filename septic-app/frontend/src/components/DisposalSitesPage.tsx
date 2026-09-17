import React, { useCallback, useEffect, useState } from 'react';
import { SortHeader, useClientSort } from '../sort';
import {
  Box, Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Typography, Alert, Paper, Chip, Skeleton, Stack, Button,
  Dialog, DialogTitle, DialogContent, DialogActions, TextField,
} from '@mui/material';
import {
  disposalSiteService, DisposalSiteRow,
} from '../services/disposalSiteService';
import { messageOf } from '../services/ledgerService';

/**
 * The disposal sites, editable (LED-07).
 *
 * The county report is assembled per site, and the sites were 105 strings
 * typed into a legacy app — `Land`, `Slurrystore`, `spread on his land`.
 * Somebody has to tidy that table, and the codebase has always said who:
 * the office. This is that surface.
 *
 * Two columns exist because two decisions need them. `events_using` is what
 * the ledger names this site with: it is the difference between a typo being
 * deletable and a destination being real, and the screen says so before the
 * Delete button is ever pressed. `default` is DRV-20's row — every list has
 * exactly one, because "where does waste usually go" having two answers is
 * how a Done dialog pre-selects a guess nobody made.
 *
 * Deletes are confirmed in place, one second hand away: the button asks, the
 * second click answers to the server, and a refusal comes back as the
 * server's own sentence — it already names the site and the count, and
 * rewording that here would only make it less specific.
 */

const SLURRY = [
  { value: '', label: 'unknown' },
  { value: 'true', label: 'yes' },
  { value: 'false', label: 'no' },
];

const emptyForm = { name: '', dnr_permit_no: '', accepts_slurry: '' };

const DisposalSitesPage: React.FC = () => {
  const [rows, setRows] = useState<DisposalSiteRow[]>([]);
  const sorter = useClientSort<DisposalSiteRow>(rows, {
    name: (r) => r.name, events: (r) => r.events_using,
    permit: (r) => r.dnr_permit_no, slurry: (r) => r.accepts_slurry,
    status: (r) => (r.is_default ? '0 default' : r.events_using ? '1 in use' : '2 unused'),
  }, 'events', 'desc');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [dialog, setDialog] = useState<'closed' | 'create' | 'edit'>('closed');
  const [editing, setEditing] = useState<DisposalSiteRow | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // One click to arm, one to fire — jsdom has no confirm(), and a
  // window.confirm that a test cannot see is a test that cannot pass.
  const [armedDelete, setArmedDelete] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await disposalSiteService.list());
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => {
    setForm(emptyForm);
    setFormError(null);
    setDialog('create');
  };

  const openEdit = (row: DisposalSiteRow) => {
    setEditing(row);
    setForm({
      name: row.name,
      dnr_permit_no: row.dnr_permit_no ?? '',
      accepts_slurry: row.accepts_slurry === null ? '' : String(row.accepts_slurry),
    });
    setFormError(null);
    setDialog('edit');
  };

  const submit = async () => {
    setBusy(true);
    setFormError(null);
    const body = {
      name: form.name.trim(),
      dnr_permit_no: form.dnr_permit_no.trim() || null,
      accepts_slurry: form.accepts_slurry === '' ? null : form.accepts_slurry === 'true',
    };
    try {
      if (dialog === 'create') await disposalSiteService.create(body);
      else if (editing) await disposalSiteService.update(editing.id, body);
      setDialog('closed');
      await load();
    } catch (e) {
      // A 409 from the UNIQUE arrives already naming the name; show it in the
      // dialog, where the name was typed.
      setFormError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const makeDefault = async (row: DisposalSiteRow) => {
    setError(null);
    try {
      await disposalSiteService.setDefault(row.id);
      await load();
    } catch (e) {
      setError(messageOf(e));
    }
  };

  const remove = async (row: DisposalSiteRow) => {
    setError(null);
    setArmedDelete(null);
    try {
      await disposalSiteService.remove(row.id);
      await load();
    } catch (e) {
      setError(messageOf(e));
    }
  };

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Box>
          <Typography variant="h5">Disposal sites</Typography>
          <Typography variant="body2" color="text.secondary">
            Where waste is allowed to end up. Renaming is safe — the ledger follows the id.
            A site the ledger names cannot be deleted; history is not pointed away.
          </Typography>
        </Box>
        <Button variant="contained" onClick={openCreate}>Add site</Button>
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {loading && !rows.length && <Skeleton variant="rectangular" height={320} />}

      <TableContainer component={Paper}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <SortHeader label="Name" field="name" sort={sorter.sort} onSort={sorter.onSort} />
              <SortHeader label="Events naming it" field="events" sort={sorter.sort} onSort={sorter.onSort} align="right" />
              <SortHeader label="DNR permit" field="permit" sort={sorter.sort} onSort={sorter.onSort} />
              <SortHeader label="Slurry" field="slurry" sort={sorter.sort} onSort={sorter.onSort} />
              <SortHeader label="Status" field="status" sort={sorter.sort} onSort={sorter.onSort} />
              <TableCell />
            </TableRow>
          </TableHead>
          <TableBody>
            {sorter.sorted.map((r) => (
              <TableRow key={r.id} hover>
                <TableCell>{r.name}</TableCell>
                <TableCell align="right">{r.events_using}</TableCell>
                <TableCell>{r.permitted ? r.dnr_permit_no : '—'}</TableCell>
                <TableCell>
                  {r.accepts_slurry === null ? 'unknown' : r.accepts_slurry ? 'yes' : 'no'}
                </TableCell>
                <TableCell>
                  {r.is_default
                    ? <Chip size="small" color="primary" label="company default" />
                    : <Chip size="small" variant="outlined" label={r.events_using ? 'in use' : 'unused'} />}
                </TableCell>
                <TableCell align="right">
                  <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                    {!r.is_default && (
                      <Button size="small" onClick={() => makeDefault(r)}>Make default</Button>
                    )}
                    <Button size="small" onClick={() => openEdit(r)}>Edit</Button>
                    {armedDelete === r.id ? (
                      <Button size="small" color="error" onClick={() => remove(r)}>
                        Confirm delete
                      </Button>
                    ) : (
                      <Button size="small" color="error" onClick={() => setArmedDelete(r.id)}>
                        Delete
                      </Button>
                    )}
                  </Stack>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      <Dialog
        open={dialog !== 'closed'}
        onClose={() => !busy && setDialog('closed')}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>{dialog === 'create' ? 'Add a disposal site' : `Edit “${editing?.name}”`}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1} sx={{ mt: 1 }}>
            <TextField label="Name" size="small" value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              helperText={dialog === 'edit' && editing?.events_using
                ? `Renaming changes the name on ${editing.events_using} ledger events too — the events stay, the label follows.`
                : undefined}
            />
            <TextField label="DNR permit number (optional)" size="small" value={form.dnr_permit_no}
              onChange={(e) => setForm({ ...form, dnr_permit_no: e.target.value })} />
            <TextField label="Accepts slurry" size="small" select SelectProps={{ native: true }}
              value={form.accepts_slurry}
              onChange={(e) => setForm({ ...form, accepts_slurry: e.target.value })}>
              {SLURRY.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </TextField>
          </Stack>
          {formError && <Alert severity="error" sx={{ mt: 1 }}>{formError}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialog('closed')} disabled={busy}>Cancel</Button>
          <Button variant="contained" onClick={submit} disabled={busy || !form.name.trim()}>
            {dialog === 'create' ? 'Add' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default DisposalSitesPage;
