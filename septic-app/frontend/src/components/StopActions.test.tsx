import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import StopActions from './StopActions';
import { DeviceStopStatus } from '../offline/dispatchQueue';
import { QueuedForStop, StopRecorder } from '../hooks/useOutbox';
import { DisposalSite, StopStatus } from '../services/routeService';

/**
 * T-DRV-12b — the driver's buttons.
 *
 * The first component test in this repository, which is worth saying because it is the
 * reason seven requirements about what a driver *sees* have been sitting at 🟡 while their
 * payload halves were ✅. Those rows were qualified rather than closed on the honest grounds
 * that nobody had ever looked at the card, and a payload that is correct and a screen that
 * renders it wrong are the same failure to the person standing at the truck.
 *
 * What is asserted here is mostly *absence*: which buttons are not offered. Any of the four
 * statuses is accepted by the endpoint, and the transition machine refuses the illegal ones,
 * so a screen that offered everything would still work — it would just make the driver pay
 * for the server's correctness with taps that appear to do nothing.
 */

const SITES = [
  { id: 106, name: 'Ottery\'s land', accepts_slurry: null, permitted: false, is_default: true },
  { id: 108, name: 'Kettleview Co-op', accepts_slurry: true, permitted: true, is_default: false },
];
const NO_DEFAULT = SITES.map((x) => ({ ...x, is_default: false }));

const render_ = (
  status: StopStatus,
  queued: QueuedForStop | undefined = undefined,
  onRecord: StopRecorder = async () => undefined,
  sites: DisposalSite[] = SITES,
  onNeedSites?: () => void
) => render(
  <StopActions stopId={41} sites={sites} status={status} queued={queued}
    onRecord={onRecord} onNeedSites={onNeedSites} />,
);


const pickSite = async (user: ReturnType<typeof userEvent.setup>) => {
  // Native select on purpose (the OS renders the menu — no portal can hide it
  // from a driver), and native selects are exactly what selectOptions speaks.
  await user.selectOptions(screen.getByLabelText('Where it went'), '106');
};

describe('T-DRV-12b: the stop card\'s controls', () => {
  it('offers a pending stop the three ways it can leave, and not Done', async () => {
    render_('pending');

    expect(screen.getByRole('button', { name: 'Arrived' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'No access' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument();
    // Reaching `done` from `pending` is legal at the server. It is not offered, because a
    // stop completed without ever being arrived at has no `arrived_at`, and the whole point
    // of that column is that it is the server's record of when the truck got there.
    expect(screen.queryByRole('button', { name: /Done/ })).not.toBeInTheDocument();
  });

  it('offers an arrived stop Done, and never Arrived again', () => {
    render_('arrived');

    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'No access' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Arrived' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skip' })).not.toBeInTheDocument();
  });

  it.each(['done', 'no_access', 'skipped'] as const)('offers nothing on a %s stop', (status) => {
    render_(status);

    // A truck that could un-resolve its own day could also erase the fact that it had been
    // there. The office has a screen for that; this one does not, and does not pretend to.
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('asks for the volume before it records a completion', async () => {
    const user = userEvent.setup();
    const seen: Array<[number, DeviceStopStatus, number | null | undefined, number | '']> = [];
    render_('arrived', undefined, async (id, s, g, d) => { seen.push([id, s, g, d ?? '']); });

    await user.click(screen.getByRole('button', { name: 'Done' }));

    expect(seen).toHaveLength(0);
    expect(screen.getByLabelText('Gallons pumped')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm done' })).toBeInTheDocument();
  });

  it('the implied site is already chosen when the volume prompt opens', async () => {
    const user = userEvent.setup();
    const seen: unknown[] = [];
    render_('arrived', undefined, async (...a) => { seen.push(a); });
    await user.click(screen.getByRole('button', { name: 'Done' }));
    // DRV-20: the truck knows where it went. Confirm is live the moment the
    // dialog is — no hunt through 105 legacy names at the truck.
    expect(screen.getByRole('button', { name: 'Confirm done' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Confirm done' }));
    expect(seen).toEqual([[41, 'done', null, 106]]);
  });

  it('records the override, not the default, when the load went elsewhere', async () => {
    const user = userEvent.setup();
    const seen: unknown[] = [];
    render_('arrived', undefined, async (...a) => { seen.push(a); });
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await user.selectOptions(screen.getByLabelText('Where it went'), '108');
    await user.click(screen.getByRole('button', { name: 'Confirm done' }));
    expect(seen).toEqual([[41, 'done', null, 108]]);
  });

  it('retries the site list when a Done tap finds it empty', async () => {
    // The class of bug this kills: the list failed once at page load (server
    // mid-deploy, radio blinked) and the driver was stranded with an empty
    // box forever. Now the second Done tap refetches.
    const onNeedSites = jest.fn();
    render_('arrived', undefined, async () => undefined, [], onNeedSites as never);
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onNeedSites).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/tap Done again to retry/i)).toBeInTheDocument();
  });

  it('will not confirm a completion until the waste has somewhere to go', async () => {
    const user = userEvent.setup();
    const seen: unknown[] = [];
    render_('arrived', undefined, async (...a) => { seen.push(a); }, NO_DEFAULT);
    await user.click(screen.getByRole('button', { name: 'Done' }));
    // With no company default set, the old rule stands: a confirmable button
    // without a site is a button that deletes the driver's tap — the queue
    // drops a refusal on its facts rather than retrying it forever.
    expect(screen.getByRole('button', { name: 'Confirm done' })).toBeDisabled();
    await pickSite(user);
    expect(screen.getByRole('button', { name: 'Confirm done' })).toBeEnabled();
  });

  it('records a completion with no volume rather than refusing it', async () => {
    // 19,200 of the 48,214 imported events have no gallons at all. Forcing the field would
    // not produce data, it would produce 0, and 0 is a number the state report believes.
    const user = userEvent.setup();
    const seen: Array<[number, DeviceStopStatus, number | null | undefined, number | '']> = [];
    render_('arrived', undefined, async (id, s, g, d) => { seen.push([id, s, g, d ?? '']); });

    await user.click(screen.getByRole('button', { name: 'Done' }));
    await pickSite(user);
    await user.click(screen.getByRole('button', { name: 'Confirm done' }));

    expect(seen).toEqual([[41, 'done', null, 106]]);
  });

  it('records the volume the driver typed', async () => {
    const user = userEvent.setup();
    const seen: Array<[number, DeviceStopStatus, number | null | undefined, number | '']> = [];
    render_('arrived', undefined, async (id, s, g, d) => { seen.push([id, s, g, d ?? '']); });

    await user.click(screen.getByRole('button', { name: 'Done' }));
    await user.type(screen.getByLabelText('Gallons pumped'), '350');
    await pickSite(user);
    await user.click(screen.getByRole('button', { name: 'Confirm done' }));

    expect(seen).toEqual([[41, 'done', 350, 106]]);
  });

  it('says an unsent decision is held on the device, not saved', () => {
    render_('pending', { status: 'arrived', gallons: null });

    expect(screen.getByText(/Queued · Arrived/)).toBeInTheDocument();
    expect(screen.getByText(/Held on this device until it reaches the office/)).toBeInTheDocument();
    // The buttons go, or a driver taps a second decision onto a stop whose first one has not
    // yet reached anyone, and the queue now holds two claims about the same site.
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('shows the queued volume on the chip it is waiting on', () => {
    render_('arrived', { status: 'done', gallons: 350 });

    expect(screen.getByText(/Queued · Done · 350 gal/)).toBeInTheDocument();
  });
});
