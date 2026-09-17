import React, { useCallback, useEffect, useState } from 'react';
import { usDate } from '../format';
import {
  Box, Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Typography, Alert, Paper, Chip, Divider, Skeleton, Stack, ToggleButton, ToggleButtonGroup,
  Button, IconButton, Dialog, DialogTitle, DialogContent, DialogActions,
  TextField, Tooltip, MenuItem,
} from '@mui/material';
import { Edit as AdjustIcon, Payment as PayIcon, Print as PrintIcon } from '@mui/icons-material';
import { Link, useSearchParams } from 'react-router-dom';
import { SortHeader, nextSort, SortState } from '../sort';
import NewInvoiceDialog from './NewInvoiceDialog';
import {
  invoiceService, InvoiceRow, InvoiceDetail, Meta,
} from '../services/invoiceService';
import { messageOf } from '../services/ledgerService';
import { authService } from '../services/authService';

/**
 * The invoice book (BIL-01/05's surface).
 *
 * The page exists so that BIL-05's rule is usable, not just enforceable: a
 * correction you cannot find the invoice for is a correction nobody files.
 * The adjustment dialog therefore opens on the *original* — its lines, its
 * total, its chain badge — and the new document is built from the original's
 * own lines. That is deliberate. The 3,120 orphaned line items (BIL-03) were
 * typed freehand against no header at all, and a dialog that let you invent a
 * description column would be the same abandoned subform with a nicer theme.
 *
 * Lines referencing neither a service event nor a legacy product code are
 * refused by the server (the 0021 CHECK); this screen pre-refuses them in the
 * same words, so the rule is heard before the request rather than as a red
 * dialog afterwards.
 */

const STATUSES = [
  { value: '', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'partial', label: 'Partial' },
  { value: 'paid', label: 'Paid' },
  { value: 'void', label: 'Void' },
];

const PAGE_SIZE = 50;
const money = (n: string | number | null) =>
  n == null ? '—' : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const QTY_OK = /^\d{1,6}(\.\d{1,2})?$/;

