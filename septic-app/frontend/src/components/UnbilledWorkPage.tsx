import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usDate } from '../format';
import {
  Box, Checkbox, Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  ToggleButton, ToggleButtonGroup, Typography, Alert, Button, Chip, Skeleton,
  Paper, Stack,
} from '@mui/material';
import { ledgerService, UnbilledRow, UnbilledMeta } from '../services/ledgerService';
import { SortHeader, nextSort, SortState } from '../sort';
import NewInvoiceDialog from './NewInvoiceDialog';
import { NewInvoice } from '../services/invoiceService';

/**
 * The billing queue (BIL-19): what the truck finished that nobody has billed.
 *
 * This is a work list, not a report. A row leaves it exactly when an invoice
 * line names its service event — from the bid desk, an adjustment, a
 * hand-fix — because the list is computed from that condition and never
 * kept. There is no "mark as billed" button to forget, and no sync job to
 * run late.
 *
 * The rows are the heads of correction chains, so a corrected pump-out
 * appears once, wearing its corrected facts: the state report counts heads,
 * and billing would do a strange thing if it counted history.
 *
 * Invoice creation deliberately does not live here. The price book is still
 * the office's to decide (the reason the invoice screen was never built);
 * what could be built without guessing a single price was the truth that
 * unbilled work exists and is getting older.
 */

const WINDOWS: { value: string; label: string }[] = [
  { value: '14', label: '2 weeks' },
  { value: '30', label: '30 days' },
  { value: '60', label: '60 days' },
  { value: '365', label: 'This year' },
  { value: 'all', label: 'All' },
];

const PAGE_SIZE = 50;

