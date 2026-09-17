/**
 * The dispatch screen's view of the offline layer.
 *
 * Lives in a hook rather than in the component because three things have to agree about
 * unsent work — the badge in the header, the label on the card, and whether the day on screen
 * can still be trusted — and if each of them reads the queue its own way they will disagree
 * in exactly the situation that matters, which is a driver standing at a truck with a phone
 * that has no signal and two numbers on the screen that do not match.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  dismissRefused, getOutbox, onQueueChange, QueueSnapshot, refreshQueue,
} from '../offline/registration';
import { offlineHealth, OfflineHealth } from '../offline/capabilities';
import {
  DeviceStopStatus, parseStopStatusWrite, stopStatusWrite,
} from '../offline/dispatchQueue';

export interface QueuedForStop {
  status: DeviceStopStatus;
  gallons: number | null;
}

export interface StopRecorder {
  (stopId: number, status: DeviceStopStatus, gallons?: number | null,
   disposalSiteId?: number | null): Promise<void>;
}

const EMPTY: QueueSnapshot = { pending: [], refused: [], parked: false };

export function useOutbox(): {
  health: OfflineHealth;
  queuedByStop: Map<number, QueuedForStop>;
  pendingCount: number;
  refused: Array<{ path: string; message: string }>;
  parked: boolean;
  record: StopRecorder;
  retryNow: () => Promise<void>;
  clearRefused: () => void;
} {
  const [snap, setSnap] = useState<QueueSnapshot>(EMPTY);
  const health = useMemo(() => offlineHealth(), []);

  useEffect(() => onQueueChange(setSnap), []);

  /**
   * Which stop is sitting on which unsent decision.
   *
   * Last write per stop wins, because the queue is ordered and the driver's final tap is the
   * one describing what happened. This is a *display* rule and deliberately not a merge: the
   * queue still sends every tap in order and lets the server's transition machine refuse the
   * ones that are no longer true (DRV-14).
   */
  const queuedByStop = useMemo(() => {
    const map = new Map<number, QueuedForStop>();
    for (const w of snap.pending) {
      const parsed = parseStopStatusWrite(w);
      if (!parsed) continue;
      map.set(parsed.stopId, { status: parsed.status, gallons: parsed.gallons });
    }
    return map;
  }, [snap.pending]);

  /**
   * Take the tap and return before the network has answered — which, on a jobsite, is the
   * entire point.
   *
   * Enqueue first, then attempt a drain. The order is not stylistic: draining first would
   * mean a tap made while the radio is fine still waits on a round trip before the screen
   * admits it happened, and a driver who taps *Done* and sees nothing change taps it again.
   */
  const record = useCallback<StopRecorder>(async (stopId, status, gallons, disposalSiteId) => {
    const box = getOutbox();
    await box.enqueue(
      stopStatusWrite(stopId, {
        status,
        ...(gallons !== null && gallons !== undefined ? { gallons_pumped: gallons } : {}),
        // `done` without a site is a write the server must refuse, and a
        // refused-on-facts write is dropped by the queue. Collecting the site
        // here is what keeps a thumb-tap from evaporating at the radio.
        ...(disposalSiteId !== null && disposalSiteId !== undefined
          ? { disposal_site_id: disposalSiteId } : {}),
      })
    );
    await box.drain();
    // A write that is merely queued — no send, no acknowledgement — moves nothing through
    // the queue's own hooks, so the tap has to prompt the read itself. Broadcast rather than
    // update in place: the badge and the card are separate subscribers to one fact.
    await refreshQueue();
  }, []);

  const retryNow = useCallback(async () => {
    await getOutbox().drain();
    await refreshQueue();
  }, []);

  return {
    health,
    queuedByStop,
    pendingCount: snap.pending.length,
    refused: snap.refused,
    parked: snap.parked,
    record,
    retryNow,
    clearRefused: dismissRefused,
  };
}
