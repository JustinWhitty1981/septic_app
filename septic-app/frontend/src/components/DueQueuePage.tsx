import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { usDate } from '../format';
import {
  Box, Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  ToggleButton, ToggleButtonGroup, Typography, Alert, Button,
  Paper, Chip, Skeleton, IconButton, Dialog, DialogTitle, DialogContent,
  DialogActions, TextField, Stack,
} from '@mui/material';
import { EditCalendar as EditCalendarIcon, Sync as SyncIcon } from '@mui/icons-material';
import { propertyService, DueQueueRow, DueFilter, PageMeta } from '../services/propertyService';
import { SortHeader, nextSort, SortState } from '../sort';

/**
 * The due queue.
 *
 * This is the screen the rebuild was for. Everything above it — the payer split, the
 * tank rows, the ledger — exists so that this table can answer one question the legacy
 * app could not answer reliably: which sites are out of service, and by how long.
 *
 * It is computed, never stored. `next_service_due` is a generated column and
 * `days_overdue` is `business_today() - next_service_due`, so there is no refresh to
 * run, no stale copy to reconcile, and no field for a user to overwrite. The legacy
 * Next Service Date disagreed with the arithmetic behind it in 32,396 of 45,804 rows
 * because somebody had typed over it. That class of problem cannot recur here because
 * there is nowhere to type it.
 *
 * Read the bands before trusting the headline. Of the 1,925 rows in 'overdue', only
 * about 290 fell due inside the last year; 554 have not been serviced since before 2014
 * and the oldest due date in the file is 1989. Those are almost certainly sites the old
 * system carried forward and never closed, not 1,925 jobs to schedule, and the interval
 * that produced them is a policy the business has not yet confirmed.
 */

const FILTERS: { value: DueFilter; label: string }[] = [
  { value: 'overdue', label: 'Overdue' },
  { value: 'week', label: 'Next 7 days' },
  { value: 'due_30', label: 'Next 30 days' },
  { value: 'all', label: 'All' },
];

const PAGE_SIZE = 50;

/**
 * The gap between today and the due date, in the units the office uses.
 *
 * Derived from `days_overdue`, which the database already worked out against
 * business_today(), rather than recomputed here against the browser's clock. A laptop
 * with the wrong date and a server in another zone would otherwise disagree about who
 * is late, and the browser would win the argument on screen.
 */
function dueIn(days: number): { text: string; tone: 'error' | 'warning' | 'success' | 'default' } {
  if (days > 365) return { text: `${Math.round(days / 365)} yr overdue`, tone: 'error' };
  if (days > 30) return { text: `${Math.round(days)} days overdue`, tone: 'error' };
  if (days > 0) return { text: `${days} days overdue`, tone: 'warning' };
  if (days === 0) return { text: 'due today', tone: 'warning' };
  if (days >= -30) return { text: `due in ${-days} days`, tone: 'success' };
  return { text: `due in ${Math.round(-days / 30)} mo`, tone: 'default' };
}

/**
 * The adjustment dialog (SCH-16). Two fields, both required, and the server's
 * refusals shown verbatim: "Today is …; an adjustment to … is not a schedule
 * change, it is a claim about a service event" is a better teacher than any
 * paraphrase this form could write, and the form gates nothing the server has
 * not gated first.
 */
const AdjustDueDialog: React.FC<{
  row: DueQueueRow;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}> = ({ row, onClose, onDone }) => {
  const [date, setDate] = useState(row.effective_due_date ?? '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await propertyService.adjustDue(row.property_id, {
        adjusted_due_date: date, reason,
      });
      await onDone();
    } catch (e: any) {
      setError(e?.message || 'Could not adjust the due date');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullScreen>
      <DialogTitle>Adjust due date</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2} sx={{ mt: 1, minWidth: 280 }}>
          <Typography variant="body2" color="text.secondary">
            The computed date stays computed — this is a dated note beside the
            ledger, not an edit to it, and closing it later restores the plain
            schedule. The reason goes on the record with your name on it.
          </Typography>
          <TextField
            label="New due date" type="date" size="small"
            InputLabelProps={{ shrink: true }}
            value={date} onChange={(e) => setDate(e.target.value)}
            inputProps={{ 'aria-label': 'adjusted due date' }}
          />
          <TextField
            label="Reason this date is not the real one" size="small" multiline minRows={2}
            value={reason} onChange={(e) => setReason(e.target.value)}
            inputProps={{ 'aria-label': 'adjustment reason' }}
          />
        </Stack>
        {error && <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button
          variant="contained" onClick={submit}
          disabled={busy || !reason.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(date)}
        >
          Adjust due date
        </Button>
      </DialogActions>
    </Dialog>
  );
};

