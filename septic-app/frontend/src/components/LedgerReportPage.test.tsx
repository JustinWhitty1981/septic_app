import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fireEvent } from '@testing-library/react';
import LedgerReportPage from './LedgerReportPage';
import { ledgerService, LedgerReport } from '../services/ledgerService';

/**
 * T-LED-02's screen. The requirement is "no pre-computed counter table", and
 * the UI risk that mirrors is a screen that looks cached: totals that never
 * move, a range nobody asked for. What is asserted here is that the numbers
 * on screen came from the service call that was just made — and that the
 * gallons-absent rows are impossible to walk past, because a report that
 * silently means "the rows that remembered" is the failure LED-04 named.
 */

jest.mock('../services/ledgerService', () => {
  const actual = jest.requireActual('../services/ledgerService');
  return { ...actual, ledgerService: { report: jest.fn(), lookups: jest.fn() } };
});

const report = ledgerService.report as jest.Mock;

const REPORT: LedgerReport = {
  report: 'service_events',
  generated: 'from service_events at request time; no stored tally exists',
  from: '1900-01-01',
  to: '2024-12-02',
  months: [
    { month: '2024-11', events: 40, events_without_gallons: 0, gallons: '9600.0' },
    { month: '2024-10', events: 12, events_without_gallons: 7, gallons: '1800.0' },
  ],
  by_site: [
    { month: '2024-10', disposal_site_id: null, disposal_site: 'not recorded',
      events: 12, events_without_gallons: 7, gallons: '1800.0' },
  ],
  totals: { events: 52, events_without_gallons: 7, gallons: '11400.0' },
};

beforeEach(() => {
  jest.clearAllMocks();
  report.mockResolvedValue(REPORT);
});

describe('T-LED-02: the state report screen', () => {
  it('computes on load and says so', async () => {
    render(<LedgerReportPage />);
    expect(await screen.findByText('52')).toBeInTheDocument();
    expect(await screen.findByText(/computed per request/i)).toBeInTheDocument();
    expect(screen.getByText(/from service_events at request time/)).toBeInTheDocument();
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('the gallons-absent count cannot be missed at either end', async () => {
    render(<LedgerReportPage />);
    // In the totals card...
    expect(await screen.findByText(/These rows count as events/)).toBeInTheDocument();
    // ...and beside the month that has them, as a visible count rather than
    // a footnote nobody reads.
    expect(screen.getAllByText('7').length).toBeGreaterThanOrEqual(2);
  });

  it('an empty range says empty, not zero-and-a-shrug', async () => {
    report.mockResolvedValueOnce({ ...REPORT, months: [],
      totals: { events: 0, events_without_gallons: 0, gallons: '0.0' } });
    render(<LedgerReportPage />);
    expect(await screen.findByText(/No completed events in this range/)).toBeInTheDocument();
  });

  it('applying a date range refetches with the range the reader chose', async () => {
    render(<LedgerReportPage />);
    await screen.findByText('52');
    // date inputs need a direct value set: userEvent would have to type each
    // segment, and jsdom parses them one at a time.
    fireEvent.change(screen.getByLabelText('report start date'), { target: { value: '2024-01-01' } });
    // The range is a dependency of the load, so the change itself refetches;
    // clicking Apply mid-flight would hit a disabled button (it disables while
    // a request is outstanding) and assert nothing.
    await waitFor(() => expect(report).toHaveBeenLastCalledWith('2024-01-01', undefined));
  });

  it('the per-site breakdown is opt-in and shows refusal-to-guess sites', async () => {
    render(<LedgerReportPage />);
    await screen.findByText('52');
    await userEvent.click(screen.getByRole('button', { name: /per-site breakdown/i }));
    expect(await screen.findByText('not recorded')).toBeInTheDocument();
  });

  it('a failed report says failed, rather than rendering an empty book', async () => {
    report.mockRejectedValueOnce({ response: { data: { error: 'Internal error DEADBEEF' } } });
    render(<LedgerReportPage />);
    expect(await screen.findByText('Internal error DEADBEEF')).toBeInTheDocument();
    expect(screen.queryByText('52')).not.toBeInTheDocument();
  });
});
