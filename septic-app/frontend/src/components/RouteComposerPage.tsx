import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { usDate } from '../format';
import {
  Alert, Box, Button, Chip, Divider, FormControl, IconButton, InputLabel, MenuItem,
  Paper, Select, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  TextField, Typography,
} from '@mui/material';
import { ArrowDownward, ArrowUpward, Delete as DeleteIcon } from '@mui/icons-material';
import { propertyService } from '../services/propertyService';
import { ApiError, CAN_ROUTE_ROLES, DriverOption, RouteDetail, RouteSummary, routeService, DisposalSite } from '../services/routeService';
import { authService } from '../services/authService';

/**
 * The office composing a day.
 *
 * Three screens' worth of restraint went into this one, and the omissions are the design:
 *
 *  - **No drag-and-drop.** Reordering is up-and-down arrows against a `version`. Drag-and-drop
 *    invites a save per pixel of movement, and each of those is a write that can lose the
 *    optimistic-lock race against the other tablet. An arrow is one intent, one request, and
 *    the order is only ever the order the server agreed to.
 *
 *  - **No way to mark a stop done.** That is the driver's, from the truck, timestamped by the
 *    server (DRV-06/08). An office keyboard writing it would be a claim about where a truck is
 *    that nobody in the office witnessed, and the ledger is worth more than the shortcut.
 *
 *  - **The duplicate refusal is shown, not prevented.** A site already routed that day comes
 *    back 409 with the date, the driver, and the route that holds it — because the office needs
 *    to know where it went, not merely that it cannot go here. Suppressing the button instead
 *    would hide the answer to the question they were actually asking.
 *
 * The `version` on the screen is the version that was read. A 409 on a reorder means the day
 * moved underneath this tab, and the only honest response is to reload it and let the person
 * look at what is there now — never to resend the same body, which is how two clerks quietly
 * overwrite one another.
 */

const STATUS_COLOR: Record<string, 'default' | 'primary' | 'success' | 'warning'> = {
  draft: 'default', published: 'primary', in_progress: 'warning', done: 'success',
};

