import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DispatchPage from './DispatchPage';
import { ApiError, routeService, DispatchDay } from '../services/routeService';

/**
 * T-DRV-12 / T-DRV-12b — the whole claim, in one test.
 *
 * DRV-12's verify line is `manual: airplane mode after launch, complete 3 stops, restore,
 * confirm all 3 land`. That check still has to happen on a phone. What this one does instead
 * is walk the same path with the radio faked, so the part a walk-through cannot reach is
 * covered: the tap that happens *while* there is no signal, and the moment the signal comes
 * back and the screen has to admit it was wrong about the day.
 *
 * The server is mocked at the service boundary and `fetch` at the global, because the queue
 * deliberately does not go through the axios instance the rest of the app uses — it has to
 * keep working when the page it was loaded from is gone.
 */

jest.mock('../services/routeService', () => {
  const actual = jest.requireActual('../services/routeService');
  return { ...actual, routeService: { today: jest.fn(), disposalSites: jest.fn() } };
});

const today = routeService.today as jest.Mock;
const disposalSites = routeService.disposalSites as jest.Mock;

const DAY: DispatchDay = {
  route_id: 7,
  route_date: '2024-12-02',
  route_status: 'published',
  route_version: 3,
  truck_label: 'Truck 2',
  business_today: '2024-12-02',
  driver: { id: 5, first_name: 'Dana', last_name: 'Reyes' },
  stop_count: 1,
  stops: [
    {
      stop_id: 41, sequence_no: 1, stop_status: 'pending', stop_version: 0,
      arrived_at: null, completed_at: null, property_id: 4, legacy_cust_number: 3494,
      payer_label: 'Reyes, Dana', site_address: '1421 Ridge Rd', site_city: 'Green Bay',
      site_state: 'WI', site_zip: '54304', county_name: 'Brown', county_raw: 'brown co',
      tank_location_note: 'Behind the shed, gate locked', jobsite_location_note: null,
      chamber_pump_note: null, system_condition_note: null, reminder_opt_out: false,
      next_service_due: '2025-01-02', tanks: [],
    },
  ],
};

const deadRadio = (): never => {
  throw new TypeError('Failed to fetch');
};

beforeEach(() => {
  disposalSites.mockResolvedValue([
    { id: 106, name: 'Ottery\'s land', accepts_slurry: null, permitted: false, is_default: true },
  ]);
  today.mockResolvedValue({ data: DAY });
});

