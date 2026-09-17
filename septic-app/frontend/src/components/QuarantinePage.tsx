import React, { useCallback, useEffect, useState } from 'react';
import {
  Box, Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  ToggleButton, ToggleButtonGroup, Typography, Alert, Button, Paper, Chip,
  Skeleton, Collapse, IconButton, Tooltip,
} from '@mui/material';
import {
  ExpandMore as ExpandIcon, ExpandLess as CollapseIcon, Check as CheckIcon, Undo as UndoIcon,
} from '@mui/icons-material';
import { authService } from '../services/authService';
import {
  quarantineService, CAN_RESOLVE_ROLES, QuarantineFamily, QuarantineRow,
  QuarantineMeta, QuarantineStatus,
} from '../services/quarantineService';

/**
 * The quarantine queue.
 *
 * Every other screen in this app asks the database a question. This one asks the migration
 * one: which rows did you refuse, and were you right to.
 *
 * 3,876 rows sit here and none has been looked at. They are not errors to delete. They are
 * the difference between a migration that is 99.9% complete and one that can prove it — the
 * ETL wrote down everything it would not guess at, and this is where that gets read.
 *
 * The most important thing on this screen is the sentence under the family chips, because
 * the raw count is actively misleading. 81% of the queue is `orphan_line_*`, and those rows
 * are not wrong: the invoice line is fine, the invoice *header* was never exported. Nobody
 * can fix one by looking at it. Scrolling past 3,124 rows that all mean "the other half of
 * this file is missing" and reading that as 3,124 problems is how this queue would stay at
 * 3,876 forever.
 */

/**
 * What each family actually is, and what could be done about it.
 *
 * Written from the rows, not from the code names. `inspection_date_unparseable` sounds like
 * a parsing bug and is 715 blank cells and one year typo; the difference decides whether
 * somebody fixes a parser or goes and finds the paper.
 */
const FAMILY_NOTES: Record<string, { what: string; nowhat: string }> = {
  orphan_line_below_window: {
    what: 'An invoice line whose header is numbered below the exported range.',
    nowhat: 'Nothing to fix here. The invoice itself was never exported. Recovering these '
      + 'means obtaining the missing headers from the legacy system, not editing this row.',
  },
  orphan_line_in_gap: {
    what: 'An invoice line whose header is missing from inside the exported range.',
    nowhat: 'Same as below_window but the header should have been there. Worth one query '
      + 'against the legacy export before assuming the invoice does not exist.',
  },
  inspection_date_unparseable: {
    what: 'An inspection with no usable date. 715 of these are blank; exactly one has a '
      + 'value, and it reads 8/1/2508.',
    nowhat: 'A blank is not a parsing bug — the date was never written down. The one with a '
      + 'value is a typo worth correcting at the source. Dates outside 1900-2100 are '
      + 'rejected deliberately.',
  },
  invoice_date_missing_or_impossible: {
    what: 'An invoice that cannot be dated. 32 are blank; one reads 5/18/2393.',
    nowhat: 'Fix the one typo. The blanks mean the invoice has no date in the source at all.',
  },
  orphan_line_negative_invoice_number: {
    what: 'An invoice line whose invoice number is below zero.',
    nowhat: 'Six rows. Almost certainly a data-entry artifact; each needs a human to say '
      + 'which invoice was meant.',
  },
  orphan_line_header_quarantined: {
    what: 'An invoice line whose own header row was rejected, so the line came with it.',
    nowhat: 'Four rows. Resolve these only after the header row is dealt with.',
  },
  service_date_unparseable: {
    what: 'The only two ledger rows the transform refused: 12/21/217 and 4/1/158.',
    nowhat: 'Two rows, both three-digit years. Correct them in the source and re-run; they '
      + 'are the cheapest wins in the queue.',
  },
  orphan_line_past_max: {
    what: 'An invoice line numbered beyond the last known invoice.',
    nowhat: 'One row.',
  },
  amount_paid_exceeds_total: {
    what: 'An invoice recorded as paid more than its total. This one reads "paid 1256 of 125".',
    nowhat: 'The only live accounting discrepancy in the queue rather than a gap in the '
      + 'record. It needs a decision about the money, not a data fix.',
  },
};

