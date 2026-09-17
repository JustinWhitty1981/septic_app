import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import PrintInvoicePage from './PrintInvoicePage';
import { invoiceService, InvoiceDetail } from '../services/invoiceService';
import { settingsService, CompanySettings } from '../services/settingsService';

/**
 * T-BIL-08's statement. Two things can rot on a printed document: the money
 * and the address. The balance line is derived in the browser from the same
 * two server numbers every other screen uses — the test pins the arithmetic
 * result, not the markup. The mailing block must come from the invoice's own
 * payer (SCH-07: paper is the delivery channel, 0 emails exist), and the
 * payment history has to carry the running balance so a partial payment
 * prints as Jane Smith's call: 150 down, 185 due.
 */

jest.mock('../services/invoiceService', () => {
  const actual = jest.requireActual('../services/invoiceService');
  return { ...actual, invoiceService: { get: jest.fn() } };
});
// The statement prints the company's own terms, so the page reads the one settings
// row too — a print test that never stubbed it would fail on an unmocked axios call.
jest.mock('../services/settingsService', () => {
  const actual = jest.requireActual('../services/settingsService');
  return { ...actual, settingsService: {
    get: jest.fn(), setSalesTax: jest.fn(), setPaymentTerms: jest.fn(),
    getLogoUrl: jest.fn(),
  } };
});

const get = invoiceService.get as jest.Mock;
const getSettings = settingsService.get as jest.Mock;
const getLogoUrl = settingsService.getLogoUrl as jest.Mock;

const SETTINGS: CompanySettings = {
  sales_tax_rate: '0.0550', payment_term_days: 30,
  late_fee_rate_monthly: '0.0150',
  company_name: 'Northfield Septic', logo_media_id: null,
  address: null, email: null, phone: null,
  updated_at: null, updated_by: null,
};

const DOC: InvoiceDetail = {
  id: 42, legacy_invoice_no: 15885, invoice_date: '2024-11-02T00:00:00.000Z',
  kind: 'invoice', status: 'partial', subtotal: '335.00', tax_amount: '0.00',
  total: '335.00', amount_paid: '150.00', payer_name: 'Smith, Jane', adjusted_by: null,
  payer_id: 9, property_id: 4, adjusts_invoice_id: null, balance: 185,
  mailing_address: '412 Township Rd', mailing_city: 'Elkhart', mailing_state: 'IN',
  mailing_zip: '46514', site_address: 'Lot 7 CR-42', site_city: null,
  lines: [{
    id: 1, service_event_id: null, legacy_product_code: 'PMP-350',
    service_type_id: 2, description: 'Pump out 350 gal tank',
    quantity: '1.00', unit_price: '335.00', amount: '335.00',
  }],
  payments: [{
    id: 3, amount: '150.00', method: 'check', note: null, reference: '88',
    paid_at: '2024-11-20', received_by: 'office@septic.test',
  }],
};

const renderAt = (path: string) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes><Route path="/invoices/:id/print" element={<PrintInvoicePage />} /></Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  jest.clearAllMocks();
  get.mockResolvedValue(DOC);
  getSettings.mockResolvedValue(SETTINGS);
  // jsdom has no window.print; stub so ?auto can be exercised at all.
  (window as any).print = jest.fn();
});

