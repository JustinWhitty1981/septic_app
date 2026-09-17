import React, { useCallback, useEffect, useRef, useState } from 'react';
import { usDate } from '../format';
import {
  Alert, Box, Chip, CircularProgress, Divider, IconButton, Paper, Stack, Typography,
} from '@mui/material';
import { Warning as WarningIcon, Refresh as RefreshIcon } from '@mui/icons-material';
import { ApiError, DispatchDay, DispatchStop, DisposalSite, routeService } from '../services/routeService';
import { authService } from '../services/authService';
import StopActions from './StopActions';
import { DeviceStopStatus } from '../offline/dispatchQueue';
import CapturePanel from './CapturePanel';
import QueueStrip from './QueueStrip';
import { QueuedForStop, StopRecorder, useOutbox } from '../hooks/useOutbox';

/**
 * The driver's day. One request, one list, in the order the office chose.
 *
 * This is the screen the whole scheduling slice exists to feed. Three rules shaped it, and
 * each is the difference between something a person can use standing at a truck in a driveway
 * and something that looks fine on a laptop in the office.
 *
 *  - **Everything is already here.** Address, both county spellings, every tank in both
 *    forms, the three field notes, the due date. There is no tap that fetches, because a
 *    fetch at a jobsite is a spinner at a jobsite, and the reason the payload is one request
 *    is that thirteen can each fail alone (DRV-01).
 *
 *  - **The raw string is not hidden behind the tidy one.** `2000 triple` is what is
 *    stencilled on the lid; `2,000 gal · primary` is what the invoice needs. Showing only the
 *    parsed value makes the parse unfalsifiable, and the parse came out of a spreadsheet
 *    (P3, DRV-03). Same argument, same page, for `county_raw` beside `county_name`.
 *
 *  - **An empty day says why.** A 404 here is not an empty list. "Nothing published for you
 *    today" tells a driver to wait or to phone the office; a blank screen tells them the app
 *    is broken and starts the phone call with "it isn't loading". The server already
 *    distinguishes the two; the screen has to keep the distinction.
 *
 * What the buttons at the bottom of each card do is DRV-06 through DRV-09, and they are the
 * reason this screen is the last one built rather than the first. The server had to own the
 * timestamps before a device could ask for them (DRV-08), and a control that writes to the
 * regulatory ledger had to arrive with the volume field, the no-access path and an honest
 * statement of what has not been sent yet — a bare *Done* button on a phone with no signal
 * would have been worse than the missing feature it replaced. Those are `StopActions` and
 * `QueueStrip`; the queue underneath them is `src/offline/`.
 *
 * The one thing still not here is notes and photos. `job_notes` and `media` have no endpoint,
 * so there is nothing for those controls to talk to, and the queue is waiting rather than the
 * screen.
 */

const NOTE_LABELS: Array<[keyof DispatchStop, string]> = [
  ['tank_location_note', 'Tank location'],
  ['jobsite_location_note', 'Job site'],
  ['chamber_pump_note', 'Chamber / pump'],
  ['system_condition_note', 'System condition'],
];

/**
 * One stop, as the driver sees it.
 *
 * Exported for the rendering tests in `StopCard.render.test.tsx`. DRV-03/04/05/10/11 are all
 * worded as something a driver *sees on the card*, and this is the component they name. The
 * page-level path — this card inside a day, inside the queue — stays covered by
 * `DispatchPage.test.tsx`; these tests aim at the card itself so a fixture can be exactly the
 * awkward record a requirement is about.
 */