describe('T-DRV-12: a day worked without signal', () => {
  it('says so when the browser cannot store the app at all', async () => {
    // jsdom reports no secure context and no service worker, which is exactly what a phone
    // gets when this app is served over http:// across the VPN. The point of the assertion is
    // not that the flag is false — it is that the app says it out loud instead of letting
    // offline mode fail quietly on every handset in the fleet.
    render(<DispatchPage />);
    await screen.findByText(/Ridge Rd/);

    expect(await screen.findByText(/Offline mode is not available here/)).toBeInTheDocument();
    expect(screen.getByText(/Offline mode is off: this address is not secure/)).toBeInTheDocument();
  });

  it('takes the tap with no signal, sends it when the signal returns, then re-reads the day', async () => {
    const user = userEvent.setup();
    const fetchMock = jest.fn().mockImplementation(deadRadio);
    (global as any).fetch = fetchMock;

    render(<DispatchPage />);
    await screen.findByText(/Ridge Rd/);

    await user.click(screen.getByRole('button', { name: 'Arrived' }));

    // The tap is admitted immediately, and admitted as something not yet true.
    expect(await screen.findByText(/Queued · Arrived/)).toBeInTheDocument();
    expect(screen.getByText(/Held on this device until it reaches the office/)).toBeInTheDocument();
    expect(screen.getByText(/1 change not yet sent/)).toBeInTheDocument();

    // It did try, even offline — that is what makes a tap in range cost nothing.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = fetchMock.mock.calls[0][1] as { body: string };
    const payload = JSON.parse(sent.body);
    expect(payload.status).toBe('arrived');
    // The key that makes a resend harmless, present in the body the server actually reads.
    expect(payload.client_uuid).toMatch(/^[0-9a-f]{8}-/);
    // And the two fields the server owns are not in it, whatever this device's clock says.
    expect(payload).not.toHaveProperty('service_date');
    expect(payload).not.toHaveProperty('arrived_at');

    // Signal returns.
    fetchMock.mockResolvedValue({ status: 200, json: async () => ({ success: true }) });
    await user.click(screen.getByRole('button', { name: 'Try now' }));

    await waitFor(() => expect(screen.queryByText(/Queued · Arrived/)).not.toBeInTheDocument());
    expect(screen.queryByText(/not yet sent/)).not.toBeInTheDocument();

    // The screen went and looked rather than assuming its own write was accepted. That extra
    // read is the difference between "the app said done" and the office actually having it.
    // Three reads by now, and each one has its own reason: the mount, the silent re-check
    // that follows every settled tap (a queued tap never settles while the radio is dead,
    // so this one answers with the old day and the Queued chip keeps standing), and the
    // reload when the drain finally emptied the queue.
    await waitFor(() => expect(today).toHaveBeenCalledTimes(3));
  });

  it('re-reads the day on a timer, so a status change reaches the driver unasked', async () => {
    // The office moved a stop, or the other tablet confirmed it; the phone
    // lying on the seat must find out by itself. 15s cadence, visible tab,
    // quiet queue — and no pull-to-refresh ritual anywhere in this test.
    jest.useFakeTimers();
    try {
      render(<DispatchPage />);
      await waitFor(() => expect(today).toHaveBeenCalledTimes(1));
      await act(async () => {
        jest.advanceTimersByTime(16000);
        await Promise.resolve();
        await Promise.resolve();
      });
      await waitFor(() => expect(today).toHaveBeenCalledTimes(2));
    } finally {
      jest.useRealTimers();
    }
  });
});
describe('T-DRV-06b: an acknowledged tap updates the driver\u2019s own screen', () => {
  // The 09/06 report from the truck: tap Arrived at the curb, and with a
  // live radio the phone drains the write so fast that React never renders
  // the intermediate "pending 1" — the queue-drain reload never fires and
  // the card sits on the pre-tap status until a poll tick or a manual page
  // reload. The card answering back at once is not a nicety: a driver who
  // taps and sees nothing taps again.
  it('re-reads the day the moment the write is accepted, and the refresh button offers the same on demand',
    async () => {
      const user = userEvent.setup();
      const fetchMock = jest.fn().mockResolvedValue({
        status: 200, json: async () => ({ success: true }),
      });
      (global as any).fetch = fetchMock;

      render(<DispatchPage />);
      await screen.findByText(/Ridge Rd/);

      await user.click(screen.getByRole('button', { name: 'Arrived' }));

      // Accepted at the server, and the screen went and looked — no timer
      // advanced, no reload, no pull-to-refresh ritual.
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      await waitFor(() => expect(today.mock.calls.length).toBeGreaterThanOrEqual(2));
      await waitFor(() => expect(
        screen.queryByText(/Queued \u00b7 Arrived/),
      ).not.toBeInTheDocument());

      // And the visible door to the same re-read, for the driver who wants
      // to ask right now.
      const before = today.mock.calls.length;
      await user.click(screen.getByRole('button', { name: 'refresh the day' }));
      await waitFor(() => expect(today.mock.calls.length).toBeGreaterThan(before));
    });
});