const DueQueuePage: React.FC = () => {
  const navigate = useNavigate();
  // The site page hands the confirmation back to this screen, so the add the
  // clerk just made is still on the wall while the queue re-reads itself —
  // the row is gone from the list (it is booked now, SCH-15), and without
  // the banner the add looks like it vanished.
  const location = useLocation();
  const addedNote = (location.state as { addedNote?: string } | null)?.addedNote ?? null;
  const [filter, setFilter] = useState<DueFilter>('overdue');
  const [rows, setRows] = useState<DueQueueRow[]>([]);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // SCH-15: booked sites are out of the default view, not out of the world.
  // This toggle is the promise that hiding keeps — ask, and they come back
  // wearing the day and the driver that has them.
  const [showScheduled, setShowScheduled] = useState(false);
  const [adjustFor, setAdjustFor] = useState<DueQueueRow | null>(null);
  // Sorted server-side: this page is a slice of ~7,266 rows, so an in-memory
  // sort would reorder only the fifty the server happened to hand over.
  // The default (soonest-due) is what the office acts on; the columns are the
  // second opinion.
  const [sort, setSort] = useState<SortState>({ field: 'due', dir: 'asc' });

  const onSort = useCallback((field: string) => {
    setSort((s) => nextSort(s, field));
    setPage(1);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await propertyService.dueQueue({
        filter, page, limit: PAGE_SIZE, show_scheduled: showScheduled,
        sort: sort.field, dir: sort.dir,
      });
      setRows(res.data);
      setMeta(res.meta || null);
    } catch (e: any) {
      // The server sends a message and, for a real failure, a log reference — never a
      // database error. Whatever arrives here is already safe to put on screen.
      setError(e?.message || 'Could not load the due queue');
    } finally {
      setLoading(false);
    }
  }, [filter, page, showScheduled, sort]);

  useEffect(() => {
    load();
  }, [load]);

  const pages = meta ? Math.max(1, Math.ceil(meta.total / PAGE_SIZE)) : 1;

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2, mb: 1, flexWrap: 'wrap' }}>
        <Typography variant="h4">Due queue</Typography>
        {meta?.business_today && (
          <Typography variant="body2" color="text.secondary">
            Today: <b>{usDate(meta.business_today)}</b> &middot; Central time
          </Typography>
        )}
        {meta && (
          <Typography variant="body2" color="text.secondary">
            {meta.total.toLocaleString()} in this view &middot;{' '}
            {(meta.overdue_total ?? 0).toLocaleString()} overdue overall
          </Typography>
        )}
      </Box>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 2, maxWidth: 780 }}>
        Computed from the last pump-out in the ledger plus each site's service interval.
        Nothing here is stored or editable, so it cannot drift from the jobs that happened.
      </Typography>

      <Box sx={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 1, flexWrap: 'wrap', mb: 2,
      }}>
        <ToggleButtonGroup
          value={filter}
          exclusive
          size="small"
          onChange={(_e, v) => {
            if (v && v !== filter) {
              setFilter(v as DueFilter);
              setPage(1);
            }
          }}
        >
          {FILTERS.map((f) => (
            <ToggleButton key={f.value} value={f.value} sx={{ px: 2 }}>
              {f.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>

        <ToggleButton
          size="small"
          value="scheduled"
          selected={showScheduled}
          sx={{ px: 2 }}
          onChange={() => { setShowScheduled((v) => !v); setPage(1); }}
        >
          Show booked sites
        </ToggleButton>
      </Box>

      {addedNote && (
        <Alert severity="success" sx={{ mb: 2 }}
          onClose={() => navigate('/due-queue', { replace: true })}>
          {addedNote}
        </Alert>
      )}

      {error && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          action={<Button color="inherit" size="small" onClick={load}>Retry</Button>}
        >
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
                <SortHeader label="Cust #" field="cust" sort={sort} onSort={onSort} />
                <SortHeader label="Site" field="site" sort={sort} onSort={onSort} />
                <SortHeader label="Payer on file" field="payer" sort={sort} onSort={onSort} />
                <SortHeader label="Next due" field="due" sort={sort} onSort={onSort} />
                <SortHeader label="Against schedule" field="overdue" sort={sort} onSort={onSort} align="right" />
                <TableCell align="right">Plan</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} align="center" sx={{ py: 6 }}>
                    <Typography color="text.secondary">Nothing in this view.</Typography>
                  </TableCell>
                </TableRow>
              )}
              {rows.map((r) => {
                const d = dueIn(r.days_overdue);
                return (
                  <TableRow
                    key={r.property_id}
                    hover
                    onClick={() => navigate(`/properties/${r.property_id}`,
                      { state: { from: 'due-queue' } })}
                    sx={{ cursor: 'pointer' }}
                  >
                    <TableCell>{r.legacy_cust_number ?? '—'}</TableCell>
                    <TableCell>
                      {r.site_address || 'no address on file'}
                      {r.site_city ? `, ${r.site_city}` : ''}
                    </TableCell>
                    <TableCell>{r.payer_label || '—'}</TableCell>
                    <TableCell>
                      {usDate(r.effective_due_date || r.next_service_due) || '—'}
                      {r.adjusted && (
                        <Typography variant="caption" display="block" color="text.secondary">
                          adjusted — {r.adjustment_reason}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell align="right">
                      {r.scheduled_on ? (
                        // The sentence the hiding promised: not gone, booked.
                        // Drafts say draft, because an unpublished day is a
                        // half-promise and the queue is where that matters.
                        <Chip
                          size="small"
                          variant="outlined"
                          color="info"
                          label={`booked ${usDate(r.scheduled_on)} · ${r.scheduled_driver || 'day'}${r.scheduled_status === 'draft' ? ' (draft)' : ''}`}
                        />
                      ) : (
                        <Chip
                          size="small"
                          color={d.tone === 'default' ? 'default' : d.tone}
                          label={d.text}
                        />
                      )}
                    </TableCell>
                    <TableCell align="right">
                      <IconButton
                        size="small"
                        aria-label={`adjust due date for ${r.site_address || `site ${r.property_id}`}`}
                        onClick={(e) => { e.stopPropagation(); setAdjustFor(r); }}
                      >
                        <EditCalendarIcon fontSize="small" />
                      </IconButton>
                      {r.adjusted && (
                        <IconButton
                          size="small"
                          aria-label={`return ${r.site_address || `site ${r.property_id}`} to schedule`}
                          onClick={async (e) => {
                            e.stopPropagation();
                            try {
                              await propertyService.closeDueAdjustment(r.property_id);
                              await load();
                            } catch (err: any) {
                              setError(err?.message || 'Could not close the adjustment');
                            }
                          }}
                        >
                          <SyncIcon fontSize="small" />
                        </IconButton>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {adjustFor && (
        <AdjustDueDialog
          row={adjustFor}
          onClose={() => setAdjustFor(null)}
          onDone={async () => { setAdjustFor(null); await load(); }}
        />
      )}

      {pages > 1 && (
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mt: 2 }}>
          <Button size="small" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <Typography variant="body2">
            page {page} of {pages.toLocaleString()}
          </Typography>
          <Button size="small" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </Box>
      )}
    </Box>
  );
};

export default DueQueuePage;
