import React, { useEffect, useRef, useState } from 'react';
import {
  Box, Button, CircularProgress, Container, Divider, Paper, Stack, TextField,
  Typography, Alert,
} from '@mui/material';
import { Save as SaveIcon, Upload as UploadIcon, Delete as DeleteIcon } from '@mui/icons-material';
import { settingsService, CompanySettings, CompanyIdentity, messageOf } from '../services/settingsService';
import { uploadPhoto, messageOfCapture } from '../services/captureService';
import Letterhead from './Letterhead';

/**
 * Company settings (0027's one row). The office's tax rate and payment terms,
 * in one deliberate place.
 *
 * These were reachable before, but only as a lone field buried in the bid form
 * — which made a company-wide decision look like a per-quote one, and left no
 * surface at all for the terms an invoice has to print. They are stored once
 * (never per document) and stamp `updated_by`, so the answer to "who set 6% and
 * when" is a column, not a memory.
 *
 * Every rate is entered as the percent the clerk thinks in (5.5, 1.5) and sent
 * as a rate (0.055, 0.015); the server refuses a percent typed into a rate
 * field, and the form keeps the two from ever meeting the wrong way round.
 */

const pct = (rate: string | number): string => {
  const n = Number(rate);
  return Number.isFinite(n) ? String(Math.round(n * 10000) / 100) : '';
};
const toRate = (pctStr: string): string => {
  const n = Number(String(pctStr).trim());
  return Number.isFinite(n) ? (n / 100).toFixed(4) : '';
};

