import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import BidDetailPage from './BidDetailPage';
import { bidService, BidDetail } from '../services/bidService';

/**
 * T-BIL-11 and T-BIL-12's document. The whole lifecycle rule fits in one
 * sentence — a draft accepts everything, a signed paper accepts nothing — and
 * that sentence is why most of these tests exist: the easy way for this
 * screen to rot is for a "save" button to survive on a row that the server
 * will refuse anyway, so the customer's paper shows one price and the
 * database another. The 409 test proves the page keeps the server's sentence
 * rather than its own; the approved-bid test proves the buttons the guard
 * refuses are never offered.
 *
 * The line total is never editable and never typed: it is the server's
 * generated `unit_price * quantity`, so the tests assert the total arrives by
 * re-read, not by arithmetic done in a component.
 */

jest.mock('../services/bidService', () => {
  const actual = jest.requireActual('../services/bidService');
  return {
    ...actual,
    bidService: {
      bid: jest.fn(), bidItems: jest.fn(), addLine: jest.fn(), updateLine: jest.fn(),
      removeLine: jest.fn(), approve: jest.fn(), decline: jest.fn(), convert: jest.fn(),
    },
  };
});
jest.mock('../services/authService', () => ({
  authService: { hasRole: () => true, getUser: () => ({ id: 1, role: 'office' }) },
}));

const bid = bidService.bid as jest.Mock;
const bidItems = bidService.bidItems as jest.Mock;
const addLine = bidService.addLine as jest.Mock;
const updateLine = bidService.updateLine as jest.Mock;
const removeLine = bidService.removeLine as jest.Mock;
const approve = bidService.approve as jest.Mock;
const convert = bidService.convert as jest.Mock;

const DRAFT: BidDetail = {
  id: 7, bid_date: '2024-12-02', status: 'draft', payer_id: 9, payer_name: 'Smith, Jane',
  property_id: null, site_address: null, site_city: null, site_state: null, site_zip: null,
  mailing_address: '412 Township Rd', mailing_city: 'Elkhart', mailing_state: 'IN',
  mailing_zip: '46514', notes: null, decline_note: null, bid_tax_rate: '0.0000',
  approved_on: null, approved_at: null, approved_by_name: null, declined_at: null,
  invoice_id: null, subtotal: '1200.00', line_count: 2, eff_tax_rate: '0.0550',
  tax_estimated: true, tax_amount: '66.00', total: '1266.00',
  lines: [
    { id: 11, bid_item_id: 3, item_name: 'Labor', description: 'Labor', unit: 'hour',
      unit_price: '300.00', quantity: '3.00', line_total: '900.00', sequence_no: 1 },
    { id: 12, bid_item_id: null, item_name: null, description: 'Schedule 40 PVC pipe',
      unit: 'feet', unit_price: '3.00', quantity: '100.00', line_total: '300.00',
      sequence_no: 2 },
  ],
};
const APPROVED: BidDetail = {
  ...DRAFT, status: 'approved', bid_tax_rate: '0.0550', tax_estimated: false,
  approved_on: '2024-12-02', approved_at: '2024-12-02 10:15:00',
  approved_by_name: 'Dana Office',
};
const INVOICED: BidDetail = { ...APPROVED, status: 'invoiced', invoice_id: 77 };

const ITEM = { id: 3, name: 'Labor', unit: 'hour', unit_price: '300.00',
  is_active: true, created_at: '2024-11-01' };

const apiError = (message: string) => ({ response: { data: { error: message } } });

const renderAt = () => render(
  <MemoryRouter initialEntries={['/bids/7']}>
    <Routes>
      <Route path="/bids/:id" element={<BidDetailPage />} />
      <Route path="/bids/7/print" element={<div>print-marker</div>} />
      <Route path="/invoices/:id" element={<div>invoice-marker</div>} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  jest.clearAllMocks();
  bid.mockResolvedValue({ data: DRAFT });
  bidItems.mockResolvedValue({ data: [ITEM] });
  addLine.mockResolvedValue({ data: DRAFT.lines[0] });
  updateLine.mockResolvedValue({ data: DRAFT.lines[1] });
  removeLine.mockResolvedValue({ data: { removed: true } });
  approve.mockResolvedValue({ data: APPROVED });
  convert.mockResolvedValue({ data: { bid_id: 7, invoice_id: 77,
    subtotal: '1200.00', tax_amount: '66.00', total: '1266.00' } });
});