describe('T-BIL-08: the mailed statement', () => {
  it('prints the phone call: 335 total, 150 paid, 185 due', async () => {
    renderAt('/invoices/42/print');
    expect(await screen.findByText('Smith, Jane')).toBeInTheDocument();
    expect(screen.getByText(/Total \$335\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Balance due \$185\.00/)).toBeInTheDocument();
  });

  it('the mailing block is the payer\u2019s, not a copy someone retyped', async () => {
    renderAt('/invoices/42/print');
    expect(await screen.findByText('412 Township Rd')).toBeInTheDocument();
    expect(screen.getByText(/Elkhart, IN, 46514/)).toBeInTheDocument();
  });

  it('the payment history carries the running balance', async () => {
    renderAt('/invoices/42/print');
    expect(await screen.findByText(/balance \$185\.00/)).toBeInTheDocument();
    expect(screen.getByText(/check #88/)).toBeInTheDocument();
  });

  it('an adjustment prints as what it is, not as an invoice', async () => {
    get.mockResolvedValue({ ...DOC, kind: 'adjustment', total: '-335.00',
      amount_paid: '0.00', adjusts_invoice_id: 42, payments: [] });
    renderAt('/invoices/43/print');
    expect(await screen.findByText(/not an invoice/i)).toBeInTheDocument();
    expect(screen.getByText(/corrects invoice #42/)).toBeInTheDocument();
  });

  it('?auto opens the print dialog exactly once', async () => {
    renderAt('/invoices/42/print?auto=1');
    // The component delays print one tick past the final paint; this just
    // waits in real time for that 250ms hop and the guard that follows it.
    await waitFor(() => expect((window as any).print).toHaveBeenCalledTimes(1),
      { timeout: 2000 });
  });
});

describe('T-BIL-08b: the sheet is the one the office owns', () => {
  // "Prints cleanly" is a claim about paper: 8.5×11, one-inch-ish margins,
  // no app chrome, no line item torn in half, and the grays actually
  // printed. jsdom cannot render a page — these pin the stylesheet's
  // promises, and the walk-through is the visual half.
  it('asks the browser for a letter page, keeps rows whole, repeats the line header, and keeps the chrome out',
    async () => {
      renderAt('/invoices/3312/print');
      await screen.findByText('Smith, Jane');
      // Emotion owns its own <style> tags; the print sheet is the one that
      // knows about paper.
      const css = Array.from(document.querySelectorAll('style'))
        .map((el) => el.textContent ?? '').join('\n');
      expect(css).not.toBe('');
      expect(css).toContain('@page');
      expect(css).toMatch(/size:\s*letter/);
      expect(css).toMatch(/break-inside:\s*avoid/);
      expect(css).toMatch(/display:\s*table-header-group/);
      expect(css).toMatch(/print-color-adjust:\s*exact/);
      expect(css).toMatch(/\.MuiDrawer-root[^]*display:\s*none/);
      // The toolbar that offers printing is itself never printed: it lives
      // inside the no-print block.
      expect(document.querySelector('.no-print')).toContainElement(
        screen.getByRole('button', { name: /print/i }),
      );
    });
});

// 0037: the header is the company's to decide, not the component's to hardcode.
// Before this the statement printed a string baked into the page — no phone to
// call it in about, no address to reply to, and a name the bid disagreed with.
describe('T-BIL-08c: the letterhead is the office’s, read from settings', () => {
  it('prints the company’s own name, address, email and phone', async () => {
    getSettings.mockResolvedValue({ ...SETTINGS,
      company_name: 'Northfield Septic LLC',
      address: '9 Water Tower Dr, Elkhart, IN 46514',
      email: 'office@septic.test', phone: '(574) 555-0123' });
    renderAt('/invoices/42/print');
    expect(await screen.findByText('Northfield Septic LLC')).toBeInTheDocument();
    expect(screen.getByText('9 Water Tower Dr, Elkhart, IN 46514')).toBeInTheDocument();
    expect(screen.getByText('office@septic.test')).toBeInTheDocument();
    expect(screen.getByText('(574) 555-0123')).toBeInTheDocument();
  });

  it('prints the stored logo, fetched because the bucket is private', async () => {
    getSettings.mockResolvedValue({ ...SETTINGS, logo_media_id: 55 });
    getLogoUrl.mockResolvedValue('blob:fake-logo');
    renderAt('/invoices/42/print');
    const img = await screen.findByRole('img');
    expect(img).toHaveAttribute('src', 'blob:fake-logo');
    expect(getLogoUrl).toHaveBeenCalledWith(55);
  });

  it('with no logo set, no image is requested and the paper prints plain', async () => {
    renderAt('/invoices/42/print');
    expect(await screen.findByText('Smith, Jane')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(getLogoUrl).not.toHaveBeenCalled();
  });

  it('a logo that fails to fetch never fails the document', async () => {
    getSettings.mockResolvedValue({ ...SETTINGS, logo_media_id: 55 });
    getLogoUrl.mockRejectedValue(new Error('gone'));
    renderAt('/invoices/42/print');
    expect(await screen.findByText('Smith, Jane')).toBeInTheDocument();
    expect(screen.getByText(/Total \$335\.00/)).toBeInTheDocument();
  });
});

// T-BIL-05 × T-BIL-08: the one paper the office can actually send. James
// Kiesner's shape — a $1,100 bill with a $20 discount folded under it — printed
// as a single invoice: headed by the ORIGINAL's number, the correction shown as
// its own signed line carrying its reason, and the balance netted to $1,080.
// Crucially it is reached by opening the *credit* (43): the credit was never the
// document to mail, the bill is — with the credit folded beneath it.
describe('T-BIL-05 × T-BIL-08: the adjusted invoice goes out as ONE document', () => {
  const LINE = (id: number, description: string, unit: string, amount: string) => ({
    id, service_event_id: null, legacy_product_code: 'SVC-STD', service_type_id: 2,
    description, quantity: '1.00', unit_price: unit, amount,
  });
  // The server bills the head as issued and reconciles it below with a signed
  // ledger — each correction naming the document it was filed under, then each
  // receipt — so the browser adds none of the money (BIL-07). This is that shape.
  const CREDIT: InvoiceDetail = {
    ...DOC, id: 43, legacy_invoice_no: null, kind: 'adjustment',
    subtotal: '-20.00', tax_amount: '0.00', total: '-20.00', amount_paid: '0.00',
    balance: -20, adjusts_invoice_id: 42, payments: [], lines: [],
    statement: {
      invoice_id: 42, display_number: '15885',
      subtotal: '1100.00', tax_amount: '0.00', total: '1100.00',
      amount_paid: '0.00', balance_due: '1080.00',
      lines: [LINE(1, 'standard pump-out', '1100.00', '1100.00')],
      ledger: [
        { kind: 'adjustment', id: 43, date: '2026-09-14', ref: 'invoice #43',
          label: 'Discount', amount: '-20.00', running: '1080.00' },
      ],
      adjustments: [{
        id: 43, invoice_date: '2026-09-14', kind: 'adjustment',
        adjust_reason: 'Discount', total: '-20.00',
        lines: [LINE(2, 'office discount', '-20.00', '-20.00')],
      }],
    },
  };
  // The complaint made whole: the same bill, paid. The ledger draws it to zero and
  // the header is `paid` — the number James Kiesner should have been shown.
  const PAID_HEAD: InvoiceDetail = {
    ...DOC, id: 42, kind: 'invoice', subtotal: '1100.00', tax_amount: '0.00',
    total: '1100.00', amount_paid: '1080.00', status: 'paid', balance: 0,
    payments: [], lines: [],
    statement: {
      invoice_id: 42, display_number: '15885',
      subtotal: '1100.00', tax_amount: '0.00', total: '1100.00',
      amount_paid: '1080.00', balance_due: '0.00',
      lines: [LINE(1, 'standard pump-out', '1100.00', '1100.00')],
      ledger: [
        { kind: 'adjustment', id: 43, date: '2026-09-14', ref: 'invoice #43',
          label: 'Discount', amount: '-20.00', running: '1080.00' },
        { kind: 'payment', id: 70, date: '2026-09-15', ref: '#CH1',
          label: 'check · office', amount: '1080.00', running: '0.00' },
      ],
      adjustments: [{
        id: 43, invoice_date: '2026-09-14', kind: 'adjustment',
        adjust_reason: 'Discount', total: '-20.00',
        lines: [LINE(2, 'office discount', '-20.00', '-20.00')],
      }],
    },
  };

  it('opens the credit and hands back the bill: original headed, billed as issued', async () => {
    get.mockResolvedValue(CREDIT);
    renderAt('/invoices/43/print?statement=1');
    expect(await screen.findByText('Smith, Jane')).toBeInTheDocument();
    // Headed by the ORIGINAL's number (15885), not the credit's own (which has none).
    expect(screen.getByText(/15885/)).toBeInTheDocument();
    // It bills $1,100 as issued and the ledger — not a rewritten header — is what
    // takes the $20 off, landing the balance due at $1,080.
    expect(screen.getByText(/Total \$1,100\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Balance due \$1,080\.00/)).toBeInTheDocument();
  });

  it('shows the bill line, then the correction as its own signed ledger line — reason and its number', async () => {
    get.mockResolvedValue(CREDIT);
    renderAt('/invoices/43/print?statement=1');
    expect(await screen.findByText(/standard pump-out/)).toBeInTheDocument();
    // The $1,100 shows in the line's unit price and amount, and again as the
    // billed total — assert it is present rather than asking for one node.
    expect(screen.getAllByText(/\$1,100\.00/).length).toBeGreaterThan(0);
    // The correction is its own reconciling line, not a silently folded header: it
    // names itself an adjustment, carries the reason the office filed it under,
    // points at the document number it was created as, and shows the signed $20.
    expect(screen.getByText(/Adjustment/)).toBeInTheDocument();
    expect(screen.getByText(/Discount/)).toBeInTheDocument();
    expect(screen.getByText(/invoice #43/)).toBeInTheDocument();
    expect(screen.getAllByText(/\$-20\.00/).length).toBeGreaterThan(0);
    expect(screen.getByText(/balance \$1,080\.00/)).toBeInTheDocument();
  });

  it('a paid corrected bill reconciles the ledger to zero and reads paid', async () => {
    get.mockResolvedValue(PAID_HEAD);
    renderAt('/invoices/42/print');
    expect(await screen.findByText('Smith, Jane')).toBeInTheDocument();
    expect(screen.getByText(/Total \$1,100\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Balance due \$0\.00/)).toBeInTheDocument();
    expect(screen.getByText(/check · office/)).toBeInTheDocument();
    // The customer's copy adds itself to zero — the last running balance is $0.00.
    expect(screen.getByText(/balance \$0\.00/)).toBeInTheDocument();
  });

  it('is presented as an invoice, so it never prints the "not an invoice" warning', async () => {
    get.mockResolvedValue(CREDIT);
    renderAt('/invoices/43/print?statement=1');
    await screen.findByText('Smith, Jane');
    expect(screen.queryByText(/not an invoice/i)).toBeNull();
  });

  it('states the company terms on the face of the bill', async () => {
    get.mockResolvedValue(CREDIT);
    renderAt('/invoices/43/print?statement=1');
    await screen.findByText('Smith, Jane');
    expect(screen.getByText(/Payments are due 30 days from the invoice date of/)).toBeInTheDocument();
    expect(screen.getByText(/1\.5% per month will be charged on past-due invoices/)).toBeInTheDocument();
  });

  it('without ?statement it stays the single record as filed', async () => {
    get.mockResolvedValue({ ...DOC, kind: 'invoice' });
    renderAt('/invoices/42/print');
    expect(await screen.findByText(/Total \$335\.00/)).toBeInTheDocument();
    // The as-filed record of a plain bill carries no netting ledger and no terms
    // banner — those belong to a bill sent out, not a document left as-is.
    expect(screen.queryByText(/Payments and adjustments/)).toBeNull();
  });
});
