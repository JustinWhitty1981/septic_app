import React from 'react';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import NewInvoiceDialog from './NewInvoiceDialog';
import { invoiceService } from '../services/invoiceService';
import { bidService } from '../services/bidService';
import { payerService } from '../services/payerService';
import { propertyService } from '../services/propertyService';
import { ledgerService, UnbilledRow } from '../services/ledgerService';

/**
 * T-BIL-20 on the desk. The backend suite proves the server owns the money;
 * these tests pin what the office can actually do with that arrangement:
 * carry a checked queue selection into a real document, add a price-list
 * line, refuse to submit a line without a price, and read the server's
 * refusal — verbatim — instead of a paraphrase about duplicates.
 */

jest.mock('../services/invoiceService', () => {
  const actual = jest.requireActual('../services/invoiceService');
  return { ...actual, invoiceService: { ...actual.invoiceService, create: jest.fn() } };
});
jest.mock('../services/bidService', () => ({
  bidService: {
    bidItems: jest.fn(), settings: jest.fn(),
  },
}));
jest.mock('../services/payerService', () => ({ payerService: { search: jest.fn() } }));
jest.mock('../services/propertyService', () => ({
  propertyService: { search: jest.fn().mockResolvedValue({ data: [] }) },
}));
jest.mock('../services/ledgerService', () => ({
  ledgerService: { unbilled: jest.fn().mockResolvedValue({ data: [], meta: {} }) },
}));

const create = invoiceService.create as jest.Mock;
const bidItems = bidService.bidItems as jest.Mock;
const settings = bidService.settings as jest.Mock;
const unbilled = ledgerService.unbilled as jest.Mock;

const eventRow = (over: Partial<UnbilledRow> = {}): UnbilledRow => ({
  service_event_id: '4001', property_id: 77, legacy_cust_number: 2248,
  payer_label: 'Zorn, Ada', site_address: '12 Creek Rd', site_city: 'Freedom',
  county_id: 15, service_date: '2026-09-04', days_ago: 1, gallons_pumped: '1000',
  source: 'app', waste_type: 'Septic', disposal_site: 'Land',
  owner_payer_id: 301, owner_payer_name: 'Zorn, Ada — Zorn Holdings',
  ...over,
});

const CREATED = {
  id: 3312, payer_id: 301, property_id: 77,
  payer_name: 'Zorn, Ada — Zorn Holdings', invoice_date: '2026-09-06',
  subtotal: '150.00', tax_rate: '0.0550', tax_amount: '8.25', total: '158.25',
  status: 'open',
};

beforeEach(() => {
  jest.clearAllMocks();
  bidItems.mockResolvedValue({ data: [
    { id: 5, name: 'Sump cleanout', unit: 'job', unit_price: '75.50', is_active: true,
      created_at: '2024-11-01' },
  ] });
  settings.mockResolvedValue({ data: { sales_tax_rate: '0.0550' } });
  unbilled.mockResolvedValue({ data: [], meta: {} });
});

const renderDialog = (over = {}) => {
  const onCreated = jest.fn();
  render(<NewInvoiceDialog onClose={jest.fn()} onCreated={onCreated} {...over} />);
  return onCreated;
};