const moneyish = (n: string | number) =>
  `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const UnbilledWorkPage: React.FC = () => {
  const navigate = useNavigate();
  const [days, setDays] = useState('60');
  const [rows, setRows] = useState<UnbilledRow[]>([]);
  const [meta, setMeta] = useState<UnbilledMeta | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Server-side: the window with the dial at "All" is decades deep, and a
  // page of it is 50 rows — sorting those in the browser would only ever
  // rearrange the 50 the server happened to hand over.
  const [sort, setSort] = useState<SortState>({ field: 'service_date', dir: 'desc' });
  // The point of the queue is the drain: pick the rows, bill them, and the
  // list re-reads itself shorter. Selection is display state — the queue
  // stores nothing, so there is no "marked" flag to forget to clear.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [createdNote, setCreatedNote] = useState<string | null>(null);

  const toggleRow = (id: string) => setSelected((m) => {
    const n = new Set(m);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.service_event_id));

  const selectedRows = rows.filter((r) => selected.has(r.service_event_id));
  const owners = [...new Set(selectedRows.map((r) => r.owner_payer_id).filter((x) => x !== null))];
  const singleOwner = owners.length === 1
    ? selectedRows.find((r) => r.owner_payer_id === owners[0]) ?? null : null;
  const sites = [...new Set(selectedRows.map((r) => r.property_id))];

  const onSort = useCallback((field: string) => {
    setSort((s) => nextSort(s, field));
    setPage(1);
  }, []);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const res = await ledgerService.unbilled({
        days: days === 'all' ? 'all' : Number(days),
        page, limit: PAGE_SIZE, sort: sort.field, dir: sort.dir,
      });
      setRows(res.data);
      setMeta(res.meta);
    } catch (e: any) {
      setError(e?.message || 'Could not load the billing queue');
    } finally {
      setLoading(false);
    }
  }, [days, page, sort]);

  useEffect(() => { void load(); }, [load]);

  const pages = meta ? Math.max(1, Math.ceil(meta.total / PAGE_SIZE)) : 1;

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2, mb: 1, flexWrap: 'wrap' }}>
        <Typography variant="h4">Billing queue</Typography>
        {meta?.business_today && (
          <Typography variant="body2" color="text.secondary">
            Today: <b>{usDate(meta.business_today)}</b>
          </Typography>
        )}
        {meta && (
          <Typography variant="body2" color="text.secondary">
            {meta.total.toLocaleString()} unbilled in this window
          </Typography>
        )}
      </Box>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 2, maxWidth: 780 }}>
        Completed pump-outs with no invoice line on them, newest first. A row
        disappears the moment an invoice names it — corrected jobs appear once,
        as their current version.
      </Typography>

      <Box sx={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 1, flexWrap: 'wrap', mb: 2,
      }}>
        <ToggleButtonGroup
          value={days}
          exclusive
          size="small"
          onChange={(_e, v) => { if (v) { setDays(v); setPage(1); } }}
        >
          {WINDOWS.map((w) => (
            <ToggleButton key={w.value} value={w.value} sx={{ px: 2 }}>
              {w.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <Stack direction="row" spacing={1}>
          <Button size="small" onClick={() => void load()}>Refresh</Button>
          <Button size="small" variant="contained"
            disabled={selected.size === 0}
            onClick={() => setCreating(true)}
            aria-label="create invoice from selection">
            Create invoice{selected.size ? ` (${selected.size})` : ''}
          </Button>
        </Stack>
      </Box>

      {createdNote && (
        <Alert severity="success" sx={{ mb: 2 }}
          onClose={() => setCreatedNote(null)}>
          {createdNote}
        </Alert>
      )}

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}
          action={<Button color="inherit" size="small" onClick={() => void load()}>Retry</Button>}>
          {error}
        </Alert>
      )}

      {loading ? (
        <Box sx={{ p: 2 }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} variant="rectangular" height={40} sx={{ mb: 0.5 }} />
          ))}
        </Box>
      ) : (
        <TableContainer component={Paper} sx={{ maxHeight: 'calc(100vh - 320px)' }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox">
                  <Checkbox size="small"
                    inputProps={{ 'aria-label': 'select all rows on this page' }}
                    checked={allSelected}
                    onChange={() => setSelected(allSelected
                      ? new Set() : new Set(rows.map((r) => r.service_event_id)))}
                  />
                </TableCell>
                <SortHeader label="Serviced" field="service_date" sort={sort} onSort={onSort} />
                <SortHeader label="Cust #" field="cust" sort={sort} onSort={onSort} />
                <SortHeader label="Site" field="site" sort={sort} onSort={onSort} />
                <SortHeader label="Payer on file" field="payer" sort={sort} onSort={onSort} />
                <TableCell align="right">Gallons</TableCell>
                <TableCell>Disposal</TableCell>
                <TableCell align="right">Waiting</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} align="center" sx={{ py: 6 }}>
                    <Typography color="text.secondary">
                      Nothing serviced and unbilled in this window — the truck's
                      work is all on paper.
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
              {rows.map((r) => (
                <TableRow
                  key={r.service_event_id}
                  hover
                  onClick={() => navigate(`/properties/${r.property_id}`)}
                  sx={{ cursor: 'pointer' }}
                >
                  <TableCell padding="checkbox" onClick={(e) => e.stopPropagation()}>
                    <Checkbox size="small"
                      inputProps={{ 'aria-label': `select service ${r.service_event_id}` }}
                      checked={selected.has(r.service_event_id)}
                      onChange={() => toggleRow(r.service_event_id)}
                    />
                  </TableCell>
                  <TableCell>{usDate(r.service_date)}</TableCell>
                  <TableCell>{r.legacy_cust_number ?? '—'}</TableCell>
                  <TableCell>
                    {r.site_address || '—'}
                    {r.site_city ? <Typography component="span" variant="body2" color="text.secondary"> {`, ${r.site_city}`}</Typography> : null}
                  </TableCell>
                  <TableCell>{r.payer_label || <Chip size="small" variant="outlined" label="no payer on file" />}</TableCell>
                  <TableCell align="right">{r.gallons_pumped ?? '—'}</TableCell>
                  <TableCell>{r.disposal_site || '—'}</TableCell>
                  <TableCell align="right">
                    <Chip
                      size="small"
                      variant="outlined"
                      color={r.days_ago > 30 ? 'error' : r.days_ago > 14 ? 'warning' : 'default'}
                      label={r.days_ago === 0 ? 'today' : `${r.days_ago} d`}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {meta && meta.total > PAGE_SIZE && (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            Page {page} of {pages}
          </Typography>
          <Button size="small" disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</Button>
          <Button size="small" disabled={page * PAGE_SIZE >= meta.total} onClick={() => setPage(page + 1)}>Next</Button>
        </Stack>
      )}

      {creating && (
        <NewInvoiceDialog
          onClose={() => setCreating(false)}
          initialPayer={singleOwner?.owner_payer_id != null
            ? { id: singleOwner.owner_payer_id, name: singleOwner.owner_payer_name } : null}
          initialSite={sites.length === 1 && selectedRows.length
            ? { id: sites[0], label: selectedRows[0].site_address ?? `site #${sites[0]}` } : null}
          initialEvents={selectedRows}
          onCreated={(inv: NewInvoice) => {
            setCreating(false);
            setSelected(new Set());
            setCreatedNote(`Invoice ${inv.id} created for ${inv.payer_name ?? 'the payer'} — ${
              moneyish(inv.total)}. These ${selectedRows.length} pump-out${selectedRows.length === 1 ? '' : 's'} already left the queue.`);
            void load(true);
          }}
        />
      )}
    </Box>
  );
};

export default UnbilledWorkPage;
