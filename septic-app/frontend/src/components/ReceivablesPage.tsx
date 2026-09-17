import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Typography, Alert, Paper, Chip, Skeleton, Stack, TextField, Button, IconButton,
} from '@mui/material';
import { ChevronRight as OpenIcon } from '@mui/icons-material';
import { receivablesService, ReceivableRow, ReceivablesMeta } from '../services/receivablesService';
import { usDate } from '../format';
import { SortHeader, useClientSort } from '../sort';

/**
 * Accounts receivable (BIL-07) — the chase list.
 *
 * The phone call that motivated the whole feature: "Jane Smith has an open
 * invoice for $335, they paid $150, they still owe $185." This screen answers
 * it for every payer at once, and it answers it by arithmetic — every number
 * on screen was re-derived from invoice totals and receipt rows seconds ago,
 * the same rule that killed `tblStateReports`. A stored balance column would
 * have been the same drift with money on it.
 *
 * Biggest balances first, because the desk works the phone list top-down.
 * Opening a row goes to the invoice book filtered to that payer — the drill
 * from "who owes" to "which invoice", which is where payments get recorded
 * and statements get printed.
 */

const money = (n: string | number) =>
  `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const ReceivablesPage: React.FC = () => {
  const navigate = useNavigate();
  const [rows, setRows] = useState<ReceivableRow[]>([]);
  // Whole result, one request — sorting happens right here. The money
  // columns arrive as numeric strings (the server keeps them `numeric`),
  // so they are compared as numbers: '9.00' > '100.00' as text is not the
  // order anyone came here to read.
  const sorter = useClientSort<ReceivableRow>(rows, {
    payer: (r) => r.payer_name,
    billed: (r) => Number(r.billed),
    collected: (r) => Number(r.collected),
    balance: (r) => Number(r.balance),
    oldest: (r) => r.oldest_open,
    open: (r) => r.open_invoices,
  }, 'balance', 'desc');
  const [meta, setMeta] = useState<ReceivablesMeta | null>(null);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await receivablesService.list(q || undefined);
      setRows(res.data);
      setMeta(res.meta);
    } catch (e) {
      setError((e as Error)?.message || 'Could not load accounts receivable');
    } finally {
      setLoading(false);
    }
  }, [q]);

  useEffect(() => { load(); }, [load]);

  return (
    <Box>
      <Typography variant="h5" gutterBottom>Accounts receivable</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Owed money, recomputed from invoices and receipts on every load.
        {meta && (
          <>
            {' '}{meta.payers_owing} payers owing {' '}{money(meta.total_receivable)}.
            {meta.credit_balances > 0 && (
              /* Paid-then-voided invoices leave the payer owing us nothing and
                 us owing them; they are counted, not hidden. */
              <Chip size="small" color="info" sx={{ ml: 1 }}
                label={`${meta.credit_balances} on our side (credits)`} />
            )}
          </>
        )}
      </Typography>

      <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
        <TextField size="small" placeholder="Search payer…" value={q}
          onChange={(e) => setQ(e.target.value)}
          inputProps={{ 'aria-label': 'search receivable payers' }} />
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {loading && !rows.length && <Skeleton variant="rectangular" height={320} />}

      <TableContainer component={Paper}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <SortHeader label="Payer" field="payer" sort={sorter.sort} onSort={sorter.onSort} />
              <SortHeader label="Billed" field="billed" sort={sorter.sort} onSort={sorter.onSort} align="right" />
              <SortHeader label="Collected" field="collected" sort={sorter.sort} onSort={sorter.onSort} align="right" />
              <SortHeader label="Balance" field="balance" sort={sorter.sort} onSort={sorter.onSort} align="right" />
              <SortHeader label="Oldest open" field="oldest" sort={sorter.sort} onSort={sorter.onSort} />
              <SortHeader label="Open" field="open" sort={sorter.sort} onSort={sorter.onSort} align="right" />
              <TableCell />
            </TableRow>
          </TableHead>
          <TableBody>
            {sorter.sorted.map((r) => (
              <TableRow key={r.payer_id} hover sx={{ cursor: 'pointer' }}
                onClick={() => navigate(`/invoices?payer=${r.payer_id}`)}>
                <TableCell>{r.payer_name || `payer #${r.payer_id}`}</TableCell>
                <TableCell align="right">{money(r.billed)}</TableCell>
                <TableCell align="right">{money(r.collected)}</TableCell>
                <TableCell align="right">
                  <Chip size="small" color="warning" variant="outlined" label={money(r.balance)} />
                </TableCell>
                <TableCell>{r.oldest_open ? usDate(r.oldest_open) : '—'}</TableCell>
                <TableCell align="right">{r.open_invoices}</TableCell>
                <TableCell align="right">
                  <IconButton size="small" aria-label={`open invoices for ${r.payer_name ?? r.payer_id}`}>
                    <OpenIcon fontSize="small" />
                  </IconButton>
                </TableCell>
              </TableRow>
            ))}
            {!loading && !rows.length && !error && (
              <TableRow>
                <TableCell colSpan={7}>
                  {q ? 'Nobody by that name owes money.' : 'Nobody owes anything. Good morning.'}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>
      {meta && (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
          Click a row to open that payer&rsquo;s invoice book.
        </Typography>
      )}
      <Button onClick={load} size="small" sx={{ mt: 1 }}>Recompute</Button>
    </Box>
  );
};

export default ReceivablesPage;
