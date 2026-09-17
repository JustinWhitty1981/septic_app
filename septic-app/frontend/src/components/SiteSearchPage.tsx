import React, { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, TextField, List, ListItemButton, ListItemText, Typography, Alert, CircularProgress,
  Button, Stack, Dialog, DialogTitle, DialogContent, DialogActions,
} from '@mui/material';
import { propertyService, PropertySummary } from '../services/propertyService';
import { messageOf } from '../services/ledgerService';
import { authService } from '../services/authService';

/**
 * Site search, and the front door for a new customer (SCH-11).
 *
 * Searches three things and says so on the screen, because the choice is not
 * arbitrary: the address on the tank lid, the name on the bill, and the
 * number a crew says on the radio. A search box that only matched addresses
 * would make a third of these sites unfindable to the people who know them by
 * number.
 *
 * Two characters minimum, with one exception the server makes too: a one- or
 * two-digit query is read as a customer number and matched exactly. '2' is a
 * real site. '%2%' is half the street numbers in the county.
 *
 * "Add a site" is office-gated in both senses: the button only renders for
 * office roles, and the server refuses everyone else — the menu hides a
 * screen, only the gate keeps it. The dialog asks for one required thing,
 * the address, because the server does: everything else on a new site arrives
 * with the paperwork, and a blank that is honest about being blank beats one
 * guessed at the counter.
 */

const emptyForm = {
  site_address: '', site_city: '', site_state: '', site_zip: '',
  payer_label: '', legacy_cust_number: '', service_interval_days: '1095',
};

const SiteSearchPage: React.FC = () => {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<PropertySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isOffice = authService.hasRole(['admin', 'manager', 'office']);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const run = useCallback(async (term: string) => {
    const trimmed = term.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const res = await propertyService.search(trimmed);
      setRows(res.data);
    } catch (e) {
      setError(messageOf(e));
      setRows(null);
    } finally {
      setBusy(false);
    }
  }, []);

  const submitAdd = async () => {
    setAddBusy(true);
    setAddError(null);
    try {
      const created = await propertyService.create({
        site_address: form.site_address.trim(),
        site_city: form.site_city.trim() || null,
        site_state: form.site_state.trim() || null,
        site_zip: form.site_zip.trim() || null,
        payer_label: form.payer_label.trim() || null,
        legacy_cust_number: form.legacy_cust_number.trim()
          ? Number(form.legacy_cust_number.trim()) : undefined,
        service_interval_days: Number(form.service_interval_days) || undefined,
      });
      // Straight to the new site: the next thing the office does after adding
      // one is check what it looks like, and the detail page is the truth.
      navigate(`/properties/${created.id}`);
    } catch (e) {
      // A 409 names the customer number already in the file; a 400 names the
      // field that refused. Both are worth showing where they were typed.
      setAddError(messageOf(e));
    } finally {
      setAddBusy(false);
    }
  };

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mb: 1 }}>
        <Typography variant="h4" gutterBottom>Find a site</Typography>
        {isOffice && <Button variant="contained" onClick={() => setAdding(true)}>Add a site</Button>}
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Address, city, name on the bill, or the legacy customer number.
      </Typography>

      <TextField
        autoFocus
        fullWidth
        size="small"
        label="Search"
        placeholder="N8727 County Road C, Fond du Lac, or 3494"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') run(q);
        }}
        sx={{ maxWidth: 560, mb: 2 }}
      />

      {busy && <CircularProgress size={22} />}

      {error && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {error}
        </Alert>
      )}

      {rows && !busy && (
        <>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {rows.length === 0
              ? 'No site matches that.'
              : `${rows.length} site${rows.length === 1 ? '' : 's'}. A number under two digits is matched exactly, so an empty result means the number is not in the file.`}
          </Typography>
          <List dense>
            {rows.map((r) => (
              <ListItemButton
                key={r.id}
                onClick={() => navigate(`/properties/${r.id}`)}
                divider
              >
                <ListItemText
                  primary={
                    `${r.site_address || 'no address on file'}` +
                    `${r.site_city ? `, ${r.site_city}` : ''}`
                  }
                  secondary={
                    `cust #${r.legacy_cust_number ?? '—'} · ${r.payer_label || 'no payer label'}` +
                    ` · next due ${r.next_service_due || 'unknown'}`
                  }
                />
              </ListItemButton>
            ))}
          </List>
        </>
      )}

      <Dialog open={adding} onClose={() => !addBusy && setAdding(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Add a site</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            A new site starts with no service history, so it has no due date —
            the first pump-out files that, and the arithmetic follows it.
          </Typography>
          <Stack spacing={1}>
            <TextField label="Site address" size="small" required value={form.site_address}
              onChange={(e) => setForm({ ...form, site_address: e.target.value })} />
            <Stack direction="row" spacing={1}>
              <TextField label="City" size="small" value={form.site_city}
                onChange={(e) => setForm({ ...form, site_city: e.target.value })} />
              <TextField label="State" size="small" inputProps={{ maxLength: 2 }} value={form.site_state}
                onChange={(e) => setForm({ ...form, site_state: e.target.value })} />
              <TextField label="ZIP" size="small" inputProps={{ maxLength: 10 }} value={form.site_zip}
                onChange={(e) => setForm({ ...form, site_zip: e.target.value })} />
            </Stack>
            <TextField label="Name on the bill (payer label)" size="small" value={form.payer_label}
              onChange={(e) => setForm({ ...form, payer_label: e.target.value })} />
            <Stack direction="row" spacing={1}>
              <TextField label="Legacy customer number" size="small" value={form.legacy_cust_number}
                inputProps={{ inputMode: 'numeric' }}
                helperText="optional — the number crews radio"
                onChange={(e) => setForm({ ...form, legacy_cust_number: e.target.value })} />
              <TextField label="Service interval (days)" size="small" value={form.service_interval_days}
                inputProps={{ inputMode: 'numeric' }}
                onChange={(e) => setForm({ ...form, service_interval_days: e.target.value })} />
            </Stack>
          </Stack>
          {addError && <Alert severity="error" sx={{ mt: 1 }}>{addError}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAdding(false)} disabled={addBusy}>Cancel</Button>
          <Button variant="contained" onClick={submitAdd}
            disabled={addBusy || !form.site_address.trim()}>
            Add site
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default SiteSearchPage;
