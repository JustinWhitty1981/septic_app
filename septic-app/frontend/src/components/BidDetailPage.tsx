import React, { useCallback, useEffect, useState } from 'react';
import { usDate } from '../format';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  Alert, Autocomplete, Box, Button, Chip, Dialog, DialogActions, DialogContent,
  DialogTitle, Link as MuiLink, Skeleton, Stack, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import { Add as AddIcon, Print as PrintIcon } from '@mui/icons-material';
import { bidService, BidDetail as BidDetailT, BidItem } from '../services/bidService';
import { authService } from '../services/authService';
import { messageOf } from '../services/ledgerService';

/**
 * One bid: its lines, its money, and the three decisions it can still receive.
 *
 * The page has one memory in it, and it is BIL-12's: a draft accepts
 * everything and a signed document accepts nothing. That is why there is no
 * "edit an approved bid" half-built here — revision is what drafts are for,
 * and after the signature the only honest edits are a new bid or (once it is
 * an invoice) an adjustment. The status guard exists on the server and the
 * 409 arrives in the server's words; this page merely declines to offer
 * buttons the server has already been told to refuse.
 *
 * The tax line says what it is: an *estimate at the current rate* until the
 * signature, after which the rate is the bid's own and the word "estimate" is
 * gone (BIL-16). A number that changes under a signed paper is the mistake
 * this whole feature was built to make impossible.
 */

