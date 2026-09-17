import React from 'react';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import DueQueuePage from './DueQueuePage';
import { propertyService, DueQueueRow } from '../services/propertyService';

/**
 * T-SCH-15 / T-SCH-16 on the screen the office actually reads.
 *
 * The backend suites prove the view and the endpoints; these tests pin the
 * promise each one makes visible: a booked site is *shown as booked* when
 * asked — never silently missing — and an adjusted row shows the date it is
 * acting on, the sentence that justifies it, and the one action that takes
 * the overlay off.
 */

jest.mock('../services/propertyService', () => {
  const actual = jest.requireActual('../services/propertyService');
  return {
    ...actual,
    propertyService: {
      dueQueue: jest.fn(), adjustDue: jest.fn(), closeDueAdjustment: jest.fn(),
    },
  };
});

const dueQueue = propertyService.dueQueue as jest.Mock;
const adjustDue = propertyService.adjustDue as jest.Mock;
const closeDueAdjustment = propertyService.closeDueAdjustment as jest.Mock;

const base = (over: Partial<DueQueueRow>): DueQueueRow => ({
  property_id: 1, legacy_cust_number: 3305, payer_label: 'Justin Whitty',
  site_address: '1 A Road', site_city: 'Oshkosh', county_id: 15, status: 'active',
  next_service_due: '2026-08-01', days_overdue: 35,
  effective_due_date: '2026-08-01', adjusted: false, adjustment_reason: null,
  scheduled_on: null, scheduled_status: null, scheduled_driver: null,
  ...over,
});

const OVERDUE = base({});
const BOOKED = base({
  property_id: 2, site_address: '2 B Lane', next_service_due: '2026-08-20',
  effective_due_date: '2026-08-20', days_overdue: 16,
  scheduled_on: '2026-09-10', scheduled_status: 'draft',
  scheduled_driver: 'Reyes, Dana',
});
const ADJUSTED = base({
  property_id: 3, site_address: '3 C Lane', next_service_due: '2026-08-01',
  days_overdue: -900, effective_due_date: '2029-01-15', adjusted: true,
  adjustment_reason: 'Competitor pumped the tank last month',
});

const envelope = (data: DueQueueRow[]) =>
  ({ data, meta: {
    total: data.length, limit: 50, offset: 0, business_today: '2026-09-05',
  } });

beforeEach(() => {
  jest.clearAllMocks();
  dueQueue.mockImplementation((params: any) => Promise.resolve(
    envelope(params?.show_scheduled ? [OVERDUE, BOOKED] : [OVERDUE]),
  ));
});

const renderPage = () => render(<MemoryRouter><DueQueuePage /></MemoryRouter>);

describe('T-SCH-15: the queue hides booked sites without making them disappear', () => {
  it('default view shows nobody booked, and the toggle reads them back with their day',
    async () => {
      renderPage();
      expect(await screen.findByText(/1 A Road/)).toBeInTheDocument();
      expect(screen.queryByText(/2 B Lane/)).toBeNull();
      expect(dueQueue).toHaveBeenLastCalledWith(
        expect.objectContaining({ filter: 'overdue', show_scheduled: false }));

      await userEvent.click(screen.getByRole('button', { name: /show booked sites/i }));

      expect(await screen.findByText(/2 B Lane/)).toBeInTheDocument();
      expect(dueQueue).toHaveBeenLastCalledWith(
        expect.objectContaining({ show_scheduled: true }));
      // The sentence that keeps the hiding honest — and the draft word that
      // tells the clerk the day is not yet the driver's.
      expect(await screen.findByText(/booked 09\/10\/2026 · Reyes, Dana \(draft\)/))
        .toBeInTheDocument();
    });
});