export const StopCard: React.FC<{
  stop: DispatchStop;
  queued: QueuedForStop | undefined;
  onRecord: StopRecorder;
  sites?: DisposalSite[];
  sitesLoading?: boolean;
  onNeedSites?: () => void;
  /** The day is closed: the machine has no next state to offer. */
  frozen?: boolean;
}> = ({ stop, queued, onRecord, sites, sitesLoading, onNeedSites, frozen }) => {
  const notes = NOTE_LABELS
    .map(([key, label]) => ({ label, value: stop[key] as string | null }))
    .filter((n) => n.value && n.value.trim().length > 0);

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack direction="row" spacing={1.5} alignItems="flex-start">
        <Chip
          label={stop.sequence_no}
          color="primary"
          sx={{ fontWeight: 700, minWidth: 34, height: 34 }}
        />
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography variant="h6" component="div" noWrap>
            {stop.payer_label || `Property ${stop.property_id}`}
          </Typography>

          {/* The number a crew says out loud. P2: the legacy notes carry it verbatim —
              'See their house cust #3494' — so a screen that shows only the payer name makes
              the radio call harder than it has to be. */}
          {stop.legacy_cust_number !== null && (
            <Typography variant="body2" color="text.secondary">
              cust #{stop.legacy_cust_number}
            </Typography>
          )}

          <Typography variant="body1" sx={{ mt: 0.5 }}>
            {stop.site_address || 'No address on record'}
            {stop.site_city ? `, ${stop.site_city}` : ''}
            {stop.site_state ? ` ${stop.site_state}` : ''}
            {stop.site_zip ? ` ${stop.site_zip}` : ''}
          </Typography>

          {/* Both spellings, because they are not the same claim. One is what the county is
              called; the other is what the paperwork said, and 34 different things have been
              written in that field for 7 counties. */}
          <Typography variant="body2" color="text.secondary">
            {stop.county_name || 'County not recorded'}
            {stop.county_raw && stop.county_raw !== stop.county_name
              ? ` (recorded as “${stop.county_raw}”)` : ''}
          </Typography>

          <Divider sx={{ my: 1 }} />

          {stop.tanks.length === 0 ? (
            <Typography variant="body2" color="warning.main">
              No tanks recorded for this site.
            </Typography>
          ) : (
            <Stack spacing={0.5}>
              {stop.tanks.map((t) => (
                <Stack key={t.sequence_no} direction="row" spacing={1} alignItems="baseline">
                  <Typography variant="body2" sx={{ minWidth: 24 }}>{t.sequence_no}.</Typography>
                  <Typography variant="body2" sx={{ minWidth: 96 }}>
                    {t.gallons !== null ? `${t.gallons.toLocaleString()} gal` : 'size not parsed'}
                  </Typography>
                  <Chip size="small" variant="outlined" label={t.role} />
                  {t.has_filter && <Chip size="small" label="filter" />}
                  {/* Verbatim, always. If the parse is wrong, this is the only way to see it. */}
                  <Typography
                    variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}
                  >
                    “{t.raw}”
                  </Typography>
                </Stack>
              ))}
            </Stack>
          )}

          {notes.length > 0 && (
            <Box sx={{ mt: 1 }}>
              {notes.map((n) => (
                <Box key={n.label} sx={{ mb: 0.5 }}>
                  <Typography variant="caption" color="text.secondary" display="block">
                    {n.label}
                  </Typography>
                  {/* Whitespace preserved. The reason is narrower than the one originally
                      written here, which claimed these notes contain line breaks: none of the
                      7,427 do, and none contain a double space or a leading space either. It
                      is kept because they are free text typed by whoever answered the phone,
                      and a future record that does have a break should render what was
                      written rather than collapse it. Defensive, not load-bearing. */}
                  <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                    {n.value}
                  </Typography>
                </Box>
              ))}
            </Box>
          )}

          <Stack direction="row" spacing={1} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
            {stop.reminder_opt_out && (
              <Chip size="small" color="warning" icon={<WarningIcon />} label="No reminders" />
            )}
            {stop.next_service_due && (
              <Chip size="small" variant="outlined" label={`Due ${stop.next_service_due}`} />
            )}
            {stop.stop_status !== 'pending' && (
              <Chip size="small" color="success" label={stop.stop_status} />
            )}
          </Stack>

          {/* Deliberately kept showing the server's status beside the queued one. A card that
              quietly displayed "done" the moment it was tapped would be a lie of the kind
              this ledger cannot afford: the office has not heard about it yet, and if the
              phone never reaches the office it never happened. */}
          <StopActions
            sites={sites}
            sitesLoading={sitesLoading}
            onNeedSites={onNeedSites}
            stopId={stop.stop_id}
            status={stop.stop_status}
            queued={queued}
            frozen={frozen}
            onRecord={onRecord}
          />
          {/* What the device saw, appended beside what the machine decided. */}
          <CapturePanel stopId={stop.stop_id} propertyId={stop.property_id} />
        </Box>
      </Stack>
    </Paper>
  );
};