const money = (n: string | number | null | undefined) =>
  n == null ? '—' : `$${Number(n).toLocaleString(undefined, {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;

const pct = (r: string | null | undefined) =>
  r == null ? '—' : `${(Number(r) * 100).toLocaleString(undefined,
    { maximumFractionDigits: 3 })}%`;

const STATUS_TONE: Record<string, 'default' | 'success' | 'error' | 'info'> = {
  draft: 'default', approved: 'success', declined: 'error', invoiced: 'info',
};

const Field: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <Box sx={{ minWidth: 160 }}>
    <Typography variant="caption" color="text.secondary" display="block">
      {label}
    </Typography>
    <Typography variant="body2">{value === null || value === '' ? '—' : value}</Typography>
  </Box>
);

const BidDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const bidId = id && /^\d+$/.test(id) ? Number(id) : null;
  const isOffice = authService.hasRole(['admin', 'manager', 'office']);

  const [row, setRow] = useState<BidDetailT | null>(null);
  const [items, setItems] = useState<BidItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [convertedTo, setConvertedTo] = useState<number | null>(null);

  const [pickedItem, setPickedItem] = useState<BidItem | null>(null);
  const [itemQuery, setItemQuery] = useState('');
  const [qty, setQty] = useState('1');
  const [busy, setBusy] = useState(false);
  const [oneOff, setOneOff] = useState(false);
  const [off, setOff] = useState({ description: '', unit: 'each', unit_price: '', quantity: '1' });
  const [declineOpen, setDeclineOpen] = useState(false);
  const [declineNote, setDeclineNote] = useState('');

  const load = useCallback(async () => {
    if (bidId === null) { setError('That is not a bid number.'); setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const [{ data }, list] = await Promise.all([
        bidService.bid(bidId),
        bidService.bidItems().catch(() => ({ data: [] as BidItem[] })),
      ]);
      setRow(data);
      setItems(list.data);
      setConvertedTo(data.invoice_id);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setLoading(false);
    }
  }, [bidId]);

  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      await load();
      after?.();
    } catch (e) {
      setActionError(messageOf(e)); // the server's sentence — it names the status
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Skeleton variant="rectangular" height={300} />;
  if (error || !row) {
    return (
      <Box>
        <Alert severity="error">{error || 'Bid not found'}</Alert>
        <Button sx={{ mt: 1 }} onClick={() => navigate('/bids')}>Back to bids</Button>
      </Box>
    );
  }

  const draft = row.status === 'draft';
  const mailing = [row.mailing_address,
    [row.mailing_city, row.mailing_state, row.mailing_zip].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ');

  return (
    <Box>
      <Button size="small" onClick={() => navigate('/bids')}>Bids</Button>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.5, mb: 1 }}>
        <Typography variant="h5">Bid #{row.id}</Typography>
        <Chip size="small" label={row.status} variant="outlined"
          color={STATUS_TONE[row.status]} />
        {!draft && (
          <Button size="small" startIcon={<PrintIcon />}
            onClick={() => navigate(`/bids/${row.id}/print`)}>
            Print
          </Button>
        )}
        {row.status === 'invoiced' && row.invoice_id && (
          <Button size="small" component={Link as any} to={`/invoices/${row.invoice_id}`}
            variant="outlined">
            Invoice {row.invoice_id}
          </Button>
        )}
      </Stack>

      <Stack direction="row" spacing={3} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
        <Field label="Date" value={usDate(row.bid_date)} />
        <Field label="Billed to" value={row.payer_name} />
        <Field label="Mailing" value={mailing || null} />
        <Field label="Site" value={row.site_address
          ? [row.site_address, row.site_city, row.site_state, row.site_zip]
            .filter(Boolean).join(', ') : null} />
        {row.approved_at && (
          <Field label="Approved"
            value={`${usDate(row.approved_at)} by ${row.approved_by_name ?? '—'}`} />
        )}
        {row.status === 'declined' && (
          <Field label="Declined" value={row.decline_note
            ? `${usDate(row.declined_at)} — ${row.decline_note}` : true} />
        )}
        {row.notes && <Field label="Notes" value={row.notes} />}
      </Stack>

      {row.status === 'declined' && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Declined — a decision, not a draft. Quote the customer again with a new bid.
        </Alert>
      )}
      {row.status === 'invoiced' && (
        <Alert severity="success" sx={{ mb: 2 }}>
          Invoiced as invoice {row.invoice_id}. Corrections run through the
          invoice (adjustments), never back through this bid.
        </Alert>
      )}
      {actionError && <Alert severity="error" sx={{ mb: 1 }}>{actionError}</Alert>}

      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Description</TableCell><TableCell>Unit</TableCell>
              <TableCell align="right">Price</TableCell><TableCell align="right">Qty</TableCell>
              <TableCell align="right">Total</TableCell>
              {draft && isOffice && <TableCell aria-label="line actions" />}
            </TableRow>
          </TableHead>
          <TableBody>
            {row.lines.map((l) => (
              <LineRow key={l.id} line={l} editable={draft && isOffice} bidId={row.id}
                onChanged={() => { void load(); }} onRefused={(m) => setActionError(m)} />
            ))}
            {!row.lines.length && (
              <TableRow>
                <TableCell colSpan={6}>
                  No lines yet — a bid with no lines is not a document.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>

      <Stack direction="row" spacing={4} sx={{ mt: 1.5, mb: 3 }} justifyContent="flex-end">
        <Box textAlign="right">
          <Typography variant="body2">Subtotal {money(row.subtotal)}</Typography>
          <Typography variant="body2">
            Sales tax {pct(row.eff_tax_rate)}
            {row.tax_estimated ? ' (estimate at current rate)' : ''} — {money(row.tax_amount)}
          </Typography>
          <Typography variant="h6">Total {money(row.total)}</Typography>
        </Box>
      </Stack>

      {draft && isOffice && (
        <AddLineBlock
          items={items} pickedItem={pickedItem} setPickedItem={setPickedItem}
          itemQuery={itemQuery} setItemQuery={setItemQuery}
          qty={qty} setQty={setQty} oneOff={oneOff} setOneOff={setOneOff}
          off={off} setOff={setOff} busy={busy}
          onAdd={(input) => act(() => bidService.addLine(row.id, input))}
        />
      )}

      {draft && isOffice && (
        <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
          <Button variant="contained" onClick={() => act(() => bidService.approve(row.id))}
            disabled={busy} aria-label="approve bid">
            Approve
          </Button>
          <Button onClick={() => setDeclineOpen(true)} disabled={busy}
            aria-label="decline bid">
            Decline
          </Button>
        </Stack>
      )}
      {row.status === 'approved' && isOffice && (
        <Box sx={{ mt: 2 }}>
          <Button variant="contained" aria-label="convert to invoice" disabled={busy}
            onClick={() => act(() => bidService.convert(row.id), () => setConvertedTo(null))}>
            Convert to invoice
          </Button>
        </Box>
      )}
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
        Converting creates the invoice once, in one step; the{' '}
        <MuiLink component={Link} to="/invoices">AR list</MuiLink> picks it up
        immediately — receipts, balances and statements all work on it.
      </Typography>

      <Dialog open={declineOpen} onClose={() => setDeclineOpen(false)}>
        <DialogTitle>Decline bid #{row.id}</DialogTitle>
        <DialogContent dividers>
          <TextField label="Why (optional — the drawer remembers)" multiline
            minRows={2} fullWidth value={declineNote}
            onChange={(e) => setDeclineNote(e.target.value)} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeclineOpen(false)}>Cancel</Button>
          <Button color="error" onClick={() => {
            setDeclineOpen(false);
            void act(() => bidService.decline(row.id, declineNote.trim() || undefined));
          }}>
            Decline — final
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

/** One line; editable while the bid is a draft, a record afterwards. */
const LineRow: React.FC<{
  line: BidDetailT['lines'][number]; editable: boolean; bidId: number;
  onChanged: () => void; onRefused: (message: string) => void;
}> = ({ line, editable, bidId, onChanged, onRefused }) => {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ description: line.description, unit: line.unit,
    unit_price: line.unit_price, quantity: line.quantity });
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await bidService.updateLine(bidId, line.id, {
        description: form.description.trim() || undefined,
        unit: form.unit.trim() || undefined,
        quantity: form.quantity.trim() || undefined,
        unit_price: form.unit_price.trim() || undefined,
      });
      setEditing(false);
      onChanged();
    } catch (e) {
      onRefused(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await bidService.removeLine(bidId, line.id);
      onChanged();
    } catch (e) {
      onRefused(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <TableRow>
      <TableCell>
        {editing ? (
          <TextField size="small" value={form.description}
            inputProps={{ 'aria-label': 'line description' }}
            onChange={(e) => setForm({ ...form, description: e.target.value })} />
        ) : line.description}
        {line.bid_item_id && (
          <Typography variant="caption" color="text.secondary" display="block">
            from the price list
          </Typography>
        )}
      </TableCell>
      <TableCell>
        {editing ? (
          <TextField size="small" sx={{ width: 80 }} value={form.unit}
            inputProps={{ 'aria-label': 'line unit' }}
            onChange={(e) => setForm({ ...form, unit: e.target.value })} />
        ) : line.unit}
      </TableCell>
      <TableCell align="right">
        {editing ? (
          <TextField size="small" sx={{ width: 100 }} value={form.unit_price}
            inputProps={{ 'aria-label': 'line price' }}
            onChange={(e) => setForm({ ...form, unit_price: e.target.value })} />
        ) : money(line.unit_price)}
      </TableCell>
      <TableCell align="right">
        {editing ? (
          <TextField size="small" sx={{ width: 80 }} value={form.quantity}
            inputProps={{ 'aria-label': 'line quantity' }}
            onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
        ) : line.quantity.replace(/\.?0+$/, '')}
      </TableCell>
      <TableCell align="right">{money(line.line_total)}</TableCell>
      {editable && (
        <TableCell>
          <Stack direction="row" spacing={0.5}>
            {editing ? (
              <Button size="small" onClick={save} disabled={busy}
                aria-label={`save line ${line.id}`}>Save</Button>
            ) : (
              <Button size="small" onClick={() => setEditing(true)}
                aria-label={`edit line ${line.id}`}>Edit</Button>
            )}
            <Button size="small" onClick={remove} disabled={busy}
              aria-label={`remove line ${line.id}`}>Remove</Button>
          </Stack>
        </TableCell>
      )}
    </TableRow>
  );
};

/** The draft-only "add a line" block: copy from the list, or type a one-off. */
interface AddLineProps {
  items: BidItem[];
  pickedItem: BidItem | null;
  setPickedItem: (v: BidItem | null) => void;
  itemQuery: string;
  setItemQuery: (v: string) => void;
  qty: string;
  setQty: (v: string) => void;
  oneOff: boolean;
  setOneOff: (v: boolean) => void;
  off: { description: string; unit: string; unit_price: string; quantity: string };
  setOff: (v: AddLineProps['off']) => void;
  busy: boolean;
  onAdd: (input:
    | { bid_item_id: number; quantity: string }
    | { description: string; unit: string; unit_price: string; quantity: string }) => void;
}

const AddLineBlock: React.FC<AddLineProps> = ({
  items, pickedItem, setPickedItem, itemQuery, setItemQuery, qty, setQty,
  oneOff, setOneOff, off, setOff, busy, onAdd,
}) => (
  <Box component="fieldset" sx={{ border: '1px solid #0002', borderRadius: 1 }}>
    <legend>
      <Typography variant="caption" color="text.secondary">add a line — draft only</Typography>
    </legend>
    {!oneOff ? (
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Autocomplete
          size="small" sx={{ minWidth: 260 }}
          options={items}
          getOptionLabel={(o) => `${o.name} — ${money(o.unit_price)}/${o.unit}`}
          value={pickedItem}
          inputValue={itemQuery}
          onInputChange={(_, v) => setItemQuery(v)}
          onChange={(_, v) => setPickedItem(v)}
          renderInput={(params) => (
            <TextField {...params} label="From the price list"
              inputProps={{ ...params.inputProps, 'aria-label': 'price list item' }} />
          )}
        />
        <TextField size="small" label="Qty" sx={{ width: 90 }} value={qty}
          inputProps={{ 'aria-label': 'add quantity' }}
          onChange={(e) => setQty(e.target.value)} />
        <Button size="small" variant="outlined" startIcon={<AddIcon />}
          disabled={busy || !pickedItem || !qty.trim()}
          aria-label="add item line"
          onClick={() => pickedItem && onAdd({ bid_item_id: pickedItem.id, quantity: qty.trim() })}>
          Add
        </Button>
        <Button size="small" onClick={() => setOneOff(true)}>One-off line…</Button>
      </Stack>
    ) : (
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <TextField size="small" label="What" sx={{ minWidth: 220 }} value={off.description}
          inputProps={{ 'aria-label': 'one-off description' }}
          onChange={(e) => setOff({ ...off, description: e.target.value })} />
        <TextField size="small" label="Unit" sx={{ width: 90 }} value={off.unit}
          inputProps={{ 'aria-label': 'one-off unit' }}
          onChange={(e) => setOff({ ...off, unit: e.target.value })} />
        <TextField size="small" label="Price" sx={{ width: 100 }} value={off.unit_price}
          inputProps={{ 'aria-label': 'one-off price' }}
          onChange={(e) => setOff({ ...off, unit_price: e.target.value })} />
        <TextField size="small" label="Qty" sx={{ width: 80 }} value={off.quantity}
          inputProps={{ 'aria-label': 'one-off quantity' }}
          onChange={(e) => setOff({ ...off, quantity: e.target.value })} />
        <Button size="small" variant="outlined" disabled={busy
          || !off.description.trim() || !off.unit.trim()
          || !off.unit_price.trim() || !off.quantity.trim()}
          aria-label="add one-off line"
          onClick={() => onAdd({ description: off.description.trim(), unit: off.unit.trim(),
            unit_price: off.unit_price.trim(), quantity: off.quantity.trim() })}>
          Add
        </Button>
        <Button size="small" onClick={() => setOneOff(false)}>← back to the list</Button>
      </Stack>
    )}
  </Box>
);

export default BidDetailPage;
