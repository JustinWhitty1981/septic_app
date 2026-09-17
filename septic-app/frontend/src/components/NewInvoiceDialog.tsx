import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Autocomplete, Box, Button, Checkbox, Dialog, DialogActions, DialogContent,
  DialogTitle, Divider, IconButton, Stack, Table, TableBody, TableCell,
  TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import { Delete as DeleteIcon } from '@mui/icons-material';
import {
  invoiceService, messageOf, NewInvoice,
} from '../services/invoiceService';
import { payerService, PayerHit } from '../services/payerService';
import { propertyService, PropertySummary } from '../services/propertyService';
import { bidService, BidItem } from '../services/bidService';
import { ledgerService, UnbilledRow } from '../services/ledgerService';
import { usDate } from '../format';

/**
 * The invoice the office types (BIL-20).
 *
 * One dialog for both doors: the billing queue opens it with the pump-outs
 * already on the page, the invoice desk opens it blank. Same rules either
 * way — a line names the thing it charges for (a service event or a
 * price-list item; the dialog offers no "free text line" because a
 * description without a reference is what an invented charge wears), and
 * the office owns the quantity and the price while the server owns every
 * total the moment the document exists. The preview below is the office's
 * own arithmetic, shown because a clerk who cannot see the sum cannot
 * catch a typo; the invoice's answer is the database's.
 *
 * Refusals arrive as the server's sentences and stay verbatim: "Event 407
 * is already billed — invoice 3312 names it" teaches more here than any
 * paraphrase about duplicates.
 */

interface DraftLine {
  key: number;
  kind: 'event' | 'item';
  ref: string | number;
  origin: string;
  description: string;
  quantity: string;
  unitPrice: string;
  // Whether the company rate reaches this line (BIL-16). Intent only — the tax
  // is the server's, computed over the taxable lines. Defaults true: a line is
  // taxed the way every line always was, until the office says otherwise.
  taxable: boolean;
}

