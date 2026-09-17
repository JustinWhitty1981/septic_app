import React from 'react';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import UnbilledWorkPage from './UnbilledWorkPage';
import { ledgerService, UnbilledRow } from '../services/ledgerService';

/**
 * T-BIL-19 on the screen the office reads.
 *
 * The backend suite proves the queue is computed honestly. What this pins is
 * the promise the page makes back: rows render with the facts a phone call
 * needs, the window dial actually moves the window in the request, the
 * columns sort server-side (the page is a slice of a much longer list, and
 * a sort that only rearranges the slice is theatre), and a row walks to the
 * site it came from.
 */

jest.mock('../services/ledgerService', () => {
  const actual = jest.requireActual('../services/ledgerService');
  return { ...actual, ledgerService: { ...actual.ledgerService, unbilled: jest.fn() } };
});

jest.mock('../services/invoiceService', () => {
  const actual = jest.requireActual('../services/invoiceService');
  return { ...actual, invoiceService: { ...actual.invoiceService, create: jest.fn() } };
});
jest.mock('../services/bidService', () => ({
  bidService: { bidItems: jest.fn().mockResolvedValue({ data: [] }),
    settings: jest.fn().mockResolvedValue({ data: { sales_tax_rate: '0.0550' } }) },
}));
jest.mock('../services/payerService', () => ({ payerService: { search: jest.fn() } }));
jest.mock('../services/propertyService', () => ({
  propertyService: { search: jest.fn().mockResolvedValue({ data: [] }) },
}));
const unbilled = ledgerService.unbilled as jest.Mock;
import { invoiceService } from '../services/invoiceService';
const createInvoice = invoiceService.create as jest.Mock;

const base = (over: Partial<UnbilledRow>): UnbilledRow => ({
  service_event_id: '4001', property_id: 77, legacy_cust_number: 2248,
  payer_label: 'Zorn, Ada', site_address: '12 Creek Rd', site_city: 'Freedom',
  county_id: 15, service_date: '2026-09-04', days_ago: 1,
  gallons_pumped: '1000', source: 'app', waste_type: 'Septic',
  disposal_site: 'Land',
  ...over,
});

const meta = (total: number, over = {}) => ({
  total, limit: 50, offset: 0, days: 60 as const,
  sort: 'service_date', dir: 'desc' as const, business_today: '2026-09-05',
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  // clearAllMocks() also clears the factory's mockResolvedValues — the
  // dialog's side loaders must answer even in the queue page's world.
  require('../services/bidService').bidService.bidItems
    .mockResolvedValue({ data: [] });
  require('../services/bidService').bidService.settings
    .mockResolvedValue({ data: { sales_tax_rate: '0.0550' } });
  unbilled.mockImplementation(() => Promise.resolve({
    data: [
      base({}),
      base({
        service_event_id: '4002', property_id: 78, legacy_cust_number: 1101,
        payer_label: 'Bo, Jeramey', site_address: '8 Dam Ln',
        service_date: '2026-08-16', days_ago: 20,
      }),
    ],
    meta: meta(2),
  }));
});

const renderPage = () => render(
  <MemoryRouter initialEntries={['/unbilled']}>
    <Routes>
      <Route path="/unbilled" element={<UnbilledWorkPage />} />
      <Route path="/properties/:id" element={<div>site-marker-77</div>} />
    </Routes>
  </MemoryRouter>,
);

