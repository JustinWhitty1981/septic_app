import React from 'react';
import { Alert, AlertTitle, Button, Stack, Typography } from '@mui/material';
import { useOutbox } from '../hooks/useOutbox';

/**
 * The strip above the list that says, honestly, what state the offline layer is in.
 *
 * DRV-12, and the half of it that is easy to skip. A queue with no indicator is a queue that
 * is not believed: a driver who cannot see that three stops are still sitting on the phone
 * will either assume they were sent and go home, or assume the app is broken and start the
 * phone call that ends with the office re-entering a day the ledger already has.
 *
 * Four things can be wrong at once, and they are ordered by what the driver has to do about
 * them, not by how they were detected:
 *
 *  - the office already answered differently, so the day on screen is wrong *now*;
 *  - the session expired, so nothing can be sent until somebody signs in;
 *  - work is simply waiting for signal, which is normal and needs no action;
 *  - and the browser will not store anything at all, which is not the driver's fault and
 *    cannot be fixed at a jobsite, so it is stated once, plainly, and not repeated.
 */
const QueueStrip: React.FC<{ onReload: () => void }> = ({ onReload }) => {
  const { health, pendingCount, refused, parked, retryNow, clearRefused } = useOutbox();

  return (
    <Stack spacing={1} sx={{ mb: 2 }}>
      {refused.length > 0 && (
        <Alert
          severity="error"
          action={<Button color="inherit" size="small" onClick={() => { clearRefused(); onReload(); }}>Reload the day</Button>}
        >
          <AlertTitle>The office has already decided something different</AlertTitle>
          {refused.map((r, i) => (
            <Typography variant="body2" key={i}>{r.message}</Typography>
          ))}
          <Typography variant="caption" display="block">
            Your version of that stop was not applied. Reload to see what the day actually is.
          </Typography>
        </Alert>
      )}

      {parked && (
        <Alert severity="warning">
          <AlertTitle>Sign in again to send {pendingCount} unsent change{pendingCount === 1 ? '' : 's'}</AlertTitle>
          Your sign-in expired. Nothing was thrown away — the work is still on this device and
          will go out under the new sign-in.
        </Alert>
      )}

      {!parked && pendingCount > 0 && (
        <Alert
          severity="info"
          action={<Button color="inherit" size="small" onClick={() => void retryNow()}>Try now</Button>}
        >
          {pendingCount} change{pendingCount === 1 ? '' : 's'} not yet sent. They go
          automatically when this device reaches the office.
        </Alert>
      )}

      {(!health.canWorkOffline || !health.canRememberWrites) && (
        <Alert severity="info">
          <AlertTitle>Offline mode is not available here</AlertTitle>
          {[health.secureContext, health.serviceWorker, health.indexedDB]
            .filter((c) => !c.ok)
            .map((c, i) => (
              <Typography variant="body2" key={i}>{c.headline}</Typography>
            ))}
          {/* The remedy is shown because the common cause is structural — the app served over
              http:// to a phone on the VPN — and without it the one person who can fix it
              never learns there is anything to fix. */}
          {[health.secureContext, health.serviceWorker, health.indexedDB]
            .filter((c) => !c.ok && c.remedy)
            .map((c, i) => (
              <Typography variant="caption" display="block" color="text.secondary" key={`r${i}`}>
                {c.remedy}
              </Typography>
            ))}
        </Alert>
      )}
    </Stack>
  );
};

export default QueueStrip;
