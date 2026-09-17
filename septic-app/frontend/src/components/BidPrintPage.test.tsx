import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import BidPrintPage from './BidPrintPage';
import { bidService, BidDetail } from '../services/bidService';
import { settingsService, CompanySettings } from '../services/settingsService';

/**
 * T-BIL-15's paper. The claim under test is that the document is the
 * document: the customer's name and mail address, every line with its unit,
 * and money that agrees with the server to the cent — a bid whose paper
 * rounds differently than its row is how the job gets argued about later.
 * The other claim is the one refusal: nobody prints a declined bid looking
 * for a signature.
 */

jest.mock('../services/bidService', () => {
  const actual = jest.requireActual('../services/bidService');
  return { ...actual, bidService: { bid: jest.fn() } };
});
// The bid prints under the company's own letterhead (0037), so the page reads
// the settings row too — an unmocked axios call would fail every render here.
jest.mock('../services/settingsService', () => {
  const actual = jest.requireActual('../services/settingsService');
  return { ...actual, settingsService: { get: jest.fn(), getLogoUrl: jest.fn() } };
});

const bid = bidService.bid as jest.Mock;
const getSettings = settingsService.get as jest.Mock;
const getLogoUrl = settingsService.getLogoUrl as jest.Mock;

const SETTINGS: CompanySettings = {
  sales_tax_rate: '0.0550', payment_term_days: 30, late_fee_rate_monthly: '0.0150',
  company_name: 'Northfield Septic', logo_media_id: null,
  address: null, email: null, phone: null, updated_at: null, updated_by: null,
};

const APPROVED: BidDetail = {
  id: 7, bid_date: '2024-12-02', status: 'approved', payer_id: 9, payer_name: 'Smith, Jane',
  property_id: 98237, site_address: 'Lot 7 CR-42', site_city: null, site_state: null,
  site_zip: null, mailing_address: '412 Township Rd', mailing_city: 'Elkhart',
  mailing_state: 'IN', mailing_zip: '46514', notes: 'Dig after the frost breaks.',
  decline_note: null, bid_tax_rate: '0.0550', approved_on: '2024-12-02',
  approved_at: '2024-12-02 10:15:00', approved_by_name: 'Dana Office',
  declined_at: null, invoice_id: null, subtotal: '1200.00', line_count: 2,
  eff_tax_rate: '0.0550', tax_estimated: false, tax_amount: '66.00', total: '1266.00',
  lines: [
    { id: 11, bid_item_id: 3, item_name: 'Labor', description: 'Labor', unit: 'hour',
      unit_price: '300.00', quantity: '3.00', line_total: '900.00', sequence_no: 1 },
    { id: 12, bid_item_id: null, item_name: null, description: 'Schedule 40 PVC pipe',
      unit: 'feet', unit_price: '3.00', quantity: '100.00', line_total: '300.00',
      sequence_no: 2 },
  ],
};

const renderAt = (path: string) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/bids/:id/print" element={<BidPrintPage />} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  jest.clearAllMocks();
  bid.mockResolvedValue({ data: APPROVED });
  getSettings.mockResolvedValue(SETTINGS);
  (window as any).print = jest.fn();
});