describe('T-BIL-11: the draft', () => {
  it('shows the lines with the server-computed money', async () => {
    renderAt();
    expect(await screen.findByText('Schedule 40 PVC pipe')).toBeInTheDocument();
    expect(screen.getByText('$900.00')).toBeInTheDocument();
    const pipeRow = within((await screen.findByText('Schedule 40 PVC pipe')).closest('tr')!);
    expect(pipeRow.getByText('$3.00')).toBeInTheDocument();
    expect(pipeRow.getByText('$300.00')).toBeInTheDocument();
    expect(screen.getByText(/Total \$1,266\.00/)).toBeInTheDocument();
    expect(screen.getByText(/\(estimate at current rate\)/)).toBeInTheDocument();
  });

  it('adding from the price list sends the item id, never a price', async () => {
    renderAt();
    const box = await screen.findByLabelText('price list item');
    await userEvent.click(box);
    await userEvent.type(box, 'Labor');
    await userEvent.click(await screen.findByRole('option', { name: /Labor — \$300\.00\/hour/ }));
    await userEvent.click(screen.getByRole('button', { name: 'add item line' }));
    await waitFor(() => expect(addLine).toHaveBeenCalledWith(7,
      { bid_item_id: 3, quantity: '1' }));
    await waitFor(() => expect(bid).toHaveBeenCalledTimes(2)); // re-read, not a local append
  });

  it('a one-off line carries its own facts', async () => {
    renderAt();
    await screen.findByText('Schedule 40 PVC pipe');
    await userEvent.click(screen.getByRole('button', { name: 'One-off line…' }));
    await userEvent.type(screen.getByLabelText('one-off description'), 'Rock removal');
    await userEvent.type(screen.getByLabelText('one-off price'), '150');
    const q = screen.getByLabelText('one-off quantity');
    await userEvent.clear(q);
    await userEvent.type(q, '2');
    await userEvent.click(screen.getByRole('button', { name: 'add one-off line' }));
    await waitFor(() => expect(addLine).toHaveBeenCalledWith(7, {
      description: 'Rock removal', unit: 'each', unit_price: '150', quantity: '2',
    }));
  });

  it('editing a line patches fields and reloads — the total is the server’s', async () => {
    bid.mockResolvedValue({ data: { ...DRAFT,
      lines: DRAFT.lines.map((l) => (l.id === 12 ? { ...l, unit_price: '4.00', line_total: '400.00' } : l)),
      subtotal: '1300.00', total: '1371.50' } });
    renderAt();
    const row = within((await screen.findByText('Schedule 40 PVC pipe')).closest('tr')!);
    await userEvent.click(row.getByRole('button', { name: 'edit line 12' }));
    const price = row.getByLabelText('line price');
    await userEvent.clear(price);
    await userEvent.type(price, '4');
    await userEvent.click(row.getByRole('button', { name: 'save line 12' }));
    await waitFor(() => expect(updateLine).toHaveBeenCalledWith(7, 12,
      { description: 'Schedule 40 PVC pipe', unit: 'feet', quantity: '100.00', unit_price: '4' }));
    expect(await screen.findByText(/Total \$1,371\.50/)).toBeInTheDocument();
  });

  it('removing a line is a call and a re-read', async () => {
    bid.mockResolvedValueOnce({ data: DRAFT })
      .mockResolvedValue({ data: { ...DRAFT, lines: [DRAFT.lines[0]] } });
    renderAt();
    const row = within((await screen.findByText('Schedule 40 PVC pipe')).closest('tr')!);
    await userEvent.click(row.getByRole('button', { name: 'remove line 12' }));
    await waitFor(() => expect(removeLine).toHaveBeenCalledWith(7, 12));
    await waitFor(() => expect(screen.queryByText('Schedule 40 PVC pipe')).not.toBeInTheDocument());
  });
});

describe('T-BIL-12: the signature, and everything a signature forbids', () => {
  it('approving is a call and a re-read — the stamp comes back from the server', async () => {
    bid.mockResolvedValueOnce({ data: DRAFT }).mockResolvedValue({ data: APPROVED });
    renderAt();
    await userEvent.click(await screen.findByRole('button', { name: 'approve bid' }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith(7));
    expect(await screen.findByText(/12\/02\/2024 by Dana Office/)).toBeInTheDocument();
    expect(screen.queryByText(/\(estimate at current rate\)/)).not.toBeInTheDocument();
    expect(screen.getByText('Sales tax 5.5% — $66.00')).toBeInTheDocument();
  });

  it('an approved bid offers no editor and no second signature', async () => {
    bid.mockResolvedValue({ data: APPROVED });
    renderAt();
    expect(await screen.findByText('Schedule 40 PVC pipe')).toBeInTheDocument();
    expect(screen.queryByLabelText('price list item')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'approve bid' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'decline bid' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit line/ })).not.toBeInTheDocument();
  });

  it('a late write hears the server’s sentence and the page does not move', async () => {
    approve.mockRejectedValueOnce(apiError(
      'Only a draft bid can be approved — this one is invoiced.'));
    renderAt();
    await userEvent.click(await screen.findByRole('button', { name: 'approve bid' }));
    expect(await screen.findByText(
      'Only a draft bid can be approved — this one is invoiced.')).toBeInTheDocument();
    expect(bid).toHaveBeenCalledTimes(1); // a refusal does not reload a moved document
  });

  it('converting once yields an invoice the desk can walk straight to', async () => {
    bid
      .mockResolvedValueOnce({ data: APPROVED })
      .mockResolvedValue({ data: INVOICED });
    renderAt();
    await userEvent.click(await screen.findByRole('button', { name: 'convert to invoice' }));
    await waitFor(() => expect(convert).toHaveBeenCalledWith(7));
    // The href, not a click: clicking a router Link from user-event lands the
    // history update outside act() and React 18 turns that into a thrown
    // error. Where the link points is the contract; the router's own
    // behaviour is not this page's to test.
    expect(await screen.findByRole('link', { name: 'Invoice 77' }))
      .toHaveAttribute('href', '/invoices/77');
  });

  it('a declined bid is a decision, not a draft', async () => {
    bid.mockResolvedValue({ data: { ...DRAFT, status: 'declined', decline_note: 'too high',
      declined_at: '2024-12-03 08:00:00', tax_estimated: false } });
    renderAt();
    expect(await screen.findByText(/Declined — a decision, not a draft/)).toBeInTheDocument();
    expect(screen.getByText(/too high/)).toBeInTheDocument();
    expect(screen.queryByLabelText('price list item')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'convert to invoice' })).not.toBeInTheDocument();
  });
});