const money = (n: number) =>
  `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const QTY = /^\d{1,6}(\.\d{1,2})?$/;
const PRICE = /^\d{1,7}(\.\d{1,2})?$/;

const eventLine = (e: UnbilledRow, key: number): DraftLine => ({
  key, kind: 'event', ref: e.service_event_id,
  origin: `${usDate(e.service_date)} · ${e.site_address || `site #${e.property_id}`}`,
  description: `Pump-out ${usDate(e.service_date)} — ${e.site_address || `site #${e.property_id}`}`,
  quantity: '1', unitPrice: '', taxable: true,
});

const NewInvoiceDialog: React.FC<{
  onClose: () => void;
  onCreated: (inv: NewInvoice) => void;
  initialPayer?: { id: number; name: string | null } | null;
  initialSite?: { id: number; label: string } | null;
  initialEvents?: UnbilledRow[];
}> = ({ onClose, onCreated, initialPayer = null, initialSite = null, initialEvents = [] }) => {
  const keySeq = useRef(1);
  const [lines, setLines] = useState<DraftLine[]>(
    () => initialEvents.map((e) => eventLine(e, keySeq.current++)),
  );

  // Prefill arrives as a *picked* option, not as text in the box: the
  // controlled Autocomplete does not reliably keep an initial typed string
  // that matches no option, and an empty "Billed to" over a page full of
  // the customer's pump-outs is exactly the surprise the queue handoff is
  // supposed to prevent. A pick renders its label and carries the id.
  const [payerQuery, setPayerQuery] = useState('');
  const [payerPicked, setPayerPicked] = useState<PayerHit | null>(
    initialPayer ? {
      id: initialPayer.id, name: initialPayer.name,
      mailing_address: null, mailing_city: null, mailing_state: null,
      mailing_zip: null, legacy_billing_no: null, sites_owned: 0,
    } : null,
  );
  const [payerHits, setPayerHits] = useState<PayerHit[]>([]);
  const payerId = payerPicked?.id ?? null;

  const [siteQuery, setSiteQuery] = useState('');
  const [sitePicked, setSitePicked] = useState<PropertySummary | null>(
    initialSite ? {
      id: initialSite.id, site_address: initialSite.label,
      site_city: null, site_state: null, site_zip: null, county_id: null,
      legacy_cust_number: null, payer_label: null, status: 'active',
      next_service_due: null,
    } as PropertySummary : null,
  );
  const [siteHits, setSiteHits] = useState<PropertySummary[]>([]);
  const propertyId = sitePicked?.id ?? null;

  const [items, setItems] = useState<BidItem[]>([]);
  const [itemChoice, setItemChoice] = useState('');
  const [siteEvents, setSiteEvents] = useState<UnbilledRow[]>([]);
  const [settings, setSettings] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    bidService.bidItems().then((r) => setItems(r.data)).catch(() => setItems([]));
    bidService.settings().then((r) => setSettings(r.data.sales_tax_rate)).catch(() => setSettings(null));
  }, []);

  const searchPayers = useCallback(async (q: string) => {
    if (q.trim().length < 2) { setPayerHits([]); return; }
    try { setPayerHits(await payerService.search(q)); } catch { /* the picker just stays empty */ }
  }, []);

  const searchSites = useCallback(async (q: string) => {
    if (q.trim().length < 2) { setSiteHits([]); return; }
    try { setSiteHits((await propertyService.search(q)).data); } catch { /* ditto */ }
  }, []);

  // Choosing a site opens its unbilled work: the invoice desk's path from
  // "this customer" to "the pump-outs nobody has billed yet".
  useEffect(() => {
    if (propertyId === null) { setSiteEvents([]); return; }
    let live = true;
    ledgerService.unbilled({ property_id: propertyId, days: 3650, limit: 200 })
      .then((r) => { if (live) setSiteEvents(r.data); })
      .catch(() => { if (live) setSiteEvents([]); });
    return () => { live = false; };
  }, [propertyId]);

  const addLine = (l: Omit<DraftLine, 'key'>) =>
    setLines((xs) => [...xs, { ...l, key: keySeq.current++ }]);

  const addSiteEvent = (e: UnbilledRow) => {
    setLines((xs) => xs.some((x) => x.kind === 'event' && x.ref === e.service_event_id)
      ? xs : [...xs, eventLine(e, keySeq.current++)]);
    setSiteEvents((xs) => xs.filter((x) => x.service_event_id !== e.service_event_id));
  };

  const addSiteEventAll = () => {
    for (const e of siteEvents) addSiteEvent(e);
  };

  const lineReady = (l: DraftLine) =>
    l.description.trim() !== '' && QTY.test(l.quantity) && Number(l.quantity) > 0
    && PRICE.test(l.unitPrice) && Number(l.unitPrice) >= 0;

  // Per-line money, and the document's tax. Each line's own tax is rounded at
  // the line so the office can read it; the invoice's tax — the number the
  // server will stamp — is rounded ONCE over the sum of the taxable lines, so
  // the total stays exact and matches what the database computes. The per-line
  // figures are a preview; the stamp is the database's.
  const preview = useMemo(() => {
    const rate = Number(settings ?? '0');
    let sub = 0;
    let taxableBase = 0;
    const per = new Map<number, { amount: number; tax: number; total: number }>();
    for (const l of lines) {
      if (!QTY.test(l.quantity) || !PRICE.test(l.unitPrice)) continue;
      const amount = Math.round(Number(l.quantity) * Number(l.unitPrice) * 100) / 100;
      const tax = l.taxable ? Math.round(amount * rate * 100) / 100 : 0;
      per.set(l.key, { amount, tax, total: amount + tax });
      sub += amount;
      if (l.taxable) taxableBase += amount;
    }
    const tax = Math.round(taxableBase * rate * 100) / 100;
    return { sub, taxableBase, tax, rate, total: sub + tax, per };
  }, [lines, settings]);

  const ready = payerId !== null && lines.length > 0 && lines.every(lineReady);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await invoiceService.create({
        payer_id: payerId as number,
        property_id: propertyId,
        lines: lines.map((l) => (l.kind === 'event'
          ? {
            service_event_id: l.ref, description: l.description.trim(),
            quantity: l.quantity, unit_price: l.unitPrice, taxable: l.taxable,
          }
          : {
            bid_item_id: Number(l.ref), description: l.description.trim(),
            quantity: l.quantity, unit_price: l.unitPrice, taxable: l.taxable,
          })),
      });
      onCreated(r.invoice);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} maxWidth="md" fullScreen>
      <DialogTitle>New invoice</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}

          <Autocomplete
            options={payerPicked ? [payerPicked] : payerHits}
            value={payerPicked}
            getOptionLabel={(o) => [o.name ?? `payer #${o.id}`,
              [o.mailing_address,
                [o.mailing_city, o.mailing_state, o.mailing_zip].filter(Boolean).join(' ')]
                .filter(Boolean).join(', ')].filter(Boolean).join(' — ')}
            // MUI reports option selection through onInputChange too, with
            // reason 'select' — clearing the pick there means the combobox
            // forgets the person the office just chose. Only typing forgets.
            onInputChange={(_, v, reason) => {
              setPayerQuery(v);
              if (reason === 'input') { setPayerPicked(null); void searchPayers(v); }
            }}
            onChange={(_, v) => {
              setPayerPicked(v);
              if (v) setPayerQuery('');
            }}
            inputValue={payerQuery}
            filterOptions={(o) => o}
            noOptionsText={payerQuery.trim().length >= 2
              ? 'No biller matches — add them at the biller desk (Bids → New → Add biller).'
              : 'Type at least two characters'}
            renderInput={(params) => (
              <TextField {...params} label="Billed to" required
                inputProps={{ ...params.inputProps, 'aria-label': 'payer search' }} />
            )}
          />

          <Autocomplete
            options={siteHits}
            value={sitePicked}
            getOptionLabel={(o) => [o.site_address, o.site_city].filter(Boolean).join(', ')}
            onInputChange={(_, v, reason) => {
              setSiteQuery(v);
              if (reason === 'input') { setSitePicked(null); void searchSites(v); }
            }}
            onChange={(_, v) => {
              setSitePicked(v);
              if (v) setSiteQuery(v.site_address ?? '');
            }}
            inputValue={siteQuery}
            filterOptions={(o) => o}
            noOptionsText="Type at least two characters"
            renderInput={(params) => (
              <TextField {...params} label="Service site (optional)"
                helperText="Printed as the service address on the statement"
                inputProps={{ ...params.inputProps, 'aria-label': 'site search' }} />
            )}
          />

          {propertyId !== null && siteEvents.length > 0 && (
            <UnbilledAtSite rows={siteEvents} onAdd={addSiteEvent} onAddAll={addSiteEventAll} />
          )}

          <Divider />
          <Typography variant="overline">Lines</Typography>
          {lines.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              No lines yet. Add one from the price list, or pick an unbilled
              pump-out above.
            </Typography>
          )}
          {lines.map((l) => {
            const pc = preview.per.get(l.key);
            return (
              <Box key={l.key} sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <Box sx={{ flex: 2, minWidth: 220 }}>
                  <TextField
                    size="small" fullWidth value={l.description}
                    label="Description"
                    onChange={(e) => setLines((xs) => xs.map((x) =>
                      x.key === l.key ? { ...x, description: e.target.value } : x))}
                    inputProps={{ 'aria-label': `line description ${l.key}` }}
                    helperText={l.origin}
                    FormHelperTextProps={{ sx: { ml: 0 } }}
                  />
                </Box>
                <TextField
                  size="small" sx={{ width: 90 }} value={l.quantity} label="Qty"
                  onChange={(e) => setLines((xs) => xs.map((x) =>
                    x.key === l.key ? { ...x, quantity: e.target.value } : x))}
                  inputProps={{ 'aria-label': `line quantity ${l.key}` }}
                />
                <TextField
                  size="small" sx={{ width: 120 }} value={l.unitPrice} label="Unit price"
                  onChange={(e) => setLines((xs) => xs.map((x) =>
                    x.key === l.key ? { ...x, unitPrice: e.target.value } : x))}
                  inputProps={{ 'aria-label': `line unit price ${l.key}` }}
                />
                <Stack direction="row" spacing={0.25} alignItems="center" sx={{ alignSelf: 'center' }}>
                  <Checkbox size="small" checked={l.taxable}
                    onChange={(e) => setLines((xs) => xs.map((x) =>
                      x.key === l.key ? { ...x, taxable: e.target.checked } : x))}
                    inputProps={{ 'aria-label': `line taxable ${l.key}` }} />
                  <Typography variant="caption" color="text.secondary">taxable</Typography>
                </Stack>
                <Box sx={{ minWidth: 116, textAlign: 'right', alignSelf: 'center' }}>
                  <Typography variant="body2">{pc ? money(pc.amount) : '—'}</Typography>
                  {pc && l.taxable && (
                    <Typography variant="caption" color="text.secondary">
                      {money(pc.total)} w/tax
                    </Typography>
                  )}
                </Box>
                <IconButton size="small" aria-label={`remove line ${l.key}`}
                  onClick={() => setLines((xs) => xs.filter((x) => x.key !== l.key))}>
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Box>
            );
          })}

          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Autocomplete
              size="small"
              options={items}
              value={null}
              getOptionLabel={(o) => `${o.name} (${o.unit}) — $${o.unit_price}`}
              onChange={(_, v) => {
                if (v) addLine({
                  kind: 'item', ref: v.id,
                  origin: `price list · ${v.unit || 'each'}`,
                  description: v.name, quantity: '1', unitPrice: v.unit_price, taxable: true,
                });
                setItemChoice('');
              }}
              inputValue={itemChoice}
              onInputChange={(_, v) => setItemChoice(v)}
              renderInput={(params) => (
                <TextField {...params} sx={{ minWidth: 260 }}
                  label="Add price-list line…"
                  inputProps={{ ...params.inputProps, 'aria-label': 'add price-list line' }} />
              )}
            />
            <Typography variant="caption" color="text.secondary">
              Unbilled pump-outs are added from the row above or the billing queue.
            </Typography>
          </Stack>

          <Divider />
          <Box sx={{ textAlign: 'right' }}>
            <Typography variant="body2">Subtotal {money(preview.sub)}</Typography>
            <Typography variant="body2" color="text.secondary">
              Taxable {money(preview.taxableBase)}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Sales tax {preview.rate > 0 ? `${(preview.rate * 100).toFixed(2)}%` : '—'} on the taxable lines
              {' '}(zero if the payer is tax-exempt — the server decides)
            </Typography>
            <Typography variant="body1">Total {money(preview.total)}</Typography>
            <Typography variant="caption" color="text.secondary">
              Preview only — the invoice is stamped with the totals the database computes.
            </Typography>
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="contained" onClick={submit} disabled={busy || !ready}
          aria-label="create invoice">
          {busy ? 'Creating…' : `Create invoice${lines.length ? ` (${lines.length} line${lines.length === 1 ? '' : 's'})` : ''}`}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

const UnbilledAtSite: React.FC<{
  rows: UnbilledRow[]; onAdd: (e: UnbilledRow) => void; onAddAll: () => void;
}> = ({ rows, onAdd, onAddAll }) => (
  <Box>
    <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
      <Typography variant="overline">
        Unbilled work at this site ({rows.length})
      </Typography>
      {rows.length > 1 && (
        <Button size="small" onClick={onAddAll} aria-label="add all unbilled">
          Add all
        </Button>
      )}
    </Stack>
    <Table size="small">
      <TableHead>
        <TableRow>
          <TableCell>Serviced</TableCell>
          <TableCell align="right">Gallons</TableCell>
          <TableCell align="right" />
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map((e) => (
          <TableRow key={e.service_event_id}>
            <TableCell>{usDate(e.service_date)} · {e.disposal_site || '—'}</TableCell>
            <TableCell align="right">{e.gallons_pumped ?? '—'}</TableCell>
            <TableCell align="right">
              <Button size="small" onClick={() => onAdd(e)}
                aria-label={`add service ${e.service_event_id}`}>
                Add
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </Box>
);

export default NewInvoiceDialog;