describe('T-BIL-15: the printed bid', () => {
  it('carries the whole canonical example, to the cent', async () => {
    renderAt('/bids/7/print');
    expect(await screen.findByText('Smith, Jane')).toBeInTheDocument();
    expect(screen.getByText(/Labor/)).toBeInTheDocument();
    expect(screen.getByText('$900.00')).toBeInTheDocument();
    // $300.00 is the whole point of the example: Labor's unit price and the
    // pipe line's total are the same number by construction.
    expect(screen.getAllByText('$300.00')).toHaveLength(2);
    expect(screen.getByText(/Subtotal \$1,200\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Sales tax 5\.5%.*\$66\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Total \$1,266\.00/)).toBeInTheDocument();
  });

  it('the mailing block is the biller’s, and the site is named as the work site', async () => {
    renderAt('/bids/7/print');
    expect(await screen.findByText(/412 Township Rd/)).toBeInTheDocument();
    expect(screen.getByText(/Elkhart IN 46514/)).toBeInTheDocument();
    expect(screen.getByText(/Work site: Lot 7 CR-42/)).toBeInTheDocument();
  });

  it('a signed paper says its prices are fixed', async () => {
    renderAt('/bids/7/print');
    expect(await screen.findByText(/fixed at approval/)).toBeInTheDocument();
    expect(screen.getByText(/Approved:/)).toBeInTheDocument();
    expect(screen.queryByText(/estimated/)).not.toBeInTheDocument();
  });

  it('a draft prints with the honesty label on the tax line', async () => {
    bid.mockResolvedValue({ data: { ...APPROVED, status: 'draft',
      eff_tax_rate: '0.0550', tax_estimated: true } });
    renderAt('/bids/7/print');
    expect(await screen.findByText(/final figure is fixed when this bid is approved/))
      .toBeInTheDocument();
    expect(screen.getByText(/estimated at the current rate/)).toBeInTheDocument();
  });

  it('a declined bid is not printed', async () => {
    bid.mockResolvedValue({ data: { ...APPROVED, status: 'declined',
      decline_note: 'too high' } });
    renderAt('/bids/7/print');
    expect(await screen.findByText(/declined bids are not printed/)).toBeInTheDocument();
    expect(screen.queryByText(/Total \$1,266\.00/)).not.toBeInTheDocument();
  });

  it('?auto opens the print dialog exactly once', async () => {
    renderAt('/bids/7/print?auto=1');
    await waitFor(() => expect((window as any).print).toHaveBeenCalledTimes(1),
      { timeout: 2000 });
  });
});

// The invoice's paper contract (T-BIL-08b, as-built 09/06) went missing from
// this page: the sheet here only hid the app bar and the drawer, so bids came
// back from the printer with browser headers in the page margins, the app's
// 240px nav gutter reserved, a 720px-capped column, and washed-out grays.
// These are T-BIL-08b's assertions pointed at the bid's page, so the two
// sheets cannot drift apart again — one paper printing well and its sibling
// quietly never did is exactly how this was found.
describe('T-BIL-15b: the bid’s sheet is the invoice’s sheet', () => {
  it('asks the browser for a letter page, drops the chrome with the nav gutter, keeps rows whole, repeats the header, keeps the grays',
    async () => {
      renderAt('/bids/7/print');
      await screen.findByText('Smith, Jane');
      const css = Array.from(document.querySelectorAll('style'))
        .map((el) => el.textContent ?? '').join('\n');
      expect(css).not.toBe('');
      expect(css).toContain('@page');
      expect(css).toMatch(/size:\s*letter/);
      expect(css).toMatch(/break-inside:\s*avoid/);
      expect(css).toMatch(/display:\s*table-header-group/);
      expect(css).toMatch(/print-color-adjust:\s*exact/);
      expect(css).toMatch(/\.MuiDrawer-root[^]*display:\s*none/);
      expect(css).toMatch(/nav[^]*display:\s*none/);
      // The print button lives inside the no-print block — offered on screen,
      // never printed.
      expect(document.querySelector('.no-print')).toContainElement(
        screen.getByRole('button', { name: /print/i }),
      );
    });

  it('the bid prints under the same settings-read letterhead as the bill', async () => {
    getSettings.mockResolvedValue({ ...SETTINGS,
      company_name: 'Northfield Septic LLC',
      address: '9 Water Tower Dr, Elkhart, IN 46514',
      phone: '(574) 555-0123' });
    renderAt('/bids/7/print');
    expect(await screen.findByText('Northfield Septic LLC')).toBeInTheDocument();
    expect(screen.getByText('9 Water Tower Dr, Elkhart, IN 46514')).toBeInTheDocument();
    expect(screen.getByText('(574) 555-0123')).toBeInTheDocument();
  });

  it('a stored logo prints on the quote too', async () => {
    getSettings.mockResolvedValue({ ...SETTINGS, logo_media_id: 55 });
    getLogoUrl.mockResolvedValue('blob:fake-logo');
    renderAt('/bids/7/print');
    const img = await screen.findByRole('img');
    expect(img).toHaveAttribute('src', 'blob:fake-logo');
    expect(getLogoUrl).toHaveBeenCalledWith(55);
  });
});