const InvoicesPage: React.FC = () => {
  const [rows, setRows] = useState<InvoiceRow[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [searchParams] = useSearchParams();
  const payerFilter = Number(searchParams.get('payer')) || null;

  const [paying, setPaying] = useState(false);
  const [payForm, setPayForm] = useState({ amount: '', method: 'check', reference: '', note: '' });
  const [payBusy, setPayBusy] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [payUuid, setPayUuid] = useState<string | null>(null);

  const [correcting, setCorrecting] = useState(false);
  // One entry per original line, holding the *corrected* quantity and unit price the
  // desk is filing. A line joins the adjustment only when qty × price stops matching
  // what was charged — so touching nothing files nothing, and crediting a whole line
  // back is just a corrected quantity of 0. The reference rides from the original to
  // the server untouched (BIL-01); the 3,120 orphaned rows of BIL-03 were free-text
  // lines, and this shape makes inventing one impossible.
  const [edits, setEdits] = useState<Record<string, { qty: string; price: string }>>({});
  const [adjustReason, setAdjustReason] = useState('');
  const [adjustBusy, setAdjustBusy] = useState(false);
  const [adjustError, setAdjustError] = useState<string | null>(null);

  const canAdjust = authService.hasRole(['admin', 'manager', 'office']);

  // Server-side: the book is thousands of rows a page at a time, so the
  // sort belongs in the query that slices it. Newest-first is the desk's
  // default; amount and name are how a disputed invoice gets found.
  const [sort, setSort] = useState<SortState>({ field: 'date', dir: 'desc' });
  const [creating, setCreating] = useState(false);
  const [createdNote, setCreatedNote] = useState<string | null>(null);
  const onSort = useCallback((field: string) => {
    setSort((s) => nextSort(s, field));
    setPage(1);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await invoiceService.list({
        status: status || null, payerId: payerFilter, page, limit: PAGE_SIZE,
        sort: sort.field, dir: sort.dir,
      });
      setRows(res.data);
      setMeta(res.meta || null);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setLoading(false);
    }
  }, [status, page, payerFilter, sort]);

  useEffect(() => { load(); }, [load]);

  const openDetail = async (id: number) => {
    setError(null);
    setCorrecting(false);
    try {
      setDetail(await invoiceService.get(id));
    } catch (e) {
      setError(messageOf(e));
      setDetail(null);
    }
  };

  // The form opens on the original's own charged values. Prefilling them means the
  // only way a line ends up in the adjustment is for the desk to move its corrected
  // qty or price off the number it was billed at — a keystroke that lands back on the
  // original value files nothing, and the reference travels to the server untouched.
  const startAdjust = (d: InvoiceDetail) => {
    const seed: Record<string, { qty: string; price: string }> = {};
    for (const l of d.lines) seed[String(l.id)] = { qty: l.quantity, price: l.unit_price };
    setEdits(seed);
    setAdjustReason('');
    setAdjustError(null);
    setCorrecting(true);
  };

  const startPay = (d: InvoiceDetail) => {
    setPayForm({
      amount: (Number(d.total) - Number(d.amount_paid)).toFixed(2),
      method: 'check', reference: '', note: '',
    });
    setPayUuid(null);
    setPayError(null);
    setPaying(true);
  };

  const submitPay = async () => {
    setPayBusy(true);
    setPayError(null);
    // One uuid for this attempt at this receipt; reused if the send fails and
    // the clerk presses the button again (DRV-13's rule, office edition).
    const uuid = payUuid ?? (globalThis.crypto?.randomUUID?.()
      ?? 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      }));
    setPayUuid(uuid);
    try {
      await invoiceService.pay(detail!.id, {
        amount: Number(payForm.amount),
        method: payForm.method || undefined,
        reference: payForm.reference || undefined,
        note: payForm.note || undefined,
        client_uuid: uuid,
      });
      setPaying(false);
      setDetail(null);
      await load();
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } };
      setPayError(err.response?.data?.error
        || (e instanceof Error ? e.message : 'Payment failed'));
    } finally {
      setPayBusy(false);
    }
  };

  // What the correction files: for each line whose corrected qty × price no longer
  // matches what was charged, ONE signed line for the difference, carrying the
  // original's reference. Correcting a 1 × $250 line to 1 × $200 therefore posts −$50
  // — not a credit of the whole line — and a line left at its charged values contributes
  // nothing (a zero difference is dropped, not filed as a $0 line). A corrected
  // quantity of 0 is the whole credit; the server re-prices and re-adds from these.
  const cents = (n: number) => Math.round(n * 100);
  const lineDelta = (l: InvoiceDetail['lines'][number])
    : { edited: boolean; invalid: boolean; delta: number } => {
    const e = edits[String(l.id)];
    if (!e) return { edited: false, invalid: false, delta: 0 };
    if (!QTY_OK.test(e.qty.trim()) || !QTY_OK.test(e.price.trim())) {
      return { edited: false, invalid: true, delta: 0 };
    }
    // Compared in whole cents so float noise (0.1 + 0.2) cannot make a line look edited.
    const delta = cents(Number(e.qty) * Number(e.price))
      - cents(Number(l.quantity) * Number(l.unit_price || 0));
    return { edited: delta !== 0, invalid: false, delta: delta / 100 };
  };
  const buildAdjustmentLines = () => (detail?.lines ?? [])
    .map((l) => ({ l, d: lineDelta(l) }))
    .filter(({ d }) => d.edited)
    .map(({ l, d }) => ({
      service_event_id: l.service_event_id ? Number(l.service_event_id) : undefined,
      legacy_product_code: l.legacy_product_code ?? undefined,
      service_type_id: l.service_type_id ?? undefined,
      description: l.description ?? undefined,
      quantity: 1,
      unit_price: d.delta,
    }));
  const editedLines = (detail?.lines ?? []).filter((l) => lineDelta(l).edited);
  const invalidLine = (detail?.lines ?? []).some((l) => lineDelta(l).invalid);
  const adjustmentTotal = cents(editedLines.reduce((a, l) => a + lineDelta(l).delta, 0)) / 100;
  const currentBalance = detail ? Number(detail.total) - Number(detail.amount_paid) : 0;
  const resultingBalance = Math.round((currentBalance + adjustmentTotal) * 100) / 100;
  const canFileAdjust = !!detail && adjustReason.trim() !== ''
    && editedLines.length > 0 && !invalidLine;

  const submitAdjust = async () => {
    const lines = buildAdjustmentLines();
    if (!canFileAdjust || !lines.length) return;
    setAdjustBusy(true);
    setAdjustError(null);
    try {
      await invoiceService.adjust(detail!.id, lines, adjustReason.trim());
      setCorrecting(false);
      setDetail(null);
      await load();
    } catch (e: any) {
      setAdjustError(messageOf(e));
    } finally {
      setAdjustBusy(false);
    }
  };

  return (
    <Box>
      <Typography variant="h5" gutterBottom>Invoices</Typography>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap">
        <ToggleButtonGroup size="small" value={status} exclusive
          onChange={(_, v) => { if (v != null) { setStatus(v); setPage(1); } }}>
          {STATUSES.map((s) => (
            <ToggleButton key={s.value} value={s.value}>{s.label}</ToggleButton>
          ))}
        </ToggleButtonGroup>
        {meta && (
          <Typography variant="body2" color="text.secondary">
            {meta.total.toLocaleString()} invoices · page {meta.page}
          </Typography>
        )}
        <Button size="small" disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</Button>
        <Button size="small" disabled={!meta || page * PAGE_SIZE >= meta.total} onClick={() => setPage(page + 1)}>Next</Button>
        <Box sx={{ flexGrow: 1 }} />
        {/* BIL-20: the desk door. The queue is the other one; both post the
            same document. */}
        <Button size="small" variant="contained" onClick={() => setCreating(true)}
          aria-label="new invoice">
          New invoice
        </Button>
      </Stack>

      {createdNote && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setCreatedNote(null)}>
          {createdNote}
        </Alert>
      )}

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {loading && !rows.length && <Skeleton variant="rectangular" height={320} />}

      <TableContainer component={Paper}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>No.</TableCell>
              <SortHeader label="Date" field="date" sort={sort} onSort={onSort} />
              <SortHeader label="Payer" field="payer" sort={sort} onSort={onSort} />
              <SortHeader label="Status" field="status" sort={sort} onSort={onSort} />
              <SortHeader label="Total" field="total" sort={sort} onSort={onSort} align="right" />
              <SortHeader label="Paid" field="paid" sort={sort} onSort={onSort} align="right" />
              <SortHeader label="Balance" field="balance" sort={sort} onSort={onSort} align="right" />
              <TableCell />
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id} hover sx={{ cursor: 'pointer' }} onClick={() => openDetail(r.id)}>
                <TableCell>{r.legacy_invoice_no ?? `#${r.id}`}</TableCell>
                <TableCell>{usDate(r.invoice_date)}</TableCell>
                <TableCell>{r.payer_name || '—'}</TableCell>
                <TableCell>
                  <Stack direction="row" spacing={0.5}>
                    <Chip size="small" label={r.status}
                      color={r.status === 'paid' ? 'success' : r.status === 'void' ? 'default' : 'warning'} />
                    {r.kind !== 'invoice' && <Chip size="small" variant="outlined" label={r.kind} />}
                    {r.adjusted_by && <Chip size="small" color="info" label="adjusted" />}
                  </Stack>
                </TableCell>
                <TableCell align="right">{money(r.total)}</TableCell>
                <TableCell align="right">{money(r.amount_paid)}</TableCell>
                <TableCell align="right">
                  {Number(r.balance ?? 0) > 0.001
                    ? <Chip size="small" color="warning" label={money(Number(r.balance))} />
                    : money(0)}
                </TableCell>
                <TableCell align="right">
                  {canAdjust && !r.adjusted_by && r.kind === 'invoice' && (
                    <Tooltip title="Open to adjust">
                      <IconButton size="small" aria-label={`open invoice ${r.id}`}
                        onClick={(e) => { e.stopPropagation(); void openDetail(r.id); }}>
                        <AdjustIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {!loading && !rows.length && (
              <TableRow><TableCell colSpan={8}>No invoices match this filter.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>

      <Dialog open={!!detail} onClose={() => { setDetail(null); setCorrecting(false); }} maxWidth="md" fullWidth>
        <DialogTitle>
          Invoice {detail?.legacy_invoice_no ?? `#${detail?.id}`}
          {detail?.kind && detail.kind !== 'invoice' ? ` (${detail.kind})` : ''}
        </DialogTitle>
        <DialogContent dividers>
          {detail && (
            <>
              <Typography variant="body2" gutterBottom>
                {detail.payer_name} · {usDate(detail.invoice_date)} ·{' '}
                <Chip size="small" label={detail.status} sx={{ ml: 0.5 }} />
              </Typography>
              <TableContainer sx={{ maxHeight: 300 }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Description</TableCell>
                      <TableCell>Ref</TableCell>
                      <TableCell align="right">Qty</TableCell>
                      <TableCell align="right">Unit</TableCell>
                      <TableCell align="right">Amount</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {detail.lines.map((l) => (
                      <TableRow key={l.id}>
                        <TableCell>{l.description || '—'}</TableCell>
                        <TableCell>
                          {l.legacy_product_code
                            ? <Chip size="small" variant="outlined" label={l.legacy_product_code} />
                            : l.service_event_id ? 'event' : <Chip size="small" color="error" label="no reference" />}
                        </TableCell>
                        <TableCell align="right">{l.quantity}</TableCell>
                        <TableCell align="right">{money(l.unit_price)}</TableCell>
                        <TableCell align="right">{money(l.amount)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
              <Typography variant="body2" sx={{ mt: 1 }}>
                Total {money(detail.total)} · Paid {money(detail.amount_paid)} ·{' '}
                {/* The server's netted figure — a bill with a credit and a full
                    receipt shows $0/paid here, not the $20 the header alone would. */}
                <b>Balance {money(Number(detail.balance
                  ?? ((Number(detail.total) || 0) - (Number(detail.amount_paid) || 0))))}</b>
                {detail.adjusts_invoice_id ? ` · adjusts #${detail.adjusts_invoice_id}` : ''}
              </Typography>
              {detail.payments?.length > 0 && (
                <TableContainer sx={{ mt: 1 }}>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Received</TableCell>
                        <TableCell align="right">Amount</TableCell>
                        <TableCell>Method</TableCell>
                        <TableCell>Ref</TableCell>
                        <TableCell>By</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {detail.payments.map((p) => (
                        <TableRow key={p.id}>
                          <TableCell>{usDate(p.paid_at) || '—'}</TableCell>
                          <TableCell align="right">{money(p.amount)}</TableCell>
                          <TableCell>{p.method}</TableCell>
                          <TableCell>{p.reference || '—'}</TableCell>
                          {/* NULL means the legacy import: a real payment whose
                              taker predates every login in this system. */}
                          <TableCell>{p.received_by ?? 'legacy import'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
              {detail.history && detail.history.length > 1 && (
                <Box sx={{ mt: 2 }}>
                  <Typography variant="overline">Adjustment history</Typography>
                  <TableContainer>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>Date</TableCell>
                          <TableCell>Type</TableCell>
                          <TableCell align="right">Total</TableCell>
                          <TableCell>Reason</TableCell>
                          <TableCell>By</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {detail.history.map((h) => (
                          <TableRow key={h.id} hover sx={{ cursor: 'pointer' }}
                            onClick={() => openDetail(h.id)}>
                            <TableCell>{usDate(h.invoice_date)}</TableCell>
                            <TableCell>
                              <Chip size="small"
                                variant={h.id === detail.id ? 'filled' : 'outlined'}
                                label={h.id === detail.id ? `${h.kind} · this` : h.kind} />
                            </TableCell>
                            <TableCell align="right">{money(h.total)}</TableCell>
                            <TableCell>{h.adjust_reason ?? '—'}</TableCell>
                            <TableCell>
                              {h.created_by_name ?? (h.created_by == null ? 'legacy import' : '—')}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                </Box>
              )}
              {correcting && (
                <Box sx={{ mt: 2 }}>
                  <Divider sx={{ my: 1 }} />
                  <Typography variant="overline">Correct a line — only the difference is filed</Typography>
                  <Typography variant="body2" color="text.secondary" gutterBottom>
                    Set what each line should have been. Only the lines you move off their
                    charged value are filed, and only as the difference against what was
                    charged — so correcting 1 × $250 to 1 × $200 posts −$50, not a credit of
                    the whole line, and a corrected quantity of 0 is the whole credit. Each
                    line keeps its own reference; the original is never edited.
                  </Typography>
                  <TableContainer sx={{ maxHeight: 260 }}>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>Line</TableCell>
                          <TableCell align="right">Charged</TableCell>
                          <TableCell align="right">Correct qty</TableCell>
                          <TableCell align="right">Correct price</TableCell>
                          <TableCell align="right">Files</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {detail.lines.map((l) => {
                          const e = edits[String(l.id)] ?? { qty: l.quantity, price: l.unit_price };
                          const d = lineDelta(l);
                          const ref = l.legacy_product_code
                            || (l.service_event_id ? `event ${l.service_event_id}` : 'no reference');
                          return (
                            <TableRow key={l.id}>
                              <TableCell>
                                {l.description || '—'}{' '}
                                <Typography variant="caption" color="text.secondary">({ref})</Typography>
                              </TableCell>
                              <TableCell align="right">{money(l.amount)}</TableCell>
                              <TableCell align="right">
                                <TextField size="small" sx={{ width: 76 }} value={e.qty} disabled={adjustBusy}
                                  onChange={(ev) => setEdits((m) => ({
                                    ...m, [String(l.id)]: { ...e, qty: ev.target.value },
                                  }))}
                                  inputProps={{ 'aria-label': `correct qty ${l.id}` }} />
                              </TableCell>
                              <TableCell align="right">
                                <TextField size="small" sx={{ width: 92 }} value={e.price} disabled={adjustBusy}
                                  onChange={(ev) => setEdits((m) => ({
                                    ...m, [String(l.id)]: { ...e, price: ev.target.value },
                                  }))}
                                  inputProps={{ 'aria-label': `correct price ${l.id}` }} />
                              </TableCell>
                              <TableCell align="right">
                                {d.invalid
                                  ? <Chip size="small" color="error" label="number?" />
                                  : d.edited
                                    ? <Typography variant="body2"
                                        sx={{ color: d.delta < 0 ? 'error.main' : 'success.main' }}>
                                        {money(d.delta)}
                                      </Typography>
                                    : <Typography variant="caption" color="text.secondary">unchanged</Typography>}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </TableContainer>
                  <Stack spacing={1} sx={{ mt: 1 }}>
                    <TextField
                      label="Reason (required — why the original was wrong)" fullWidth multiline minRows={2}
                      value={adjustReason} disabled={adjustBusy}
                      onChange={(ev) => setAdjustReason(ev.target.value)}
                      inputProps={{ 'aria-label': 'adjustment reason' }}
                    />
                    <Typography variant="body2" color="text.secondary">
                      {editedLines.length === 0
                        ? 'Nothing to file yet — change a corrected qty or price to raise an adjustment.'
                        : `Adjustment ${money(adjustmentTotal)} · resulting balance ${money(resultingBalance)}`}
                      {resultingBalance < -0.005 ? ' · this over-credits the invoice' : ''}
                    </Typography>
                  </Stack>
                  {adjustError && <Alert severity="error" sx={{ mt: 1 }}>{adjustError}</Alert>}
                </Box>
              )}
            </>
          )}
        </DialogContent>
        <DialogActions>
          {correcting ? (
            <>
              <Box sx={{ flexGrow: 1 }} />
              <Button onClick={() => setCorrecting(false)} disabled={adjustBusy}>Cancel</Button>
              <Button variant="contained" onClick={submitAdjust}
                disabled={adjustBusy || !canFileAdjust}>
                File adjustment
              </Button>
            </>
          ) : (
            <>
              <Button startIcon={<PrintIcon />}
                component={Link}
                to={detail ? `/invoices/${detail.id}/print` : '#'}
                target="_blank" rel="noopener">
                Print
              </Button>
              {detail && (detail.history ?? []).some((h) => h.adjusts_invoice_id === detail.id) && (
                // The paper the office can actually mail: the bill folded with the
                // corrections that answered it, netted server-side, so the balance
                // asked for is the balance owed — not the pre-discount header total.
                <Button startIcon={<PrintIcon />} component={Link}
                  to={`/invoices/${detail.id}/print?statement=1&auto=1`}
                  target="_blank" rel="noopener">
                  Send adjusted invoice
                </Button>
              )}
              <Box sx={{ flexGrow: 1 }} />
              {canAdjust && detail && detail.status !== 'void'
                && Number(detail.balance ?? (Number(detail.total) - Number(detail.amount_paid))) > 0.001 && (
                <Button startIcon={<PayIcon />} onClick={() => startPay(detail)}>Record payment</Button>
              )}
              {canAdjust && detail && detail.status !== 'void'
                && !(detail.history ?? []).some((h) => h.adjusts_invoice_id === detail.id && h.status !== 'void') && (
                <Button onClick={() => startAdjust(detail)}>Adjust</Button>
              )}
              <Button onClick={() => { setDetail(null); setCorrecting(false); }}>Close</Button>
            </>
          )}
        </DialogActions>
      </Dialog>

      <Dialog open={paying} onClose={() => !payBusy && setPaying(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Record a payment</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            The receipt becomes its own row — who took it, how, when. The invoice's
            paid total is re-added from the receipts, never typed over.
          </Typography>
          <Stack spacing={1}>
            <TextField label="Amount" size="small" type="number" value={payForm.amount}
              onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })}
              inputProps={{ 'aria-label': 'payment amount' }} />
            <TextField select size="small" label="Method" value={payForm.method}
              onChange={(e) => setPayForm({ ...payForm, method: e.target.value })}>
              {['check', 'cash', 'card', 'other'].map((m) => (
                <MenuItem key={m} value={m}>{m}</MenuItem>
              ))}
            </TextField>
            <TextField label="Check # / reference" size="small" value={payForm.reference}
              onChange={(e) => setPayForm({ ...payForm, reference: e.target.value })} />
            <TextField label="Note" size="small" value={payForm.note}
              onChange={(e) => setPayForm({ ...payForm, note: e.target.value })} />
          </Stack>
          {payError && <Alert severity="error" sx={{ mt: 1 }}>{payError}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPaying(false)} disabled={payBusy}>Cancel</Button>
          <Button variant="contained" onClick={submitPay}
            disabled={payBusy || !(Number(payForm.amount) > 0)}>
            Record
          </Button>
        </DialogActions>
      </Dialog>

      {creating && (
        <NewInvoiceDialog
          onClose={() => setCreating(false)}
          onCreated={(inv) => {
            setCreating(false);
            setCreatedNote(`Invoice ${inv.id} created for ${inv.payer_name ?? 'the payer'} — $${
              Number(inv.total).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            }. ${inv.status}.`);
            setPage(1);
            void load();
          }}
        />
      )}
    </Box>
  );
};

export default InvoicesPage;
