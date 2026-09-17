import React, { useCallback, useEffect, useState } from 'react';
import { usDate } from '../format';
import { SortHeader, useClientSort } from '../sort';
import { useNavigate } from 'react-router-dom';
import {
  Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle,
  Stack, Table, TableBody, TableCell, TableContainer, TableHead,
  TableRow, TextField, Typography, Autocomplete,
} from '@mui/material';
import { Add as AddIcon, Print as PrintIcon } from '@mui/icons-material';
import {
  bidService, BidSummary, BidItem,
} from '../services/bidService';
import { authService } from '../services/authService';
import { payerService, PayerHit } from '../services/payerService';
import { propertyService, PropertySummary } from '../services/propertyService';
import { messageOf } from '../services/ledgerService';

/**
 * The bids desk (BIL-10/16): every quote the office has made, and the two
 * knobs the desk is made of — who and how much.
 *
 * The sales-tax field lives up here because it is a property of the company,
 * not of a bid: one number, set once, stamped onto each bid at approval
 * (BIL-16). It is displayed as the percent a human thinks in and sent as the
 * decimal the CHECK demands — the conversion is division the clerk should
 * never have to do, and the server refuses anything between 100 and reality.
 */

const money = (n: string | number | null | undefined) =>
  n == null ? '—' : `$${Number(n).toLocaleString(undefined, {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;

const STATUS_TONE: Record<string, 'default' | 'success' | 'error' | 'info'> = {
  draft: 'default', approved: 'success', declined: 'error', invoiced: 'info',
};

const BidsPage: React.FC = () => {
  const navigate = useNavigate();
  const isOffice = authService.hasRole(['admin', 'manager', 'office']);
  const [rows, setRows] = useState<BidSummary[]>([]);
  const sorter = useClientSort<BidSummary>(rows, {
    id: (r) => r.id, date: (r) => r.bid_date, payer: (r) => r.payer_name,
    site: (r) => r.site_address, status: (r) => r.status, total: (r) => Number(r.total),
  }, 'date', 'desc');
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [rate, setRate] = useState<string | null>(null);
  const [rateDraft, setRateDraft] = useState('');
  const [rateBusy, setRateBusy] = useState(false);

  const [open, setOpen] = useState(false);
  const [payerQuery, setPayerQuery] = useState('');
  const [payerHits, setPayerHits] = useState<PayerHit[]>([]);
  const [payerPicked, setPayerPicked] = useState<PayerHit | null>(null);
  const [siteQuery, setSiteQuery] = useState('');
  const [siteHits, setSiteHits] = useState<PropertySummary[]>([]);
  const [sitePicked, setSitePicked] = useState<PropertySummary | null>(null);
  const [notes, setNotes] = useState('');
  const [creating, setCreating] = useState(false);
  const [makeBiller, setMakeBiller] = useState(false);
  const [billerForm, setBillerForm] = useState({ org_name: '', first_name: '',
    last_name: '', mailing_address: '', mailing_city: '', mailing_state: '',
    mailing_zip: '' });
  const [makeSite, setMakeSite] = useState(false);
  const [siteForm, setSiteForm] = useState({ site_address: '', site_city: '',
    site_state: '', site_zip: '' });

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [{ data }, settings] = await Promise.all([
        bidService.bids(status || undefined),
        bidService.settings().catch(() => ({ data: null })),
      ]);
      setRows(data);
      if (settings.data) {
        setRate(settings.data.sales_tax_rate);
        setRateDraft((Number(settings.data.sales_tax_rate) * 100)
          .toLocaleString(undefined, { maximumFractionDigits: 3 }));
      }
    } catch (e) {
      setLoadError(messageOf(e));
    }
  }, [status]);

  useEffect(() => { void load(); }, [load]);

  const saveRate = async () => {
    setRateBusy(true);
    setError(null);
    try {
      const updated = await bidService.setSalesTax(rateDraft);
      setRate(updated.sales_tax_rate);
      setRateDraft((Number(updated.sales_tax_rate) * 100)
        .toLocaleString(undefined, { maximumFractionDigits: 3 }));
      void load(); // every draft bid's estimate just moved; re-read them
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setRateBusy(false);
    }
  };

  const searchPayers = useCallback(async (q: string) => {
    if (q.trim().length < 2) { setPayerHits([]); return; }
    try { setPayerHits(await payerService.search(q)); }
    catch (e) { setError(messageOf(e)); }
  }, []);

  const searchSites = useCallback(async (q: string) => {
    if (q.trim().length < 2) { setSiteHits([]); return; }
    try { setSiteHits((await propertyService.search(q)).data); }
    catch (e) { setError(messageOf(e)); }
  }, []);

  const createBillerAndPick = async () => {
    setCreating(true);
    setError(null);
    try {
      const t = (k: keyof typeof billerForm) => billerForm[k].trim();
      const created = await payerService.create({
        org_name: t('org_name') || null, first_name: t('first_name') || null,
        last_name: t('last_name') || null, mailing_address: t('mailing_address') || null,
        mailing_city: t('mailing_city') || null, mailing_state: t('mailing_state') || null,
        mailing_zip: t('mailing_zip') || null, phone: null,
      });
      setPayerHits((hits) => [created, ...hits]);
      setPayerPicked(created);
      setPayerQuery(created.name ?? '');
      setMakeBiller(false);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setCreating(false);
    }
  };

  const createSiteAndPick = async () => {
    setCreating(true);
    setError(null);
    try {
      const t = (k: keyof typeof siteForm) => siteForm[k].trim();
      // The server owns the rest of the row — service interval defaults, the
      // due-date arithmetic, the status. This form asks only what SCH-11
      // makes required, plus the town the mail needs; a legacy customer
      // number is absent on purpose: a site being bid for is not in the
      // 61 years of ledgers, and inventing one is inventing history.
      const created = await propertyService.create({
        site_address: t('site_address'),
        site_city: t('site_city') || undefined,
        site_state: t('site_state') || undefined,
        site_zip: t('site_zip') || undefined,
      });
      setSiteHits((hits) => [created, ...hits]);
      setSitePicked(created);
      setSiteQuery(created.site_address ?? t('site_address'));
      setMakeSite(false);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setCreating(false);
    }
  };

  const createBid = async () => {
    if (!payerPicked) return;
    setCreating(true);
    setError(null);
    try {
      const { data } = await bidService.createBid({
        payer_id: payerPicked.id,
        property_id: sitePicked?.id ?? null,
        notes: notes.trim() || undefined,
      });
      setOpen(false);
      navigate(`/bids/${data.id}`);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setCreating(false);
    }
  };

  const pct = (r: string | null) =>
    r == null ? '—' : `${(Number(r) * 100).toLocaleString(undefined,
      { maximumFractionDigits: 3 })}%`;

  return (
    <Box>
      <Stack direction="row" alignItems="center" justifyContent="space-between"
        spacing={1} sx={{ mb: 1, flexWrap: 'wrap' }}>
        <Typography variant="h5">Bids</Typography>
        {isOffice && (
          <Button variant="contained" startIcon={<AddIcon />} aria-label="new bid"
            onClick={() => { setOpen(true); setError(null); }}>
            New bid
          </Button>
        )}
      </Stack>

      {isOffice && (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="body2" color="text.secondary">
            Sales tax: {pct(rate)}
          </Typography>
          <TextField size="small" label="Set %" value={rateDraft}
            sx={{ width: 110 }} inputProps={{ 'aria-label': 'sales tax percent' }}
            onChange={(e) => setRateDraft(e.target.value)} />
          <Button size="small" onClick={saveRate}
            disabled={rateBusy || rateDraft.trim() === ''}
            aria-label="save sales tax">
            Save
          </Button>
        </Stack>
      )}

      <Stack direction="row" spacing={1} sx={{ mb: 1.5 }}>
        {['', 'draft', 'approved', 'declined', 'invoiced'].map((s) => (
          <Chip key={s || 'all'} size="small"
            label={s || 'all'} variant={status === s ? 'filled' : 'outlined'}
            onClick={() => setStatus(s)} aria-label={`filter ${s || 'all'}`} />
        ))}
      </Stack>

      {loadError && <Alert severity="error" sx={{ mb: 1 }}>{loadError}</Alert>}
      {error && <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert>}

      <TableContainer component={Table}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <SortHeader label="Bid" field="id" sort={sorter.sort} onSort={sorter.onSort} />
              <SortHeader label="Date" field="date" sort={sorter.sort} onSort={sorter.onSort} />
              <SortHeader label="Payer" field="payer" sort={sorter.sort} onSort={sorter.onSort} />
              <SortHeader label="Site" field="site" sort={sorter.sort} onSort={sorter.onSort} />
              <SortHeader label="Status" field="status" sort={sorter.sort} onSort={sorter.onSort} />
              <SortHeader label="Total" field="total" sort={sorter.sort} onSort={sorter.onSort} align="right" />
              <TableCell aria-label="actions" />
            </TableRow>
          </TableHead>
          <TableBody>
            {sorter.sorted.map((r) => (
              <TableRow key={r.id} hover sx={{ cursor: 'pointer' }}
                onClick={() => navigate(`/bids/${r.id}`)}>
                <TableCell>{r.id}</TableCell>
                <TableCell>{usDate(r.bid_date)}</TableCell>
                <TableCell>{r.payer_name}</TableCell>
                <TableCell>{r.site_address ?? '—'}</TableCell>
                <TableCell>
                  <Chip size="small" label={r.status}
                    color={STATUS_TONE[r.status] === 'default' ? 'default'
                      : STATUS_TONE[r.status]} variant="outlined" />
                </TableCell>
                <TableCell align="right">
                  {money(r.total)}
                  {r.tax_estimated && r.status === 'draft'
                    ? ` ${'(tax est.)'}` : ''}
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <Button size="small" aria-label={`print bid ${r.id}`}
                    startIcon={<PrintIcon />}
                    onClick={() => navigate(`/bids/${r.id}/print`)}>
                    Print
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {!rows.length && (
              <TableRow><TableCell colSpan={7}>No bids here yet.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>

      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="sm" fullScreen>
        <DialogTitle>New bid</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} sx={{ mt: 1, minWidth: 320 }}>
            <Typography variant="body2" color="text.secondary">
              A bid is addressed to somebody: it is a document, and documents
              carry names. A customer the search cannot find is a biller form
              away.
            </Typography>
            {makeSite ? (
              <>
                <Button size="small" onClick={() => setMakeSite(false)}>← back to search</Button>
                <Typography variant="body2" color="text.secondary">
                  A brand-new site: the bid names where the work happens. Who owns
                  it is the site page's to record, not this dialog's to invent.
                </Typography>
                <TextField label="Site address" size="small"
                  value={siteForm.site_address}
                  onChange={(e) => setSiteForm({ ...siteForm, site_address: e.target.value })} />
                <Stack direction="row" spacing={1}>
                  <TextField label="City" size="small" value={siteForm.site_city}
                    onChange={(e) => setSiteForm({ ...siteForm, site_city: e.target.value })} />
                  <TextField label="State" size="small" inputProps={{ maxLength: 2 }}
                    value={siteForm.site_state}
                    onChange={(e) => setSiteForm({ ...siteForm, site_state: e.target.value })} />
                  <TextField label="ZIP" size="small" inputProps={{ maxLength: 10 }}
                    value={siteForm.site_zip}
                    onChange={(e) => setSiteForm({ ...siteForm, site_zip: e.target.value })} />
                </Stack>
              </>
            ) : !makeBiller ? (
              <>
                <Autocomplete
                  options={payerHits}
                  value={payerPicked}
                  // The mailing address rides on the label, not below it: a
                  // biller whose stored org happens to read like a shrug is
                  // still recognisable by where the statement would go —
                  // which is how the office found him the day the name was
                  // "None" and the picker showed only the name.
                  getOptionLabel={(o) => [o.name ?? `payer #${o.id}`,
                    [o.mailing_address,
                      [o.mailing_city, o.mailing_state, o.mailing_zip]
                        .filter(Boolean).join(' ')].filter(Boolean).join(', ')]
                    .filter(Boolean).join(' — ')}
                  onInputChange={(_, v) => { setPayerQuery(v); void searchPayers(v); }}
                  onChange={(_, v) => setPayerPicked(v)}
                  inputValue={payerQuery}
                  filterOptions={(o) => o}
                  noOptionsText={payerQuery.trim().length >= 2 ? (
                    <Stack alignItems="center" spacing={1} sx={{ py: 1 }}>
                      <Typography variant="body2">
                        No biller named “{payerQuery.trim()}” exists yet.
                      </Typography>
                      <Button size="small" variant="outlined" onClick={() => setMakeBiller(true)}>
                        Add “{payerQuery.trim()}” as a new biller
                      </Button>
                    </Stack>
                  ) : 'Type at least two characters'}
                  renderInput={(params) => (
                    <TextField {...params} label="Payer"
                      inputProps={{ ...params.inputProps, 'aria-label': 'payer search' }} />
                  )}
                />
                <Autocomplete
                  options={siteHits}
                  value={sitePicked}
                  getOptionLabel={(o) => o.site_address ?? `site #${o.id}`}
                  onInputChange={(_, v) => { setSiteQuery(v); void searchSites(v); }}
                  onChange={(_, v) => setSitePicked(v)}
                  inputValue={siteQuery}
                  filterOptions={(o) => o}
                  // The empty result is a door, not a wall — the new-
                  // construction bid exists precisely because the site is
                  // not in the ledger yet (BIL-18). Typing finds; this
                  // button creates.
                  noOptionsText={siteQuery.trim().length >= 2 ? (
                    <Stack alignItems="center" spacing={1} sx={{ py: 1 }}>
                      <Typography variant="body2">
                        No site at “{siteQuery.trim()}” exists yet.
                      </Typography>
                      <Button size="small" variant="outlined"
                        onClick={() => {
                          setSiteForm({ ...siteForm, site_address: siteQuery.trim() });
                          setMakeSite(true);
                        }}>
                        Add “{siteQuery.trim()}” as a new site
                      </Button>
                    </Stack>
                  ) : 'Type at least two characters'}
                  renderInput={(params) => (
                    <TextField {...params} label="Site (optional)"
                      inputProps={{ ...params.inputProps, 'aria-label': 'site search' }} />
                  )}
                />
                <TextField label="Notes for the bid (optional)" multiline minRows={2}
                  value={notes} onChange={(e) => setNotes(e.target.value)} />
              </>
            ) : (
              <>
                <Button size="small" onClick={() => setMakeBiller(false)}>← back to search</Button>
                <TextField label="Organization (optional)" size="small"
                  value={billerForm.org_name}
                  onChange={(e) => setBillerForm({ ...billerForm, org_name: e.target.value })} />
                <Stack direction="row" spacing={1}>
                  <TextField label="First name" size="small" value={billerForm.first_name}
                    onChange={(e) => setBillerForm({ ...billerForm, first_name: e.target.value })} />
                  <TextField label="Last name" size="small" value={billerForm.last_name}
                    onChange={(e) => setBillerForm({ ...billerForm, last_name: e.target.value })} />
                </Stack>
                <TextField label="Mailing address" size="small"
                  value={billerForm.mailing_address}
                  onChange={(e) => setBillerForm({ ...billerForm, mailing_address: e.target.value })} />
                <Stack direction="row" spacing={1}>
                  <TextField label="City" size="small" value={billerForm.mailing_city}
                    onChange={(e) => setBillerForm({ ...billerForm, mailing_city: e.target.value })} />
                  <TextField label="State" size="small" inputProps={{ maxLength: 2 }}
                    value={billerForm.mailing_state}
                    onChange={(e) => setBillerForm({ ...billerForm, mailing_state: e.target.value })} />
                  <TextField label="ZIP" size="small" inputProps={{ maxLength: 10 }}
                    value={billerForm.mailing_zip}
                    onChange={(e) => setBillerForm({ ...billerForm, mailing_zip: e.target.value })} />
                </Stack>
              </>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)} disabled={creating}>Cancel</Button>
          {makeSite ? (
            <Button onClick={createSiteAndPick}
              disabled={creating || !siteForm.site_address.trim()}
              aria-label="create site">
              Create site
            </Button>
          ) : makeBiller ? (
            <Button onClick={createBillerAndPick}
              disabled={creating
                || !(billerForm.org_name.trim() || billerForm.first_name.trim()
                     || billerForm.last_name.trim())}>
              Create biller
            </Button>
          ) : (
            <Button variant="contained" onClick={createBid}
              disabled={creating || !payerPicked} aria-label="create bid">
              Open the draft
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default BidsPage;