describe('T-BIL-19: the billing queue page', () => {
  it('lists unbilled work with the facts the invoice needs and today from the server',
    async () => {
      renderPage();
      const cell = await screen.findByText(/12 Creek Rd/);
      const row = within(cell.closest('tr') as HTMLElement);
      expect(row.getByText('09/04/2026')).toBeInTheDocument();
      expect(row.getByText('Zorn, Ada')).toBeInTheDocument();
      expect(row.getByText('Land')).toBeInTheDocument();
      const header = screen.getByText('Billing queue');
      expect(header.parentElement).toHaveTextContent(/Today:.*09\/05\/2026/);
      expect(unbilled).toHaveBeenLastCalledWith(expect.objectContaining({ days: 60 }));
    });

  it('the window dial moves the window in the request, not in the browser',
    async () => {
      renderPage();
      await screen.findByText(/12 Creek Rd/);
      await userEvent.click(screen.getByRole('button', { name: /2 weeks/i }));
      expect(unbilled).toHaveBeenLastCalledWith(expect.objectContaining({ days: 14, page: 1 }));
      await userEvent.click(screen.getByRole('button', { name: /^all$/i }));
      expect(unbilled).toHaveBeenLastCalledWith(expect.objectContaining({ days: 'all' }));
    });

  it('column headers sort server-side, both directions', async () => {
    renderPage();
    await screen.findByText(/12 Creek Rd/);
    expect(unbilled).toHaveBeenLastCalledWith(
      expect.objectContaining({ sort: 'service_date', dir: 'desc' }));

    await userEvent.click(screen.getByRole('button', { name: /cust #/i }));
    expect(unbilled).toHaveBeenLastCalledWith(
      expect.objectContaining({ sort: 'cust', dir: 'asc', page: 1 }));

    await userEvent.click(screen.getByRole('button', { name: /cust #/i }));
    expect(unbilled).toHaveBeenLastCalledWith(
      expect.objectContaining({ sort: 'cust', dir: 'desc' }));
  });

  it('a row walks to the site behind the pump-out', async () => {
    renderPage();
    const row = await screen.findByText(/12 Creek Rd/);
    await userEvent.click(row);
    expect(await screen.findByText('site-marker-77')).toBeInTheDocument();
  });

  it('an empty queue says so in the office’s terms', async () => {
    unbilled.mockImplementation(() => Promise.resolve({ data: [], meta: meta(0) }));
    renderPage();
    const cell = await screen.findByText(/nothing serviced and unbilled/i);
    expect(cell).toHaveTextContent(/the truck's work is all on paper/i);
  });
});

describe('T-BIL-20: draining the queue from the queue', () => {
  // The queue's whole purpose is this flow: check the rows, bill them, and
  // watch the list answer shorter. Nothing here "marks" anything — the
  // queue's membership is a query, and the invoice is what changes its
  // answer.
  it('checked rows open the dialog addressed to the site’s current owner, and a created invoice clears them out',
    async () => {
      unbilled.mockImplementation(() => Promise.resolve({
        data: [
          base({ owner_payer_id: 301, owner_payer_name: 'Zorn, Ada — Zorn Holdings' }),
        ],
        meta: meta(1),
      }));
      createInvoice.mockResolvedValue({
        invoice: {
          id: 3312, payer_id: 301, property_id: 77,
          payer_name: 'Zorn, Ada — Zorn Holdings', invoice_date: '2026-09-06',
          subtotal: '150.00', tax_rate: '0.0550', tax_amount: '8.25',
          total: '158.25', status: 'open',
        }, line_count: 1,
      });
      const user = userEvent.setup();

      render(<MemoryRouter initialEntries={['/unbilled']}>
        <Routes>
          <Route path="/unbilled" element={<UnbilledWorkPage />} />
          <Route path="/properties/:id" element={<div>site-marker</div>} />
        </Routes>
      </MemoryRouter>);

      expect(await screen.findByText(/12 Creek Rd/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /create invoice from selection/i }))
        .toBeDisabled();

      await user.click(screen.getByLabelText('select service 4001'));
      await user.click(screen.getByRole('button', { name: /create invoice from selection/i }));

      // The dialog opens with the pump-out as a line and the owner named.
      expect(await screen.findByDisplayValue(/Pump-out 09\/04\/2026 — 12 Creek Rd/))
        .toBeInTheDocument();
      expect(screen.getByDisplayValue(/Zorn, Ada — Zorn Holdings/)).toBeInTheDocument();

      await user.type(screen.getByLabelText('line unit price 1'), '150');
      await user.click(screen.getByLabelText('create invoice'));

      // The parent's contract with the dialog: created → close, note, and
      // the queue re-reads itself (the row is already gone server-side —
      // the line exists).
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/Invoice \d+ created .* already left the queue/i);
      // The queue itself asked again after the document was created (the
      // dialog also fetches unbilled work for the chosen site — that call
      // carries a property_id and is not this one).
      await waitFor(() => expect(
        unbilled.mock.calls.filter((c) => c[0]?.property_id === undefined).length,
      ).toBeGreaterThanOrEqual(2));
    });
});
