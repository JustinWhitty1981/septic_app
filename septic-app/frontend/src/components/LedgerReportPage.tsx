import React, { useCallback, useEffect, useState } from 'react';
import {
  Box, Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Typography, Alert, Paper, Chip, Skeleton, Stack, TextField, Button, Divider,
} from '@mui/material';
import {
  ledgerService, messageOf, LedgerReport, ReportSiteRow,
} from '../services/ledgerService';

/**
 * The state report (LED-02).
 *
 * This is the screen that replaces `tblStateReports`, and the whole reason the
 * table is gone: a stored tally drifts from its source and nobody notices
 * until an auditor asks why the number on paper and the number in the ledger
 * disagree. Every load here recomputes from `service_events`; the header says
 * so in the server's own words, because a report that looks cached is treated
 * as cached — the sentence exists to make the freshness visible, not
 * decorative.
 *
 * The two things a reader must not miss:
 *
 *  - `events_without_gallons` is a *column*, not a footnote. Twenty percent of
 *    the imported ledger has no gallons (LED-04), and a totals row that only
 *    sums what was remembered teaches people to trust a partial number.
 *  - Only completed, uncorrected heads are counted. The report excludes
 *    superseded rows — corrections replace, they do not add — and the
 *    explanation belongs on the screen, because "the number is smaller than
 *    the row count" is otherwise read as missing data.
 */

const money = (n: string | number) => Number(n).toLocaleString();

const LedgerReportPage: React.FC = () => {
  const [report, setReport] = useState<LedgerReport | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showSites, setShowSites] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await ledgerService.report(from || undefined, to || undefined));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => { load(); }, [load]);

  const flagged = report ? report.totals.events_without_gallons : 0;
  const siteRows: ReportSiteRow[] = report && showSites ? report.by_site : [];

  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1, flexWrap: 'wrap' }}>
        <Typography variant="h5">State report</Typography>
        <Chip size="small" label="computed per request" color="success" variant="outlined" />
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Generated from service events at request time. Only completed records that
        no correction supersedes are counted; a corrected event appears as its
        correction, once.
      </Typography>

      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap">
        <TextField
          label="From" type="date" size="small" value={from}
          onChange={(e) => setFrom(e.target.value)}
          InputLabelProps={{ shrink: true }} inputProps={{ 'aria-label': 'report start date' }}
        />
        <TextField
          label="To" type="date" size="small" value={to}
          onChange={(e) => setTo(e.target.value)}
          InputLabelProps={{ shrink: true }} inputProps={{ 'aria-label': 'report end date' }}
        />
        <Button variant="contained" onClick={load} disabled={loading}>Apply</Button>
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {loading && !report && (
        <Box><Skeleton variant="rectangular" height={60} /><Skeleton variant="rectangular" height={240} /></Box>
      )}

      {report && (
        <>
          <Stack direction="row" spacing={2} sx={{ mb: 2 }} flexWrap="wrap">
            <Paper sx={{ p: 2, minWidth: 140 }}>
              <Typography variant="caption" color="text.secondary">Records</Typography>
              <Typography variant="h5">{money(report.totals.events)}</Typography>
            </Paper>
            <Paper sx={{ p: 2, minWidth: 140 }}>
              <Typography variant="caption" color="text.secondary">Gallons</Typography>
              <Typography variant="h5">{money(report.totals.gallons)}</Typography>
            </Paper>
            <Paper
              sx={{
                p: 2, minWidth: 160,
                bgcolor: flagged ? 'warning.light' : undefined,
              }}
            >
              <Typography variant="caption" color="text.secondary">No gallons recorded</Typography>
              <Typography variant="h5">{money(flagged)}</Typography>
              {flagged > 0 && (
                <Typography variant="caption">
                  These rows count as events; their gallons are simply absent (LED-04).
                </Typography>
              )}
            </Paper>
          </Stack>

          <Typography variant="subtitle1" sx={{ mb: 1 }}>
            {report.from} to {report.to}
          </Typography>
          <TableContainer component={Paper} sx={{ maxHeight: 420, mb: 3 }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell>Month</TableCell>
                  <TableCell align="right">Events</TableCell>
                  <TableCell align="right">No gallons</TableCell>
                  <TableCell align="right">Gallons</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {report.months.map((m) => (
                  <TableRow key={m.month} hover>
                    <TableCell>{m.month}</TableCell>
                    <TableCell align="right">{money(m.events)}</TableCell>
                    <TableCell align="right">
                      {m.events_without_gallons > 0
                        ? <Chip size="small" color="warning" label={m.events_without_gallons} />
                        : 0}
                    </TableCell>
                    <TableCell align="right">{money(m.gallons)}</TableCell>
                  </TableRow>
                ))}
                {!report.months.length && (
                  <TableRow><TableCell colSpan={4}>No completed events in this range.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>

          <Divider sx={{ mb: 1 }} />
          <Button onClick={() => setShowSites(!showSites)}>
            {showSites ? 'Hide' : 'Show'} per-site breakdown
          </Button>
          {showSites && (
            <TableContainer component={Paper} sx={{ maxHeight: 420, mt: 1 }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell>Month</TableCell>
                    <TableCell>Disposal site</TableCell>
                    <TableCell align="right">Events</TableCell>
                    <TableCell align="right">No gallons</TableCell>
                    <TableCell align="right">Gallons</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {siteRows.map((r, i) => (
                    <TableRow key={`${r.month}-${r.disposal_site_id ?? 'none'}-${i}`} hover>
                      <TableCell>{r.month}</TableCell>
                      <TableCell sx={r.disposal_site_id === null ? { fontStyle: 'italic' } : undefined}>
                        {r.disposal_site}
                      </TableCell>
                      <TableCell align="right">{money(r.events)}</TableCell>
                      <TableCell align="right">
                        {r.events_without_gallons > 0
                          ? <Chip size="small" color="warning" label={r.events_without_gallons} />
                          : 0}
                      </TableCell>
                      <TableCell align="right">{money(r.gallons)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
            {report.generated}
          </Typography>
        </>
      )}
    </Box>
  );
};

export default LedgerReportPage;