describe('T-BIL-20: the invoice desk dialog', () => {
  it('carries a queue selection in as real lines and posts it with the site’s owner addressed',
    async () => {
      create.mockResolvedValue({ invoice: CREATED, line_count: 1 });
      const onCreated = renderDialog({
        initialPayer: { id: 301, name: 'Zorn, Ada — Zorn Holdings' },
        initialSite: { id: 77, label: '12 Creek Rd' },
        initialEvents: [eventRow()],
      });

      // The pump-out is a line already — with its facts in the description —
      // but not billable until a human put a price on it.
      expect(await screen.findByDisplayValue(/Pump-out 09\/04\/2026 — 12 Creek Rd/))
        .toBeInTheDocument();
      expect(screen.getByRole('button', { name: /create invoice/i })).toBeDisabled();

      await userEvent.type(
        screen.getByLabelText('line unit price 1'), '150');
      await userEvent.click(screen.getByRole('button', { name: /create invoice/i }));

      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        payer_id: 301, property_id: 77,
        lines: [expect.objectContaining({
          service_event_id: '4001', quantity: '1', unit_price: '150', taxable: true,
        })],
      }));
      // No client-side total is even a field the server could distrust.
      expect(create.mock.calls[0][0]).not.toHaveProperty('total');
      await waitFor(() => expect(onCreated).toHaveBeenCalledWith(CREATED));
    });

  it('a refusal stays the server’s own sentence', async () => {
    create.mockRejectedValue({
      response: { data: { message: 'Event 407 is already billed — invoice 3312 names it.' } },
    });
    const onCreated = renderDialog({
      initialPayer: { id: 301, name: 'Zorn' },
      initialEvents: [eventRow()],
    });
    await screen.findByDisplayValue(/Pump-out/);
    await userEvent.type(screen.getByLabelText('line unit price 1'), '150');
    await userEvent.click(screen.getByRole('button', { name: /create invoice/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Event 407 is already billed — invoice 3312 names it.');
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('a price-list line joins the document with its stored price, and removing it leaves no trace',
    async () => {
      renderDialog({ initialPayer: { id: 301, name: 'Zorn' } });
      await screen.findByText(/No lines yet/);

      await userEvent.click(screen.getByLabelText('add price-list line'));
      await userEvent.click(await screen.findByText('Sump cleanout (job) — $75.50'));

      const desc = await screen.findByDisplayValue('Sump cleanout');
      expect(desc).toBeInTheDocument();
      // The unit price arrives filled from the list — typed where the office
      // disagrees with it, not where it merely re-types it.
      expect(screen.getByDisplayValue('75.50')).toBeInTheDocument();

      await userEvent.click(screen.getByLabelText('remove line 1'));
      expect(screen.getByText(/No lines yet/)).toBeInTheDocument();
    });

  it('from the desk alone, a site search opens that site’s unbilled work', async () => {
    unbilled.mockResolvedValue({
      data: [eventRow({ service_event_id: '5001', gallons_pumped: '750' })], meta: {},
    });
    (propertyService.search as jest.Mock).mockResolvedValue({
      data: [{ id: 77, site_address: '12 Creek Rd', site_city: 'Freedom',
        legacy_cust_number: 2248, payer_label: 'Zorn', status: 'active',
        next_service_due: null, site_state: 'WI', site_zip: '54932', county_id: 15 }],
    });
    renderDialog();

    await userEvent.type(screen.getByLabelText('site search'), 'Creek');
    await userEvent.click(await screen.findByText('12 Creek Rd, Freedom'));
    await waitFor(() => expect(unbilled)
      .toHaveBeenCalledWith(expect.objectContaining({ property_id: 77 })));

    await userEvent.click(await screen.findByRole('button', { name: 'add service 5001' }));
    expect(await screen.findByDisplayValue(/Pump-out 09\/04\/2026/)).toBeInTheDocument();
    // The row leaves the offer: it is on the document now.
    expect(screen.queryByRole('button', { name: 'add service 5001' })).toBeNull();
  });

  it('taxes a line by default and takes it off the taxable base when unchecked', async () => {
    create.mockResolvedValue({ invoice: CREATED, line_count: 1 });
    renderDialog({ initialPayer: { id: 301, name: 'Zorn' }, initialEvents: [eventRow()] });
    await screen.findByDisplayValue(/Pump-out/);
    await userEvent.type(screen.getByLabelText('line unit price 1'), '150');

    // Default: the pump-out is taxed, the way every line was before 0034.
    const box = screen.getByLabelText('line taxable 1');
    expect(box).toBeChecked();
    await userEvent.click(box);
    expect(box).not.toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: /create invoice/i }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    // Intent only: the flag travels, the amount of tax never does.
    expect(create.mock.calls[0][0].lines[0]).toMatchObject({ taxable: false });
  });
});