const SettingsPage: React.FC = () => {
  const [loaded, setLoaded] = useState<CompanySettings | null>(null);
  const [taxPct, setTaxPct] = useState('');
  const [days, setDays] = useState('');
  const [latePct, setLatePct] = useState('');
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [logoId, setLogoId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    settingsService.get()
      .then((s) => {
        if (!live) return;
        setLoaded(s);
        setTaxPct(pct(s.sales_tax_rate));
        setDays(String(s.payment_term_days));
        setLatePct(pct(s.late_fee_rate_monthly));
        setName(s.company_name);
        setAddress(s.address ?? '');
        setEmail(s.email ?? '');
        setPhone(s.phone ?? '');
        setLogoId(s.logo_media_id);
      })
      .catch((e) => live && setError(messageOf(e)));
    return () => { live = false; };
  }, []);

  /**
   * A logo is uploaded the moment it is chosen, not at Save: the server is the
   * only one who can say the file is a real jpeg/png/webp under the pixel cap
   * (it re-encodes every upload, DRV-16's pipeline), and learning that at Save
   * — after typing the other fields — would be the worst time to find out.
   * The row still points at the old logo until Save writes the new id.
   */
  const pickLogo = async (file: File) => {
    setUploading(true); setError(null);
    try {
      const up = await uploadPhoto(file, { caption: 'company logo' });
      setLogoId(up.id);
    } catch (e) { setError(messageOfCapture(e)); } finally { setUploading(false); }
  };

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const taxRate = toRate(taxPct);
      const lateRate = toRate(latePct);
      if (loaded && taxRate !== loaded.sales_tax_rate) await settingsService.setSalesTax(taxRate);
      const daysN = Number(String(days).trim());
      if (!Number.isInteger(daysN) || daysN < 0 || daysN > 365) throw new Error('Net days must be a whole number 0–365');
      if (!/^\d*\.?\d{0,4}$/.test(lateRate.replace(/^\./, '0.'))) throw new Error('Late fee takes at most 4 decimal places');
      let updated = await settingsService.setPaymentTerms(daysN, lateRate);
      // Only what actually changed goes to the server, so a sibling field this
      // screen did not touch is never overwritten by a stale read of it.
      const identity: CompanyIdentity = {};
      if (name.trim() !== loaded?.company_name) identity.company_name = name.trim();
      if (address.trim() !== (loaded?.address ?? '')) identity.address = address.trim();
      if (email.trim() !== (loaded?.email ?? '')) identity.email = email.trim();
      if (phone.trim() !== (loaded?.phone ?? '')) identity.phone = phone.trim();
      if (logoId !== (loaded?.logo_media_id ?? null)) identity.logo_media_id = logoId;
      if (Object.keys(identity).length) updated = await settingsService.setCompany(identity);
      setLoaded(updated); setSavedAt(new Date().toLocaleString());
    } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  };

  if (!loaded && !error) return <Box sx={{ textAlign: 'center', py: 6 }}><CircularProgress /></Box>;

  return (
    <Container maxWidth="sm">
      <Typography variant="h5" gutterBottom>Company settings</Typography>
      <Typography color="text.secondary" sx={{ mb: 2 }}>
        These are company-wide decisions — set once here, not retyped on each form. Changing
        the rate does not reach anything already signed; bids and invoices keep the value they
        were made with.
      </Typography>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {savedAt && <Alert severity="success" sx={{ mb: 2 }}>Saved.</Alert>}

      <Paper sx={{ p: 3 }}>
        <Stack spacing={2.5}>
          <Box>
            <Typography variant="subtitle2">Sales tax rate (%)</Typography>
            <TextField fullWidth size="small" value={taxPct}
              onChange={(e) => setTaxPct(e.target.value)}
              inputProps={{ inputMode: 'decimal' }} placeholder="5.5"
              helperText="Type the percent, e.g. 5.5 for 5½%. Stored as a rate (0.0550)." />
          </Box>
          <Box>
            <Typography variant="subtitle2">Payment terms — net days</Typography>
            <TextField fullWidth size="small" value={days}
              onChange={(e) => setDays(e.target.value)}
              inputProps={{ inputMode: 'numeric' }} placeholder="30"
              helperText="Days from the invoice date until payment is due. 0 means due on receipt." />
          </Box>
          <Box>
            <Typography variant="subtitle2">Late fee (% per month)</Typography>
            <TextField fullWidth size="small" value={latePct}
              onChange={(e) => setLatePct(e.target.value)}
              inputProps={{ inputMode: 'decimal' }} placeholder="1.5"
              helperText="Charged on past-due invoices. Type 1.5 for 1.5% a month (0.0150)." />
          </Box>

          <Divider />
          <Box>
            <Typography variant="subtitle1" gutterBottom>
              Letterhead — printed on every invoice and bid
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              The identity the papers carry. It used to be two hardcoded names that disagreed
              with each other and no way to call about the bill — the office decides it once here.
            </Typography>

            <Box sx={{ border: '1px solid', borderColor: 'divider', p: 2, mb: 2 }}>
              <Typography variant="caption" color="text.secondary">Printed header preview</Typography>
              <Letterhead settings={{
                ...loaded!,
                company_name: name,
                logo_media_id: logoId,
                address: address.trim() || null,
                email: email.trim() || null,
                phone: phone.trim() || null,
              }} />
            </Box>

            <Stack spacing={2.5}>
              <Box>
                <Typography variant="subtitle2">Company name</Typography>
                <TextField fullWidth size="small" value={name}
                  onChange={(e) => setName(e.target.value)}
                  helperText="The heading on every printed document. Cannot be blank." />
              </Box>
              <Box>
                <Typography variant="subtitle2">Logo</Typography>
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                  <input
                    ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void pickLogo(f);
                      e.target.value = '';
                    }}
                  />
                  <Button size="small" startIcon={<UploadIcon />}
                    onClick={() => fileInput.current?.click()} disabled={uploading}>
                    {uploading ? 'Uploading…' : (logoId ? 'Replace logo' : 'Upload logo')}
                  </Button>
                  {logoId !== null && (
                    <Button size="small" color="error" startIcon={<DeleteIcon />}
                      onClick={() => setLogoId(null)}>Remove</Button>
                  )}
                </Box>
                <Typography variant="caption" color="text.secondary">
                  jpeg, png or webp, up to 3 megapixels. Uploaded like a field photo;
                  stored once, referenced by this setting.
                </Typography>
              </Box>
              <Box>
                <Typography variant="subtitle2">Address</Typography>
                <TextField fullWidth size="small" value={address}
                  onChange={(e) => setAddress(e.target.value)} placeholder="123 Main St, Elkhart, IN"
                  helperText="Printed in the letterhead. Blank prints nothing." />
              </Box>
              <Box>
                <Typography variant="subtitle2">Email</Typography>
                <TextField fullWidth size="small" value={email} type="email"
                  onChange={(e) => setEmail(e.target.value)} placeholder="office@example.com"
                  inputProps={{ autoComplete: 'off' }}
                  helperText="Printed in the letterhead. Blank prints nothing." />
              </Box>
              <Box>
                <Typography variant="subtitle2">Phone</Typography>
                <TextField fullWidth size="small" value={phone}
                  onChange={(e) => setPhone(e.target.value)} placeholder="(574) 555-0100"
                  helperText="The number the statement footer invites the customer to call." />
              </Box>
            </Stack>
          </Box>

          <Box sx={{ pt: 1 }}>
            <Button variant="contained" startIcon={<SaveIcon />} onClick={save} disabled={busy}>
              {busy ? 'Saving…' : 'Save settings'}
            </Button>
            {loaded?.updated_by && (
              <Typography variant="caption" color="text.secondary" sx={{ ml: 2 }}>
                Last set by {loaded.updated_by}
                {loaded.updated_at ? ` · ${new Date(loaded.updated_at).toLocaleDateString()}` : ''}
              </Typography>
            )}
          </Box>
        </Stack>
      </Paper>
    </Container>
  );
};

export default SettingsPage;