const DispatchPage: React.FC = () => {
  const [day, setDay] = useState<DispatchDay | null>(null);
  // The day as last read from the server, reachable from inside the stable
  // `load` closure — a 404 has to be read against what is on screen.
  const dayRef = useRef<DispatchDay | null>(null);
  const [dayClosed, setDayClosed] = useState(false);
  const dayClosedRef = useRef(false);
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [message, setMessage] = useState('');
  const { queuedByStop, pendingCount, record } = useOutbox();

  /**
   * Where waste may lawfully go, fetched with the day. `done` cannot be
   * written without naming a site, so a screen that loaded its stops but not
   * its sites is a screen that can arrive and never complete — and the empty
   * list says exactly that, in the Done row, rather than letting the tap
   * die as an invisible 400.
   */
  const [sites, setSites] = useState<DisposalSite[]>([]);
  const [sitesLoading, setSitesLoading] = useState(true);
  const fetchSites = useCallback(() => {
    setSitesLoading(true);
    routeService.disposalSites()
      .then(setSites)
      .catch(() => setSites([]))
      .finally(() => setSitesLoading(false));
  }, []);
  useEffect(() => { fetchSites(); }, [fetchSites]);

  /**
   * `silent` exists because a refresh that flashes a spinner over a driver's list is worse
   * than no refresh. The day is already on screen and still correct in its ordering; the
   * only thing changing is which stops the office has now heard about.
   */
  const load = useCallback(async (
    silent = false,
    reason: 'tap' | 'drain' | 'poll' | 'manual' = 'poll',
    // A settled write whose re-read found the day gone: the server has the
    // status, and the screen should too. Applied only on the close branch —
    // anywhere else the list is re-read from the server instead, per the
    // standing rule that a card must not claim `done` before the office has.
    patch?: { stopId: number; status: DeviceStopStatus },
  ) => {
    if (!silent) setState('loading');
    try {
      const { data } = await routeService.today();
      dayRef.current = data;
      setDay(data);
      dayClosedRef.current = false;
      setDayClosed(false);
      setState('ready');
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        // A 404 is never transient: it is the server saying this driver has no
        // day. The September report came from reading that word wrongly — the
        // last stop closed, the route flipped to `done`, the dispatch view
        // stopped publishing it, and this re-check answered with the very 404
        // that meant "you finished". Classed as a failed reload, the stale list
        // sat there until the driver reloaded by hand.
        //
        // So the 404 is read against *why we just looked*. A re-check prompted
        // by our own accepted write (a settled tap, a drained queue) or by a
        // driver asking on a closed day: that is the day ending. A passive poll
        // that still sees unresolved stops: the office took the day back —
        // the server owns the day (DRV-14), and a work list that belongs to
        // nobody is dropped, not polished.
        const ours = reason === 'tap' || reason === 'drain'
          || reason === 'manual' || dayClosedRef.current;
        const seen = dayRef.current;
        const resolved = !!seen && seen.stops.length > 0 && seen.stops.every(
          (stop) => stop.stop_status === 'done'
            || stop.stop_status === 'no_access'
            || stop.stop_status === 'skipped',
        );
        if (ours || resolved) {
          if (patch) {
            const apply = (d: DispatchDay): DispatchDay => ({
              ...d,
              stops: d.stops.map((st) =>
                st.stop_id === patch.stopId ? { ...st, stop_status: patch.status } : st),
            });
            dayRef.current = dayRef.current ? apply(dayRef.current) : dayRef.current;
            setDay((d) => (d ? apply(d) : d));
          }
          dayClosedRef.current = true;
          setDayClosed(true);
          return;
        }
        dayRef.current = null;
        setDay(null);
        setMessage(err.message);
        setState('empty');
        return;
      }
      // A silent reload that fails leaves the stale day exactly where it was, which is the
      // right outcome: an out-of-date list you can work from beats a spinner and a shrug.
      if (silent) return;
      dayRef.current = null;
      setDay(null);
      setMessage(err instanceof Error ? err.message : 'Could not load your day');
      setState('error');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /**
   * A tap and then a look. The drain-reload effect below fires when the
   * queue visibly empties — but on a phone with signal the whole round
   * trip can land inside one React batch, the pending count goes 0 → 1 → 0
   * without ever *rendering* a one, and the effect never sees the drain.
   * (The 09/06 report: a driver tapped Arrived at the curb and the card
   * stayed pending until the next poll or a manual reload.) Re-checking the
   * day after every settled tap makes the acknowledgement immediate on the
   * common path and is harmless on the offline one: a silent reload that
   * answers with the old day just leaves the Queued chip standing.
   */
  const recordAndRecheck = useCallback<StopRecorder>(async (stopId, status, gallons, disposalSiteId) => {
    await record(stopId, status, gallons, disposalSiteId);
    void load(true, 'tap', { stopId, status });
  }, [record, load]);

  /**
   * Once the queue empties, ask the server what it now says.
   *
   * This is the reconciliation, and it is a re-read rather than a merge. The queued labels
   * were the device's claim about the day; the moment those claims are accepted, the only
   * version worth showing is the one with the server's timestamps on it. DRV-14 is the reason
   * it is done this way: the app never tries to combine what it thought with what it was
   * told, it just goes and looks.
   */
  const hadWork = useRef(false);
  useEffect(() => {
    if (pendingCount > 0) {
      hadWork.current = true;
      return;
    }
    if (hadWork.current) {
      hadWork.current = false;
      void load(true, 'drain');
    }
  }, [pendingCount, load]);

  /**
   * And independent of the queue: re-read the day on a timer, while the tab
   * is visible and the queue is quiet.
   *
   * The drain-reload above covers the driver's own taps. This covers every
   * other way the day changes underneath a phone that is lying face-down on
   * the seat: the office re-books a stop to another driver mid-morning, the
   * second tablet in the truck confirms a stop this one has not seen
   * confirmed, a publish lands while the driver is between driveways. The
   * alternative — the driver pulling down to refresh to find out whether the
   * office already gave their 2pm to Dana — asks a person at a jobsite to
   * do the app's job.
   *
   * Not while the queue is pending: a queued tap is the device's own newer
   * claim about a stop, and a poll that re-reads the server mid-queue would
   * serve the older fact over it and make the card flicker backwards.
   */
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      if (pendingCount > 0) return;
      void load(true);
    };
    const timer = setInterval(tick, 15000);
    return () => clearInterval(timer);
  }, [load, pendingCount]);

  if (state === 'loading') {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  // An empty day is the one screen that cannot say whose day it is — the
  // day never arrived. In September a login meant for Jim Doe was filled
  // with Jane's saved credentials, the office read "Nothing published for
  // you today" as a caching bug, and the logs showed the server had
  // answered correctly about the wrong person. Name the account, so a
  // misattributed session is visible on the screen rather than in a DB.
  const signedIn = authService.getUser();
  const who = signedIn ? (
    <Typography variant="body2" color="text.secondary"
      sx={{ mt: 1 }} data-testid="signed-in-as">
      Signed in as {signedIn.first_name} {signedIn.last_name} ({signedIn.email})
    </Typography>
  ) : null;

  if (state === 'empty') {
    return (
      <>
        <Alert severity="info" sx={{ mb: 2 }}>
          {message || 'Nothing published for you today.'}
        </Alert>
        {who}
      </>
    );
  }

  if (state === 'error' || !day) {
    return (
      <>
        <Alert severity="error" sx={{ mb: 2 }}>
          {message || 'Could not load your day.'}
        </Alert>
        {who}
      </>
    );
  }

  return (
    <Box>
      <QueueStrip onReload={() => void load()} />
      {/* The date the server answered for — not the one this device thinks it is. On the dev
          snapshot they differ by 635 days, and a header built from the device clock would put
          a wrong date above a correct list. */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="h5" gutterBottom>
          {usDate(day.route_date)} · {day.stop_count} stop{day.stop_count === 1 ? '' : 's'}
        </Typography>
        {/* The 15-second poll covers the day changing underneath the phone;
            this covers the driver not believing the poll. It reloads without
            the spinner — the list on screen stays put while the answer
            arrives. */}
        <IconButton size="small" aria-label="refresh the day"
          onClick={() => void load(true, 'manual')}>
          <RefreshIcon fontSize="small" />
        </IconButton>
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {day.driver.first_name} {day.driver.last_name}
        {day.truck_label ? ` · ${day.truck_label}` : ''}
        {day.business_today !== day.route_date ? ` · answered for ${day.business_today}` : ''}
      </Typography>

      {dayClosed && (
        <Alert severity="success" sx={{ mb: 2 }} data-testid="day-closed">
          Day closed — nothing further is published for you today.
        </Alert>
      )}

      <Stack spacing={1.5}>
        {day.stops.map((stop) => (
          <StopCard
            key={stop.stop_id}
            stop={stop}
            queued={queuedByStop.get(stop.stop_id)}
            onRecord={recordAndRecheck}
            sites={sites}
            sitesLoading={sitesLoading}
            onNeedSites={fetchSites}
            frozen={dayClosed}
          />
        ))}
      </Stack>
    </Box>
  );
};

export default DispatchPage;