describe('T-DRV-06c: an empty day says whose it is', () => {
  // The September incident: a login meant for Jim Doe carried Jane's saved
  // credentials, "Nothing published for you today" read like a cache bug,
  // and nothing on the screen named the account that had actually asked.
  beforeEach(() => {
    localStorage.setItem('jwt_user', JSON.stringify({
      id: 4948, email: 'jimdoe@gmail.com', first_name: 'Jim',
      last_name: 'Doe', role: 'driver',
      created_at: '2026-09-07', updated_at: '2026-09-07',
    }));
  });
  afterEach(() => localStorage.clear());

  it('names the signed-in account under the empty-day message', async () => {
    today.mockRejectedValue(new ApiError({ success: false, message: 'Nothing published for you today' } as any, 404));
    render(<DispatchPage />);
    expect(await screen.findByText(/nothing published/i)).toBeInTheDocument();
    expect(screen.getByTestId('signed-in-as')).toHaveTextContent(
      'Signed in as Jim Doe (jimdoe@gmail.com)',
    );
  });

  it('and on the error screen too', async () => {
    today.mockRejectedValue(new Error('Network error'));
    render(<DispatchPage />);
    expect(await screen.findByText(/network error/i)).toBeInTheDocument();
    expect(screen.getByTestId('signed-in-as')).toHaveTextContent('jimdoe@gmail.com');
  });
});

describe('T-DRV-06d: the day closing under the last stop', () => {
  // Closing the last stop flips the route to `done`, the dispatch view stops
  // publishing it, and every read after answers 404. The September report:
  // the post-tap re-check classed that 404 as a failed reload, kept the
  // stale list, and the driver had to reload by hand to be told what they
  // had just done — the day was over.
  const gone = new ApiError(
    { success: false, message: 'Nothing published for you today' } as any, 404);

  it('a 404 after the last report closes the day on the spot, list still readable',
    async () => {
      const user = userEvent.setup();
      const closed: DispatchDay = {
        ...DAY,
        route_status: 'in_progress',
        stop_count: 2,
        stops: [
          {
            ...DAY.stops[0], stop_id: 40, sequence_no: 1, stop_status: 'done',
            arrived_at: '2024-12-02T07:12:00Z', completed_at: '2024-12-02T07:31:00Z',
            site_address: '90 Filed away',
          },
          { ...DAY.stops[0], stop_id: 41, stop_status: 'arrived',
            arrived_at: '2024-12-02T08:02:00Z' },
        ],
      };
      today.mockResolvedValue({ data: closed });
      (global as any).fetch = jest.fn()
        .mockResolvedValue({ status: 200, json: async () => ({ success: true }) });

      render(<DispatchPage />);
      await screen.findByText(/Ridge Rd/);

      // From here the server has no day for this driver: skipping the last
      // stop was the last thing it accepted.
      today.mockRejectedValue(gone);

      // 'arrived' can only become done (capture dialog) or no access. The
      // no-access tap is terminal, and terminalism is the whole subject.
      await user.click(screen.getByRole('button', { name: /no access/i }));

      expect(await screen.findByTestId('day-closed')).toHaveTextContent(
        /Day closed/,
      );
      // The day they worked stays on screen — a finished day, not a vanished
      // one — and the honest message does not overwrite it.
      expect(screen.getByText(/Ridge Rd/)).toBeInTheDocument();
      expect(screen.queryByText(/Nothing published/i)).toBeNull();
      // And the closed day offers nothing further: the card they just
      // resolved shows its resolution, and no button promises a tap the
      // server would only refuse.
      expect(screen.getByText('no_access')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /no access|done|skip/i })).toBeNull();
    });

  it('but a passive poll that finds no day under an unfinished list drops it plainly',
    async () => {
      // DAY still has a pending stop: a 404 arriving on its own means the
      // office took the day back, not that the driver finished it.
      jest.useFakeTimers();
      try {
        render(<DispatchPage />);
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        expect(screen.getByText(/Ridge Rd/)).toBeInTheDocument();

        today.mockRejectedValue(gone);
        await act(async () => {
          jest.advanceTimersByTime(16000);
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
        });

        expect(screen.getByText(/Nothing published/i)).toBeInTheDocument();
        expect(screen.queryByTestId('day-closed')).toBeNull();
        expect(screen.queryByText(/Ridge Rd/)).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });
});
