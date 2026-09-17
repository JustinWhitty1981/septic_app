import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import RouteComposerPage from './RouteComposerPage';
import { routeService, RouteSummary } from '../services/routeService';

/**
 * The office board's one live behaviour: the day moves while you watch.
 *
 * A driver taps Arrived on a phone standing in a driveway, and the person
 * holding this tab should see it without knowing to reload — reloading is a
 * ritual, and rituals are how stale boards get explained away ("it always
 * lags, refresh it"). The assertion is deliberately only about the re-read
 * happening on a timer while visible; what the refreshed rows look like is
 * the server's business and its own tests.
 */

jest.mock('../services/routeService', () => {
  const actual = jest.requireActual('../services/routeService');
  return {
    ...actual,
    routeService: {
      forDate: jest.fn(), drivers: jest.fn(), detail: jest.fn(),
      disposalSites: jest.fn(), setDisposalDefault: jest.fn(),
    },
  };
});

const forDate = routeService.forDate as jest.Mock;
const detail = routeService.detail as jest.Mock;
const drivers = routeService.drivers as jest.Mock;
const disposalSites = routeService.disposalSites as jest.Mock;
const setDisposalDefault = routeService.setDisposalDefault as jest.Mock;

const ROWS: RouteSummary[] = [{
  id: 7, route_date: '2024-12-02', status: 'in_progress', version: 2,
  truck_label: null, driver_id: 3, first_name: 'Dana', last_name: 'Reyes',
  stop_count: 4, pending_count: 2,
}];

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  forDate.mockResolvedValue({ data: ROWS, meta: { business_today: '2024-12-02' } });
  drivers.mockResolvedValue({ data: [{ id: 3, first_name: 'Dana', last_name: 'Reyes', role: 'driver' }] });
  disposalSites.mockResolvedValue([
    { id: 150, name: 'ZSS', accepts_slurry: false, permitted: true, is_default: true },
    { id: 148, name: 'Slurrystore', accepts_slurry: true, permitted: false, is_default: false },
  ]);
  setDisposalDefault.mockResolvedValue(undefined);
});
afterEach(() => { jest.useRealTimers(); localStorage.clear(); });

describe('T-SCH-14b: the board opens where a handoff points', () => {
  // The due-queue loop ends here: the clerk added the overdue site from its
  // site card, and the card handed them this URL. If the board opens on an
  // empty day-list, they have to find the route by hand — the one step that
  // makes "adjust the stops and publish" not happen.
  it('opens on the day and route the handoff names', async () => {
    jest.useRealTimers();
    localStorage.setItem('jwt_user', JSON.stringify({
      id: 1, first_name: 'Kim', last_name: 'Office', email: 'k@x.test', role: 'office',
    }));
    detail.mockResolvedValue({ data: {
      id: 7, route_date: '2024-12-05', status: 'draft', version: 1, truck_label: null,
      driver_id: 3, first_name: 'Dana', last_name: 'Reyes', created_at: '2024-12-01',
      stops: [{ id: 41, sequence_no: 1, status: 'pending', version: 0, property_id: 98237,
                legacy_cust_number: 3305, payer_label: 'Justin Whitty',
                site_address: '3489 Brooks Rd', site_city: 'Oshkosh', county_name: null,
                county_raw: null, next_service_due: '2024-11-20', tank_count: 1 }],
    } });
    render(
      <MemoryRouter initialEntries={['/routes?date=2024-12-05&focus=7']}>
        <RouteComposerPage />
      </MemoryRouter>,
    );
    // The day it was handed, not the server's default: the fetch asked for
    // 2024-12-05 specifically.
    await waitFor(() => expect(forDate).toHaveBeenCalledWith('2024-12-05'));
    expect(detail).toHaveBeenCalledWith(7);
    expect(await screen.findByText(/3489 Brooks Rd/)).toBeInTheDocument();
    // And the draft is publishable from the screen it landed on.
    expect(screen.getByRole('button', { name: /publish/i })).toBeInTheDocument();
  });
});

describe('office board: the day moves underneath', () => {
  it('re-reads the day on a timer, without being asked', async () => {
    render(<MemoryRouter><RouteComposerPage /></MemoryRouter>);
    await screen.findByText('Reyes, Dana');
    expect(forDate).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(16000);
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(forDate).toHaveBeenCalledTimes(2));
  });

  it('the office moves the default and the driver dialogs follow', async () => {
    jest.useRealTimers();
    render(<MemoryRouter><RouteComposerPage /></MemoryRouter>);
    expect(await screen.findByText('ZSS')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Default disposal site'), '148');
    await waitFor(() => expect(setDisposalDefault).toHaveBeenCalledWith(148));
    jest.useFakeTimers();
  });

  it('a failed poll keeps the rows it had', async () => {
    render(<MemoryRouter><RouteComposerPage /></MemoryRouter>);
    await screen.findByText('Reyes, Dana');
    forDate.mockRejectedValueOnce(new Error('network 5567'));

    await act(async () => {
      jest.advanceTimersByTime(16000);
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(forDate).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Reyes, Dana')).toBeInTheDocument();
  });
});
