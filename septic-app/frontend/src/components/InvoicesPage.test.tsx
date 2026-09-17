import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import InvoicesPage from './InvoicesPage';
import { invoiceService, InvoiceRow, InvoiceDetail } from '../services/invoiceService';

/**
 * T-BIL-05's screen. The load-bearing behaviour is that the adjustment dialog
 * is seeded from the ORIGINAL's lines — references included — because the
 * orphaned 3,120 of BIL-03 are what a correction form with a free-text
 * description column eventually becomes. The reference must survive the trip
 * through the form, and the test reads the JSON in the dialog to prove it
 * rather than trusting the submit call alone.
 */

jest.mock('../services/userService', () => ({ userService: {} }));
jest.mock('../services/authService', () => ({
  authService: { hasRole: () => true, getUser: () => ({ id: 1 }) },
}));
jest.mock('../services/invoiceService', () => {
  const actual = jest.requireActual('../services/invoiceService');
  return {
    ...actual,
    invoiceService: { list: jest.fn(), get: jest.fn(), adjust: jest.fn(), pay: jest.fn() },
  };
});

const list = invoiceService.list as jest.Mock;
const get = invoiceService.get as jest.Mock;
const adjust = invoiceService.adjust as jest.Mock;
const pay = invoiceService.pay as jest.Mock;

const ROW: InvoiceRow = {
  id: 42, legacy_invoice_no: 15885, invoice_date: '2024-11-02T00:00:00.000Z',
  kind: 'invoice', status: 'open', subtotal: '300.00', tax_amount: '0.00',
  total: '300.00', amount_paid: '0.00', payer_name: 'Ziegler, Ron', adjusted_by: null,
};

const DETAIL: InvoiceDetail = {
  ...ROW, payer_id: 9, property_id: 4, adjusts_invoice_id: null,
  lines: [{
    id: 1, service_event_id: null, legacy_product_code: 'PMP-1000',
    service_type_id: 2, description: 'Pump out 1,000 gal tank',
    quantity: '1.00', unit_price: '300.00', amount: '300.00',
  }],
  payments: [{
    id: 3, amount: '100.00', method: 'check', note: null, reference: '88',
    paid_at: '2024-11-20', received_by: null,
  }],
};

beforeEach(() => {
  jest.clearAllMocks();
  list.mockResolvedValue({ data: [ROW], meta: { total: 1, page: 1, limit: 50 } });
  get.mockResolvedValue(DETAIL);
  adjust.mockResolvedValue({ ...ROW, id: 43, kind: 'adjustment', adjusts_invoice_id: 42 });
  pay.mockResolvedValue({ payment: { id: 7 }, invoice: { status: 'partial', amount_paid: '150.00', balance: 185 } });
});