describe('T-SCH-16: an adjusted row is a date with a sentence attached', () => {
  it('shows the effective date and the reason, and one action takes the overlay off',
    async () => {
      let calls = 0;
      dueQueue.mockImplementation(() => Promise.resolve(
        envelope(++calls === 1 ? [ADJUSTED] : [OVERDUE]),
      ));
      closeDueAdjustment.mockResolvedValue({ id: 9, closed: true });
      renderPage();

      expect(await screen.findByText(/01\/15\/2029/)).toBeInTheDocument();
      expect(screen.getByText(/adjusted — Competitor pumped the tank last month/))
        .toBeInTheDocument();
      // The generated column is not what the page is showing.
      expect(screen.queryByText(/adjusted — .*2026-08-01/)).toBeNull();

      await userEvent.click(screen.getByLabelText('return 3 C Lane to schedule'));
      await waitFor(() => expect(closeDueAdjustment).toHaveBeenCalledWith(3));

      // After closing, the queue re-reads itself — and the plain schedule, the
      // generated date, the whole site as arithmetic, is what comes back.
      expect(await screen.findByText(/1 A Road/)).toBeInTheDocument();
      expect(screen.queryByText(/adjusted —/)).toBeNull();
    });

  it('the dialog posts date and reason, and a refusal comes back in the server’s words',
    async () => {
      renderPage();
      await screen.findByText(/1 A Road/);

      await userEvent.click(screen.getByLabelText('adjust due date for 1 A Road'));
      const dialog = await screen.findByRole('dialog');
      const submit = within(dialog).getByRole('button', { name: 'Adjust due date' });
      expect(submit).toBeDisabled(); // a due date without a reason is a rumour

      fireEvent.change(within(dialog).getByLabelText('adjusted due date'),
        { target: { value: '2029-01-15' } });
      expect(submit).toBeDisabled(); // ...and a reason without a date is too

      fireEvent.change(within(dialog).getByLabelText('adjustment reason'),
        { target: { value: 'Competitor pumped' } });
      expect(submit).toBeEnabled();

      // The server's refusal is the lesson; the form must not paraphrase it.
      adjustDue.mockRejectedValue(new Error(
        'Today is 2026-09-05; an adjustment to 2029-01-15 is not a schedule '
        + 'change, it is a claim about a service event. If the ledger is wrong, '
        + 'file a correction instead.'));
      await userEvent.click(submit);
      expect(adjustDue).toHaveBeenCalledWith(1, {
        adjusted_due_date: '2029-01-15', reason: 'Competitor pumped',
      });
      expect(await within(dialog).findByRole('alert'))
        .toHaveTextContent('file a correction instead');

      // And when it lands, the dialog closes and the page re-reads.
      const before = dueQueue.mock.calls.length;
      adjustDue.mockResolvedValue({ id: 12, adjusted_due_date: '2029-01-15',
        reason: 'Competitor pumped' });
      await userEvent.click(within(dialog).getByRole('button', { name: 'Adjust due date' }));
      await waitFor(() => expect(dueQueue.mock.calls.length).toBeGreaterThan(before));
      expect(screen.queryByRole('dialog')).toBeNull();
    });
});

describe('T-SCH-14: the queue round trip (Wisconsin dates and no back button)', () => {
  it('the header names today, formatted the way the office writes it',
    async () => {
      renderPage();
      await screen.findByText(/1 A Road/);
      // Every relative band in this table is measured against this one date;
      // saying it out loud is the difference between "16 days overdue" and
      // "16 days overdue as of 09/05/2026".
      const header = await screen.findByText('09/05/2026');
      expect(header.parentElement).toHaveTextContent(/Today:/);
    });

  it('comes back from the site page with the add still on the wall, not the back button',
    async () => {
      // This is exactly what the site page navigates to after a schedule: the
      // queue re-reads (the booked site is now hidden, SCH-15) and the
      // confirmation survives the reload as a banner.
      render(
        <MemoryRouter initialEntries={[{
          pathname: '/due-queue',
          state: { addedNote: '3 C Lane is stop 1 on Marco Rivera\u2019s day, 09/10/2026.' },
        }]}><DueQueuePage /></MemoryRouter>,
      );
      const banner = await screen.findByRole('alert');
      expect(banner).toHaveTextContent('3 C Lane is stop 1');
      expect(banner).toHaveTextContent('09/10/2026');
    });
});

describe('sorting the queue', () => {
  it('starts soonest-first and re-reads the day when a column header is clicked',
    async () => {
      renderPage();
      await screen.findByText(/1 A Road/);
      expect(dueQueue).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort: 'due', dir: 'asc' }));

      await userEvent.click(screen.getByRole('button', { name: /payer on file/i }));
      expect(dueQueue).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort: 'payer', dir: 'asc', page: 1 }));

      await userEvent.click(screen.getByRole('button', { name: /payer on file/i }));
      expect(dueQueue).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort: 'payer', dir: 'desc' }));
    });
});