const RouteComposerPage: React.FC = () => {
  const role = authService.getUser()?.role ?? '';
  const canRoute = CAN_ROUTE_ROLES.includes(role);
  const [params] = useSearchParams();

  // A handoff can arrive by URL: the site-detail page adds a stop and links to
  // `/routes?date=…&focus=…` so the clerk lands on the route they just touched.
  // Seeded once from the query — after mount the date field and the selected
  // route are the truth, and the board's own polling must not fight a param
  // that stays in the address bar.
  const [date, setDate] = useState(params.get('date') ?? '');
  const focusRef = React.useRef(Number(params.get('focus')) || 0);
  const [routes, setRoutes] = useState<RouteSummary[]>([]);
  const [serverToday, setServerToday] = useState('');
  const [selected, setSelected] = useState<RouteDetail | null>(null);
  const [drivers, setDrivers] = useState<DriverOption[]>([]);
  const [driverId, setDriverId] = useState(0);
  const [truck, setTruck] = useState('');
  const selectedRef = React.useRef<number | null>(null);
  const [sites, setSites] = useState<DisposalSite[]>([]);

  useEffect(() => {
    routeService.disposalSites().then(setSites).catch(() => setSites([]));
  }, []);

  const moveDefault = async (siteId: number) => {
    try {
      await routeService.setDisposalDefault(siteId);
      setSites((prev) => prev.map((x) => ({ ...x, is_default: x.id === siteId })));
      setNotice({ kind: 'info', text: 'Driver Done dialogs now pre-select that site.' });
    } catch (err) {
      report(err, 'Could not move the default');
    }
  };
  const [addTerm, setAddTerm] = useState('');
  const [candidates, setCandidates] = useState<
    { id: number; legacy_cust_number: number | null; site_address: string | null;
      site_city: string | null; payer_label: string | null }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);

  /** Reports a refusal in the server's words. Never swallows one into an empty list. */
  const report = (err: unknown, fallback: string) => {
    const text = err instanceof Error ? err.message : fallback;
    setNotice({ kind: 'error', text });
  };

  const loadDay = useCallback(async () => {
    try {
      const { data, meta } = await routeService.forDate(date || undefined);
      setRoutes(data);
      // From the envelope, not from rows[0]: an empty day has no rows, and an empty day is the
      // state this screen is about to act on.
      if (meta?.business_today) setServerToday(meta.business_today);
    } catch (err) {
      report(err, 'Could not load that day');
    }
  }, [date]);

  useEffect(() => { loadDay(); }, [loadDay]);

  /**
   * The day moves underneath this tab: a driver taps Arrived on a phone in a
   * driveway and the office board should say so without anyone hunting for
   * the refresh. Fifteen seconds, and only while the tab is actually visible
   * — a board left open overnight has no business polling a sleeping server,
   * and a hidden tab that polls shows a person a stale screen either way.
   * Silent on success; a failed poll sets the notice once and keeps the rows
   * it already had, because "could not refresh" is different news from
   * "nobody routed today".
   */
  useEffect(() => {
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        await loadDay();
        if (selectedRef.current) await openRoute(selectedRef.current);
      } catch { /* keep showing yesterday's truth; next tick tries again */ }
    };
    const timer = setInterval(tick, 15000);
    return () => clearInterval(timer);
  }, [loadDay]);
  useEffect(() => {
    routeService.drivers()
      .then(({ data }) => setDrivers(data as DriverOption[]))
      .catch((err) => report(err, 'Could not load the drivers'));
  }, []);

  const openRoute = async (id: number) => {
    try {
      const { data } = await routeService.detail(id);
      setSelected(data);
      selectedRef.current = id;
      setNotice(null);
    } catch (err) {
      report(err, 'Could not open that route');
    }
  };

  // The handoff, once: open the route the clerk just added a stop to, then
  // retire the anchor so a later refresh does not yank the selection back
  // after they have opened something else.
  useEffect(() => {
    if (!focusRef.current) return;
    const id = focusRef.current;
    focusRef.current = 0;
    openRoute(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Every mutation ends the same way: reload from the server, including after a failure. */
  const after = async (id: number) => {
    await openRoute(id);
    await loadDay();
  };

  /**
   * Search first, then add what was picked.
   *
   * Adding by a bare number and hoping is the shape that produces "Property not found" for a
   * typo and, worse, adds the wrong site for a number that happens to exist. The server cannot
   * tell 3494-the-site from 3494-the-typo; a person looking at two addresses can.
   */
  const search = async () => {
    const term = addTerm.trim();
    if (term.length < 2) {
      setNotice({ kind: 'error', text: 'Type a customer number or part of an address.' });
      return;
    }
    setBusy(true);
    try {
      const { data } = await propertyService.search(term);
      setCandidates(data.slice(0, 8));
      if (!data.length) setNotice({ kind: 'info', text: `Nothing matches “${term}”.` });
    } catch (err) {
      report(err, 'Could not search for a site');
    } finally {
      setBusy(false);
    }
  };

  const addStop = async (propertyId: number) => {
    if (!selected) return;
    try {
      await routeService.addStop(selected.id, propertyId);
      setCandidates([]);
      setAddTerm('');
      setNotice(null);
      await after(selected.id);
    } catch (err) {
      // 409 carries the date, the driver and the route that already holds this site. Showing
      // only "already routed" would send the clerk to hunt for it.
      setCandidates([]);
      report(err, 'Could not add that stop');
      await after(selected.id);
    }
  };

  /**
   * One arrow, one request, one intent.
   *
   * The list is rewritten as a whole permutation because that is what the endpoint accepts and
   * what the database can apply atomically — a partial "swap these two" would need the server to
   * know the rest of the order anyway.
   */
  const move = async (stopId: number, direction: -1 | 1) => {
    if (!selected) return;
    const ids = selected.stops.map((s) => s.id);
    const at = ids.indexOf(stopId);
    const to = at + direction;
    if (at < 0 || to < 0 || to >= ids.length) return;
    [ids[at], ids[to]] = [ids[to], ids[at]];
    try {
      await routeService.reorder(selected.id, ids, selected.version);
      setNotice(null);
    } catch (err) {
      report(err, 'Could not reorder that day');
      if (err instanceof ApiError && err.status === 409) setNotice({
        kind: 'error',
        text: `${err.message} Reloading the day so you can see what is there now.`,
      });
    }
    // Always reload. After a lost race the screen must show the server's order, not the one
    // this tab wanted, or the next arrow is aimed at a position that no longer exists.
    await after(selected.id);
  };

  const remove = async (stopId: number) => {
    if (!selected) return;
    try {
      await routeService.removeStop(selected.id, stopId);
      setNotice(null);
    } catch (err) {
      report(err, 'Could not remove that stop');
    }
    await after(selected.id);
  };

  const setPublished = async (publish: boolean) => {
    if (!selected) return;
    setBusy(true);
    try {
      const run = publish ? routeService.publish : routeService.unpublish;
      const { data } = await run(selected.id);
      setNotice(publish && (data as { already_published?: boolean }).already_published
        ? { kind: 'info', text: 'That day was already published. Nothing was published twice.' }
        : null);
      await after(selected.id);
      await loadDay();
    } catch (err) {
      report(err, 'Could not change that day');
      await after(selected.id);
    } finally {
      setBusy(false);
    }
  };

  const ordered = useMemo(() => selected?.stops ?? [], [selected]);

  const create = async () => {
    if (!driverId) return;
    setBusy(true);
    try {
      const { data } = await routeService.create({
        route_date: date || serverToday, driver_id: driverId, truck_label: truck || null,
      });
      setTruck('');
      setNotice(null);
      await loadDay();
      await openRoute(data.id);
    } catch (err) {
      // 409 here means the day already exists for that driver, and the body names it. That is
      // the useful case: open it rather than making the clerk go looking.
      if (err instanceof ApiError && err.status === 409 && err.body.route_id) {
        setNotice({ kind: 'info', text: err.message });
        await openRoute(err.body.route_id);
      } else {
        report(err, 'Could not create that route');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
        <TextField
          label="Day" type="date" size="small" value={date}
          onChange={(e) => setDate(e.target.value)}
          InputLabelProps={{ shrink: true }}
          helperText={serverToday ? `Server’s today: ${serverToday}` : ' '}
        />
        <FormControl size="small" sx={{ minWidth: 200 }}>
          <InputLabel id="driver-picker">Driver</InputLabel>
          <Select
            labelId="driver-picker" label="Driver" value={driverId || ''}
            onChange={(e) => setDriverId(Number(e.target.value))}
          >
            {drivers.map((d) => (
              <MenuItem key={d.id} value={d.id}>{d.last_name}, {d.first_name}</MenuItem>
            ))}
          </Select>
        </FormControl>
        <TextField
          label="Truck" size="small" value={truck} onChange={(e) => setTruck(e.target.value)}
          sx={{ width: 120 }}
        />
        {/* DRV-20: where the waste usually goes. One number the office owns,
            and the only place a default is chosen — the server deliberately
            never falls back to it, so it must be set in the open, here. */}
        <FormControl size="small" sx={{ minWidth: 220 }}>
          <InputLabel htmlFor="default-site-select">Default disposal site</InputLabel>
          <Select
            native
            inputProps={{ id: 'default-site-select' }}
            labelId="site-default-picker" label="Default disposal site"
            value={sites.find((x) => x.is_default)?.id ?? ''}
            onChange={(e) => void moveDefault(Number(e.target.value))}
          >
            <option value="">Not set</option>
            {sites.map((x) => (
              <option key={x.id} value={x.id}>{x.name}</option>
            ))}
          </Select>
        </FormControl>
        <Button variant="contained" onClick={create} disabled={!canRoute || !driverId || busy}>
          Open the day
        </Button>
      </Stack>

      {!canRoute && (
        <Alert severity="info" sx={{ mb: 2 }}>
          You can read the schedule but not change it. Composing a day belongs to the office.
        </Alert>
      )}

      {notice && (
        <Alert severity={notice.kind} sx={{ mb: 2 }} onClose={() => setNotice(null)}>
          {notice.text}
        </Alert>
      )}

      <TableContainer component={Paper} sx={{ mb: 3 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Driver</TableCell>
              <TableCell>Status</TableCell>
              <TableCell align="right">Stops</TableCell>
              <TableCell align="right">Left</TableCell>
              <TableCell>Truck</TableCell>
              <TableCell align="right">Version</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {routes.length === 0 && (
              <TableRow><TableCell colSpan={6}>No routes on that day.</TableCell></TableRow>
            )}
            {routes.map((r) => (
              <TableRow
                key={r.id} hover selected={selected?.id === r.id}
                sx={{ cursor: 'pointer' }} onClick={() => openRoute(r.id)}
              >
                <TableCell>{r.last_name}, {r.first_name}</TableCell>
                <TableCell>
                  <Chip size="small" color={STATUS_COLOR[r.status]} label={r.status} />
                </TableCell>
                <TableCell align="right">{r.stop_count}</TableCell>
                <TableCell align="right">{r.pending_count}</TableCell>
                <TableCell>{r.truck_label || '—'}</TableCell>
                <TableCell align="right">{r.version}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      {selected && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
            <Typography variant="h6" sx={{ flexGrow: 1 }}>
              {usDate(selected.route_date)} · {selected.last_name}, {selected.first_name}
            </Typography>
            <Chip size="small" color={STATUS_COLOR[selected.status]} label={selected.status} />
            <Button
              size="small" disabled={busy || !canRoute}
              onClick={() => setPublished(selected.status === 'draft')}
            >
              {selected.status === 'draft' ? 'Publish' : 'Unpublish'}
            </Button>
          </Stack>

          {/* Said out loud because it is the thing a stale tab cannot see. The number is not
              decoration: it is what the next save is checked against. */}
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
            version {selected.version} — a save that loses a race with another tablet is refused,
            not merged.
          </Typography>

          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell align="right">#</TableCell>
                  <TableCell>Cust #</TableCell>
                  <TableCell>Site</TableCell>
                  <TableCell>County</TableCell>
                  <TableCell align="right">Tanks</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell align="right">Order</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {ordered.length === 0 && (
                  <TableRow><TableCell colSpan={7}>Nothing on this day yet.</TableCell></TableRow>
                )}
                {ordered.map((s, i) => (
                  <TableRow key={s.id}>
                    <TableCell align="right">{s.sequence_no}</TableCell>
                    <TableCell>{s.legacy_cust_number ?? '—'}</TableCell>
                    <TableCell>
                      {s.site_address || s.payer_label || `Property ${s.property_id}`}
                      {s.site_city ? `, ${s.site_city}` : ''}
                    </TableCell>
                    <TableCell>{s.county_name || '—'}</TableCell>
                    <TableCell align="right">{s.tank_count}</TableCell>
                    <TableCell>{s.status}</TableCell>
                    <TableCell align="right">
                      <IconButton size="small" disabled={!canRoute || i === 0}
                        onClick={() => move(s.id, -1)} aria-label="move up">
                        <ArrowUpward fontSize="small" />
                      </IconButton>
                      <IconButton size="small"
                        disabled={!canRoute || i === ordered.length - 1}
                        onClick={() => move(s.id, 1)} aria-label="move down">
                        <ArrowDownward fontSize="small" />
                      </IconButton>
                      <IconButton size="small" disabled={!canRoute}
                        onClick={() => remove(s.id)} aria-label="remove stop">
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>

          {selected.status === 'draft' && canRoute && (
            <>
              <Divider sx={{ my: 2 }} />
              <Stack direction="row" spacing={1} alignItems="flex-start">
                <TextField
                  label="Add a site" size="small" value={addTerm}
                  onChange={(e) => setAddTerm(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') search(); }}
                  placeholder="cust # or part of an address"
                />
                <Button variant="outlined" onClick={search} disabled={busy}>Search</Button>
              </Stack>
              {candidates.length > 0 && (
                <Stack direction="row" spacing={1} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
                  {candidates.map((c) => (
                    <Chip
                      key={c.id}
                      label={`${c.legacy_cust_number ?? '?'} · `
                        + `${c.site_address || c.payer_label || c.id}`}
                      onClick={() => addStop(c.id)}
                    />
                  ))}
                </Stack>
              )}
            </>
          )}
        </Paper>
      )}
    </Box>
  );
};

export default RouteComposerPage;