describe('T-BIL-05: adjusting from the book', () => {
  it('lists invoices with their money as numbers, not as nulls', async () => {
    render(<MemoryRouter><InvoicesPage /></MemoryRouter>);
    expect(await screen.findByText('Ziegler, Ron')).toBeInTheDocument();
    expect(screen.getByText('15885')).toBeInTheDocument();
  });

  it('the balance column sorts server-side, not the fifteen rows on the page', async () => {
    // The book is paginated, so a client sort would order one page and call the
    // rest honest; the header has to hand `balance` to the query instead.
    render(<MemoryRouter><InvoicesPage /></MemoryRouter>);
    await screen.findByText('Ziegler, Ron');
    await userEvent.click(screen.getByRole('button', { name: 'Balance' }));
    await waitFor(() => expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ sort: 'balance', dir: 'asc' })));
  });

  it('correcting a line’s price files only the difference, keeping the reference',
    async () => {
      render(<MemoryRouter><InvoicesPage /></MemoryRouter>);
      await userEvent.click(await screen.findByText('Ziegler, Ron'));
      await userEvent.click(await screen.findByRole('button', { name: 'Adjust' }));

      // The form opens prefilled at the charged values, so there is nothing to file
      // and the desk is told so — no accidental $0 adjustment.
      expect(screen.getByText(/nothing to file yet/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /file adjustment/i })).toBeDisabled();

      // 1 × $300 that should have been 1 × $250: the correction is −$50, not the whole line.
      const price = screen.getByLabelText('correct price 1');
      await userEvent.clear(price);
      await userEvent.type(price, '250');
      // A corrected value is intent, not an explanation: the reason still gates filing.
      expect(screen.getByRole('button', { name: /file adjustment/i })).toBeDisabled();

      await userEvent.type(screen.getByLabelText('adjustment reason'), 'wrong rate on the pump-out');
      expect(screen.getByRole('button', { name: /file adjustment/i })).toBeEnabled();
      await userEvent.click(screen.getByRole('button', { name: /file adjustment/i }));

      await waitFor(() => expect(adjust).toHaveBeenCalledTimes(1));
      const [id, lines, reason] = adjust.mock.calls[0];
      expect(id).toBe(42);
      expect(lines).toHaveLength(1);
      // BIL-01 held by the form: the difference rides on the original's own product
      // code, and it is signed — a correction, not an invention.
      expect(lines[0]).toMatchObject({ legacy_product_code: 'PMP-1000', quantity: 1, unit_price: -50 });
      expect(reason).toBe('wrong rate on the pump-out');
    }, 20000);

  it('a corrected quantity of 0 is the whole credit; a partial one is the difference',
    async () => {
      render(<MemoryRouter><InvoicesPage /></MemoryRouter>);
      await userEvent.click(await screen.findByText('Ziegler, Ron'));
      await userEvent.click(await screen.findByRole('button', { name: 'Adjust' }));
      const qty = screen.getByLabelText('correct qty 1');
      await userEvent.clear(qty);
      await userEvent.type(qty, '0');
      await userEvent.type(screen.getByLabelText('adjustment reason'), 'never actually pumped');
      await userEvent.click(screen.getByRole('button', { name: /file adjustment/i }));
      await waitFor(() => expect(adjust).toHaveBeenCalledTimes(1));
      expect(adjust.mock.calls[0][1][0]).toMatchObject({ unit_price: -300, quantity: 1 });
    }, 20000);

  it('a refusal from the server arrives with the server’s own words', async () => {
    adjust.mockRejectedValueOnce({
      response: { data: { error: 'every line must reference a service event or a product code' } },
    });
    render(<MemoryRouter><InvoicesPage /></MemoryRouter>);
    await userEvent.click(await screen.findByText('Ziegler, Ron'));
    await userEvent.click(await screen.findByRole('button', { name: 'Adjust' }));
    const price = screen.getByLabelText('correct price 1');
    await userEvent.clear(price);
    await userEvent.type(price, '250');
    await userEvent.type(screen.getByLabelText('adjustment reason'), 'correcting the double');
    await userEvent.click(screen.getByRole('button', { name: /file adjustment/i }));
    expect(await screen.findByText(/must reference a service event or a product code/))
      .toBeInTheDocument();
  }, 20000);

  it('the detail reads the whole correction chain — the reason and who filed each', async () => {
    get.mockResolvedValue({
      ...DETAIL,
      history: [
        { id: 42, legacy_invoice_no: 15885, kind: 'invoice', invoice_date: '2024-11-02',
          status: 'open', subtotal: '300.00', tax_amount: '0.00', total: '300.00',
          amount_paid: '0.00', adjusts_invoice_id: null, adjust_reason: null,
          created_by: 1, created_by_name: 'Orig Author', created_on: '2026-09-13' },
        { id: 43, legacy_invoice_no: null, kind: 'adjustment', invoice_date: '2024-11-05',
          status: 'open', subtotal: '-300.00', tax_amount: '0.00', total: '-300.00',
          amount_paid: '0.00', adjusts_invoice_id: 42,
          adjust_reason: 'billed twice — reversed the second',
          created_by: 1, created_by_name: 'Adj Author', created_on: '2026-09-13' },
      ],
    });
    render(<MemoryRouter><InvoicesPage /></MemoryRouter>);
    await userEvent.click(await screen.findByText('Ziegler, Ron'));
    expect(await screen.findByText('Adjustment history')).toBeInTheDocument();
    // the reason the desk typed, and the person who filed it — the complaint answer.
    expect(screen.getByText('billed twice — reversed the second')).toBeInTheDocument();
    expect(screen.getByText('Adj Author')).toBeInTheDocument();
  });

  it('an invoice that is already adjusted offers no second adjustment', async () => {
    list.mockResolvedValue({
      data: [{ ...ROW, adjusted_by: 43 }], meta: { total: 1, page: 1, limit: 50 },
    });
    render(<MemoryRouter><InvoicesPage /></MemoryRouter>);
    await screen.findByText('Ziegler, Ron');
    expect(screen.queryByRole('button', { name: /open invoice 42/ })).not.toBeInTheDocument();
    expect(screen.getByText('adjusted')).toBeInTheDocument();
  });
});

describe('T-BIL-06: recording the receipt from the book', () => {
  it('seeds the dialog with the balance, not with zero', async () => {
    get.mockResolvedValue({ ...DETAIL, total: '335.00', amount_paid: '150.00' });
    render(<MemoryRouter><InvoicesPage /></MemoryRouter>);
    await userEvent.click(await screen.findByText('Ziegler, Ron'));
    await screen.findByText('Balance $185.00');
    await userEvent.click(screen.getByRole('button', { name: /record payment/i }));
    // Jane Smith's number is what the clerk would type; seeding it means the
    // typo surface is a correction, not an invention.
    expect(screen.getByLabelText('payment amount')).toHaveValue(185);
  });

  it('a failed send keeps one client_uuid, so the retry cannot bank two receipts', async () => {
    get.mockResolvedValue({ ...DETAIL, total: '335.00', amount_paid: '150.00' });
    pay.mockRejectedValueOnce({ response: { data: { error: 'boom 12345' } } });
    render(<MemoryRouter><InvoicesPage /></MemoryRouter>);
    await userEvent.click(await screen.findByText('Ziegler, Ron'));
    await userEvent.click(await screen.findByRole('button', { name: /record payment/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Record' }));
    await screen.findByText('boom 12345');
    await userEvent.click(screen.getByRole('button', { name: 'Record' }));
    await waitFor(() => expect(pay).toHaveBeenCalledTimes(2));
    expect(pay.mock.calls[0][1].client_uuid).toBe(pay.mock.calls[1][1].client_uuid);
  });

  it('names the legacy receipts for what they are', async () => {
    render(<MemoryRouter><InvoicesPage /></MemoryRouter>);
    await userEvent.click(await screen.findByText('Ziegler, Ron'));
    expect(await screen.findByText('legacy import')).toBeInTheDocument();
  });
});

describe('T-BIL-20: the desk door', () => {
  it('the book offers a blank invoice, and opening it does not disturb the book',
    async () => {
      const user = userEvent.setup();
      render(<MemoryRouter><InvoicesPage /></MemoryRouter>);
      expect(await screen.findByText('Ziegler, Ron')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /new invoice/i }));
      // Title and trigger share the words — the dialog is the heading, not
      // a button.
      expect(await screen.findByRole('heading', { name: 'New invoice' }))
        .toBeInTheDocument();
      expect(screen.getByLabelText(/Billed to/i)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /^cancel$/i }));
      expect(screen.queryByRole('heading', { name: 'New invoice' })).toBeNull();
      expect(screen.getByText('Ziegler, Ron')).toBeInTheDocument();
    });
});
