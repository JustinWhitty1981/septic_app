import React, { useCallback, useEffect, useState } from 'react';
import { SortHeader, useClientSort } from '../sort';
import {
  Alert, Box, Button, Checkbox, Chip, Stack, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import { Add as AddIcon } from '@mui/icons-material';
import { bidService, BidItem } from '../services/bidService';
import { messageOf } from '../services/ledgerService';

/**
 * The price list, managed (BIL-17).
 *
 * This page is a faithful rendering of the server T-BIL-09 already proved and
 * adds no doctrine of its own: money is the server's string end to end (a
 * price typed `300.5` is sent as `300.5`, stored `300.50`, answered
 * `300.50` — no float ever sits between the keyboard and the row), edits
 * happen **in place** because BIL-09 ruled the list a current reference and
 * an old bid already carries its own copy, and items retire behind
 * `is_active` rather than die.
 *
 * There is deliberately **no delete button on this screen.** A $300/hour
 * rate that once existed is evidence about what the company charged; the
 * picker can hide a row without the company forgetting it. The server has no
 * DELETE route either — this is not a UI that will need to be kept honest
 * later.
 *
 * Refusals keep the server's sentence: "a price is a number ≥ 0" arriving as
 * a paraphrase is a refusal nobody can act on.
 */

const money = (n: string | number | null | undefined) =>
  n == null ? '—' : `$${Number(n).toLocaleString(undefined, {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;

const PriceListPage: React.FC = () => {
  const [rows, setRows] = useState<BidItem[]>([]);
  const sorter = useClientSort<BidItem>(rows, {
    name: (r) => r.name, unit: (r) => r.unit,
    price: (r) => Number(r.unit_price), status: (r) => (r.is_active ? 'active' : 'retired'),
  }, 'name', 'asc');
  const [showRetired, setShowRetired] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', unit: '', unit_price: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const { data } = await bidService.bidItems(showRetired);
      setRows(data);
    } catch (e) {
      setLoadError(messageOf(e));
    }
  }, [showRetired]);

  useEffect(() => { void load(); }, [load]);

  const addItem = async () => {
    setBusy(true);
    setError(null);
    try {
      // Strings as typed: the server trims, validates and stores; a Number()
      // here would be the float walking back in the front door.
      await bidService.createBidItem({
        name: form.name.trim(), unit: form.unit.trim(),
        unit_price: form.unit_price.trim(),
      });
      setForm({ name: '', unit: '', unit_price: '' });
      setAdding(false);
      void load();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box>
      <Stack direction="row" alignItems="center" justifyContent="space-between"
        sx={{ mb: 1, flexWrap: 'wrap' }}>
        <Typography variant="h5">Price list</Typography>
        <Button variant="contained" startIcon={<AddIcon />} aria-label="add item"
          onClick={() => { setAdding((v) => !v); setError(null); }}>
          Add item
        </Button>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        The standard items bids are built from. Editing a price is legitimate —
        bids already made keep the price they were made at. Items retire; they
        are never deleted.
      </Typography>

      {loadError && <Alert severity="error" sx={{ mb: 1 }}>{loadError}</Alert>}
      {error && <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert>}

      {adding && (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}
          flexWrap="wrap" useFlexGap>
          <TextField size="small" label="Name" value={form.name}
            inputProps={{ 'aria-label': 'new item name' }}
            onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <TextField size="small" label="Unit" sx={{ width: 110 }} value={form.unit}
            inputProps={{ 'aria-label': 'new item unit' }}
            onChange={(e) => setForm({ ...form, unit: e.target.value })} />
          <TextField size="small" label="Price" sx={{ width: 110 }} value={form.unit_price}
            inputProps={{ 'aria-label': 'new item price' }}
            onChange={(e) => setForm({ ...form, unit_price: e.target.value })} />
          <Button size="small" variant="outlined" onClick={addItem}
            disabled={busy || !form.name.trim() || !form.unit.trim() || !form.unit_price.trim()}
            aria-label="save new item">
            Add
          </Button>
        </Stack>
      )}

      <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mb: 1 }}>
        <Checkbox size="small" checked={showRetired}
          onChange={(e) => setShowRetired(e.target.checked)}
          inputProps={{ 'aria-label': 'show retired' }} />
        <Typography variant="body2" color="text.secondary">show retired</Typography>
      </Stack>

      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <SortHeader label="Name" field="name" sort={sorter.sort} onSort={sorter.onSort} />
              <SortHeader label="Unit" field="unit" sort={sorter.sort} onSort={sorter.onSort} />
              <SortHeader label="Price" field="price" sort={sorter.sort} onSort={sorter.onSort} align="right" />
              <SortHeader label="Status" field="status" sort={sorter.sort} onSort={sorter.onSort} />
              <TableCell aria-label="actions" />
            </TableRow>
          </TableHead>
          <TableBody>
            {sorter.sorted.map((r) => (
              <ItemRow key={r.id} item={r} onDone={() => { void load(); }}
                onRefused={(m) => setError(m)} />
            ))}
            {!rows.length && (
              <TableRow><TableCell colSpan={5}>The list is empty.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
};

/** One item: editable in place, retire-able, never deletable. */
const ItemRow: React.FC<{
  item: BidItem; onDone: () => void; onRefused: (message: string) => void;
}> = ({ item, onDone, onRefused }) => {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: item.name, unit: item.unit,
    unit_price: item.unit_price });
  const [busy, setBusy] = useState(false);

  const run = async (input: Parameters<typeof bidService.updateBidItem>[1]) => {
    setBusy(true);
    try {
      await bidService.updateBidItem(item.id, input);
      setEditing(false);
      onDone();
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
          <TextField size="small" value={form.name}
            inputProps={{ 'aria-label': `item name ${item.id}` }}
            onChange={(e) => setForm({ ...form, name: e.target.value })} />
        ) : item.name}
      </TableCell>
      <TableCell>
        {editing ? (
          <TextField size="small" sx={{ width: 90 }} value={form.unit}
            inputProps={{ 'aria-label': `item unit ${item.id}` }}
            onChange={(e) => setForm({ ...form, unit: e.target.value })} />
        ) : item.unit}
      </TableCell>
      <TableCell align="right">
        {editing ? (
          <TextField size="small" sx={{ width: 110 }} value={form.unit_price}
            inputProps={{ 'aria-label': `item price ${item.id}` }}
            onChange={(e) => setForm({ ...form, unit_price: e.target.value })} />
        ) : money(item.unit_price)}
      </TableCell>
      <TableCell>
        <Chip size="small" variant="outlined"
          label={item.is_active ? 'active' : 'retired'}
          color={item.is_active ? 'success' : 'default'} />
      </TableCell>
      <TableCell>
        <Stack direction="row" spacing={0.5}>
          {editing ? (
            <Button size="small" onClick={() => run({
              name: form.name.trim() || undefined, unit: form.unit.trim() || undefined,
              unit_price: form.unit_price.trim() || undefined,
            })} disabled={busy} aria-label={`save item ${item.id}`}>Save</Button>
          ) : (
            <Button size="small" onClick={() => setEditing(true)}
              aria-label={`edit item ${item.id}`}>Edit</Button>
          )}
          {/* Retire, never delete: the button that would remove the row does
              not exist on this page, and the route does not exist on the
              server. */}
          <Button size="small" onClick={() => run({ is_active: !item.is_active })}
            disabled={busy} aria-label={item.is_active
              ? `retire item ${item.id}` : `restore item ${item.id}`}>
            {item.is_active ? 'Retire' : 'Restore'}
          </Button>
        </Stack>
      </TableCell>
    </TableRow>
  );
};

export default PriceListPage;
