import React, { useState } from 'react';
import { Box, Button, Chip, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { CloudUpload as QueuedIcon } from '@mui/icons-material';
import { DeviceStopStatus, allowedNext } from '../offline/dispatchQueue';
import { QueuedForStop, StopRecorder } from '../hooks/useOutbox';
import { DisposalSite, StopStatus } from '../services/routeService';

/**
 * The buttons that turn a stop into a record.
 *
 * DRV-06 through DRV-09 from the driver's side, and T-DRV-12b: the point where a thumb hits
 * glass and something is eventually written to the regulatory ledger.
 *
 * ## Why the buttons are not simply all of them
 *
 * `allowedNext` mirrors the server's machine, so a driver is never offered a tap the server
 * will refuse. That is not politeness. A refused write on a device with one bar of signal is
 * indistinguishable from a write that never went out, and a driver who cannot tell those
 * apart either taps again or drives on without recording it.
 *
 * ## Why *Done* costs two taps and *Arrived* costs one
 *
 * `arrived` is a driver saying they pulled in; it has no consequences and no field to get
 * wrong. `done` creates a row in `service_events` that a county can ask for, and the volume
 * on it is the number the invoice and the state report both read. So *Done* opens the volume
 * first. One extra tap on the action that cannot be taken back is a good trade, and it is the
 * only place in this app where a confirmation step earns its cost.
 *
 * ## Why the volume is not required
 *
 * 19,200 of the 48,214 imported events have no `gallons_pumped` at all. It is a real and
 * ordinary outcome in this business — a day with a stuck meter, a job where nobody had the
 * hose meter on — and a required field would either stop the driver working or train them to
 * type 0, which is worse than nothing because 0 is a number the report will believe.
 *
 * ## Why there is no disposal-method field
 *
 * The column is free text, and the data is what free text does: the recorded values include
 * `land spread`, `Land Spread`, `LAND SPREAD`, `landspread`, `slurry`, `` ` `` and `q`.
 * Adding another input to that column adds to the problem. A fixed list is the office's
 * decision to make, not this screen's to guess at.
 */

const LABELS: Record<DeviceStopStatus, string> = {
  arrived: 'Arrived',
  done: 'Done',
  no_access: 'No access',
  skipped: 'Skip',
};

interface Props {
  stopId: number;
  /** The sites a lawful `done` can name. Empty means the lookup has not
   *  succeeded yet — see onNeedSites. */
  sites?: DisposalSite[];
  /** Called when a Done tap finds no sites loaded: fetch again, out of band. */
  onNeedSites?: () => void;
  /** True while the first fetch is still in flight. */
  sitesLoading?: boolean;
  /** The status the server last confirmed, not the one the driver chose. */
  status: StopStatus;
  /** The driver's decision, if it has been taken and not yet acknowledged. */
  queued: QueuedForStop | undefined;
  /** The day is closed — the machine has no next state, and an offered tap
      would only be refused. The queued chip (if any) still shows. */
  frozen?: boolean;
  onRecord: StopRecorder;
}

const StopActions: React.FC<Props> = ({ stopId, sites = [], sitesLoading, onNeedSites, status, queued, frozen, onRecord }) => {
  const [askingVolume, setAskingVolume] = useState(false);
  const [volume, setVolume] = useState('');
  const [site, setSite] = useState<number | ''>('');
  const defaultSite = sites.find((d) => d.is_default)?.id;

  // Pre-fill is an effect, not a click-time read: a list that arrives after
  // the dialog opened (slow radio, or a retry kicked off below) must still
  // fill the field, or the driver stares at an empty box that was about to
  // fill itself.
  React.useEffect(() => {
    if (askingVolume && site === '' && defaultSite !== undefined) setSite(defaultSite);
  }, [askingVolume, site, defaultSite]);

  const next = allowedNext(status);

  if (queued) {
    return (
      <Box sx={{ mt: 1.5 }}>
        <Chip
          size="small"
          color="warning"
          icon={<QueuedIcon />}
          label={`Queued · ${LABELS[queued.status]}${queued.gallons ? ` · ${queued.gallons} gal` : ''}`}
        />
        {/* Said out loud, because "Queued" alone reads as "saved". It is not saved; it is
            remembered, by this phone, until this phone can reach the office. */}
        <Typography variant="caption" display="block" color="text.secondary">
          Held on this device until it reaches the office.
        </Typography>
      </Box>
    );
  }

  if (frozen) {
    // Day closed: the last report reached the office and the day is no longer
    // published. A Done button here would be an affordance for a refusal.
    return null;
  }

  if (!next.length) {
    // Terminal. Nothing here can undo it, because a truck that could un-resolve its own day
    // could also erase the fact that it had been there; the office has the screen for that.
    return null;
  }

  const tap = (s: DeviceStopStatus) => {
    if (s === 'done') {
      const parsed = volume.trim() === '' ? null : Number(volume);
      void onRecord(stopId, s, parsed, site === '' ? null : site);
      setAskingVolume(false);
      setVolume('');
      setSite('');
      return;
    }
    void onRecord(stopId, s);
  };

  if (askingVolume) {
    /* flex-start, not flex-end: the helper line under the site field changes
       content the moment the list lands (loading → default), and an
       end-aligned row turned that ordinary fact into the whole row visibly
       jumping just as the default site arrived. With the fields pinned to
       fixed widths and top-aligned, the dialog sits still. */
    return (
      <Stack direction="row" spacing={1} sx={{ mt: 1.5 }} alignItems="flex-start">
        <TextField
          autoFocus
          size="small"
          inputMode="numeric"
          label="Gallons pumped"
          value={volume}
          onChange={(e) => setVolume(e.target.value)}
          sx={{ width: 150 }}
          helperText="Blank is allowed"
        />
        {/* The server refuses a `done` that does not say where the waste went,
            and a refused-on-facts write is dropped by the queue by design
            (DRV-14) — so the field is demanded *here*, where it can still be
            filled in, rather than as a 400 nobody sees. */}
        <TextField
          select
          SelectProps={{ native: true }}
          size="small"
          label="Where it went"
          value={site}
          onChange={(e) => setSite(e.target.value === '' ? '' : Number(e.target.value))}
          sx={{ width: 230 }}
          helperText={sites.length === 0
            ? (sitesLoading
              ? 'Loading sites…'
              : 'Could not load sites — tap Done again to retry')
            : defaultSite !== undefined && site === defaultSite
              ? 'Company default — tap to change'
              : 'Required for the county report'}
        >
          <option value="">Choose site…</option>
          {sites.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </TextField>
        <Button variant="contained" onClick={() => tap('done')} disabled={site === ''}>
          Confirm done
        </Button>
        <Button onClick={() => setAskingVolume(false)}>Back</Button>
      </Stack>
    );
  }

  return (
    <Stack direction="row" spacing={1} sx={{ mt: 1.5 }} flexWrap="wrap" useFlexGap>
      {next.map((s) => (
        <Button
          key={s}
          variant={s === 'done' ? 'contained' : 'outlined'}
          color={s === 'no_access' || s === 'skipped' ? 'warning' : 'primary'}
          onClick={() => {
            if (s !== 'done') { tap(s); return; }
            // DRV-20: the truck's destination is implied by the company
            // default, not hunted for at the truck. The dialog opens with it
            // chosen; the same field is the override when the load genuinely
            // went somewhere else.
            // A mount-time fetch that failed (the page loaded while the
            // server was mid-deploy, the radio blinked) must not be the end
            // of the driver's day. Tap Done again: tap Done.
            if (sites.length === 0 && onNeedSites) onNeedSites();
            if (site === '' && defaultSite !== undefined) setSite(defaultSite);
            setAskingVolume(true);
          }}
        >
          {LABELS[s]}
        </Button>
      ))}
    </Stack>
  );
};

export default StopActions;