const STATUSES: { value: QuarantineStatus; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'all', label: 'All' },
];

const PAGE_SIZE = 50;

const QuarantinePage: React.FC = () => {
  const [families, setFamilies] = useState<QuarantineFamily[]>([]);
  const [family, setFamily] = useState<string | null>(null);
  const [status, setStatus] = useState<QuarantineStatus>('open');
  const [rows, setRows] = useState<QuarantineRow[]>([]);
  const [meta, setMeta] = useState<QuarantineMeta | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number[]>([]);
  /** The row a write is in flight for, so one click cannot start two. */
  const [busy, setBusy] = useState<number | null>(null);

  // The server is the authority on who may close a row. This only decides whether the
  // button is offered, so that a driver is not shown a control that answers 403.
  const canResolve = authService.hasRole([...CAN_RESOLVE_ROLES]);

  const loadFamilies = useCallback(async () => {
    try {
      const res = await quarantineService.families();
      setFamilies(res.data);
    } catch (e: any) {
      setError(e.message || 'Could not load the family counts');
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await quarantineService.list({ family, status, page, limit: PAGE_SIZE });
      setRows(res.data);
      setMeta(res.meta || null);
    } catch (e: any) {
      setError(e.message || 'Could not load the queue');
    } finally {
      setLoading(false);
    }
  }, [family, status, page]);

  useEffect(() => { loadFamilies(); }, [loadFamilies]);
  useEffect(() => { load(); }, [load]);

  const toggle = (id: number) => setExpanded((prev) => (
    prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
  ));

  /**
   * Close or reopen one row, then reload the queue and the counts.
   *
   * The counts reload too, because the headline number is the thing a person is working
   * down. Leaving it stale after a resolve would make the screen disagree with itself, and
   * a tool that disagrees with itself does not get trusted for long.
   */
  const act = async (row: QuarantineRow, action: 'resolve' | 'unresolve') => {
    setBusy(row.id);
    setError(null);
    try {
      await quarantineService[action](row.id);
      await Promise.all([load(), loadFamilies()]);
    } catch (e: any) {
      setError(e.message || `Could not ${action} row ${row.id}`);
    } finally {
      setBusy(null);
    }
  };

  const totalOpen = families.reduce((acc, f) => acc + Number(f.open), 0);
  const totalAll = families.reduce((acc, f) => acc + Number(f.total), 0);
  const pages = meta ? Math.max(1, Math.ceil(meta.total / meta.limit)) : 1;
  const note = family ? FAMILY_NOTES[family] : undefined;

  return (
    <Box>
      <Typography variant="body1" sx={{ mb: 1 }}>
        {totalAll.toLocaleString()} rows were refused by the migration and kept rather than
        guessed at. {totalOpen.toLocaleString()} are still open.
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        These are not errors to delete. Most of them are not wrong at all — they are rows the
        ETL would not interpret without a human, which is the difference between a migration
        that is nearly finished and one that can be checked.
      </Typography>

      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 2 }}>
        <Chip
          size="small"
          color={family === null ? 'primary' : 'default'}
          label={`all families (${totalAll.toLocaleString()})`}
          onClick={() => { setFamily(null); setPage(1); }}
        />
        {families.map((f) => (
          <Chip
            key={f.family}
            size="small"
            color={family === f.family ? 'primary' : 'default'}
            label={`${f.family} (${Number(f.open).toLocaleString()} open)`}
            onClick={() => { setFamily(f.family); setPage(1); }}
          />
        ))}
      </Box>

      {note && (
        <Alert severity="info" sx={{ mb: 2 }}>
          <Typography variant="body2" gutterBottom>{note.what}</Typography>
          <Typography variant="body2" sx={{ opacity: 0.85 }}>{note.nowhat}</Typography>
        </Alert>
      )}

      {!canResolve && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Drivers can read this queue but not close rows in it. Deciding that a data problem
          is dealt with is an office decision.
        </Alert>
      )}

      <ToggleButtonGroup
        exclusive
        size="small"
        sx={{ mb: 2 }}
        value={status}
        onChange={(_e, v) => {
          if (v && v !== status) {
            setStatus(v as QuarantineStatus);
            setPage(1);
          }
        }}
      >
        {STATUSES.map((s) => (
          <ToggleButton key={s.value} value={s.value} sx={{ px: 2 }}>
            {s.label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>

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
        <TableContainer component={Paper} sx={{ maxHeight: 'calc(100vh - 400px)' }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell width={44} />
                <TableCell width={190}>File : line</TableCell>
                <TableCell>Why it was refused</TableCell>
                <TableCell width={150}>Resolved by</TableCell>
                {canResolve && <TableCell width={110} align="right"> </TableCell>}
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={canResolve ? 5 : 4}
                    align="center"
                    sx={{ py: 6 }}
                  >
                    <Typography color="text.secondary">
                      {status === 'open'
                        ? 'Nothing open in this view.'
                        : 'Nothing here.'}
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
              {rows.map((r) => {
                const open = expanded.includes(r.id);
                return (
                  <React.Fragment key={r.id}>
                    <TableRow hover>
                      <TableCell padding="checkbox">
                        <IconButton size="small" onClick={() => toggle(r.id)} aria-label="show the source row">
                          {open ? <CollapseIcon fontSize="small" /> : <ExpandIcon fontSize="small" />}
                        </IconButton>
                      </TableCell>
                      <TableCell>
                        {r.source_file}
                        <Typography variant="caption" display="block" color="text.secondary">
                          line {r.row_no}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
                          {r.reason}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        {r.resolved_at ? (
                          <Tooltip title={`resolved ${r.resolved_at}`}>
                            <Chip size="small" color="success" label={r.resolved_by_name || 'closed'} />
                          </Tooltip>
                        ) : (
                          <Chip size="small" variant="outlined" label="open" />
                        )}
                      </TableCell>
                      {canResolve && (
                        <TableCell align="right">
                          <Button
                            size="small"
                            disabled={busy === r.id}
                            startIcon={r.resolved_at ? <UndoIcon /> : <CheckIcon />}
                            onClick={() => act(r, r.resolved_at ? 'unresolve' : 'resolve')}
                          >
                            {r.resolved_at ? 'Reopen' : 'Resolve'}
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                    <TableRow>
                      <TableCell colSpan={canResolve ? 5 : 4} sx={{ py: 0, bgcolor: 'grey.50' }}>
                        <Collapse in={open} unmountOnExit>
                          <Box sx={{ py: 1.5 }}>
                            <Typography variant="caption" color="text.secondary" display="block">
                              The source row exactly as the file had it. Values are shown as
                              written — "$175.00" and not 175 — because what the CSV contained
                              is the reason this row is here.
                            </Typography>
                            <Box component="dl" sx={{ m: 0, mt: 1, columnCount: { sm: 2 } }}>
                              {Object.entries(r.raw).map(([k, v]) => (
                                <Box key={k} sx={{ mb: 0.5, breakInside: 'avoid' }}>
                                  <Typography variant="caption" component="dt" color="text.secondary">
                                    {k}
                                  </Typography>
                                  <Typography variant="body2" component="dd" sx={{ m: 0 }}>
                                    {v === null ? <em>null</em> : v}
                                  </Typography>
                                </Box>
                              ))}
                            </Box>
                          </Box>
                        </Collapse>
                      </TableCell>
                    </TableRow>
                  </React.Fragment>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {pages > 1 && (
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mt: 2 }}>
          <Button size="small" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <Typography variant="body2">
            page {page} of {pages.toLocaleString()} · {meta?.total.toLocaleString()} rows
          </Typography>
          <Button size="small" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </Box>
      )}
    </Box>
  );
};

export default QuarantinePage;
