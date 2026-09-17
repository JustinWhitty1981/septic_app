import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import axios from 'axios';
import BidsPage from './BidsPage';

/**
 * T-BIL-10 and T-BIL-16's desk. The reason these tests mock axios and not the
 * service is the one computation this screen performs: a clerk types 5.5 and
 * the wire must carry '0.0550', because the server's CHECK refuses the number
 * a human means (BIL-16) and a mock at the service boundary would bless
 * whichever conversion the component happened to call. Everything else on the
 * page is transcription of server money — which the first test pins, down to
 * the "(tax est.)" that must sit on a draft and nowhere else.
 */

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock('../services/authService', () => ({
  authService: { hasRole: () => true, getUser: () => ({ id: 1, role: 'office' }) },
}));

const api = jest.mocked(axios);

const ok = (data: unknown) => Promise.resolve({
  data: { success: true, data }, status: 200, statusText: 'OK', headers: {}, config: {},
});
const refusal = (error: string) => Promise.reject({ response: { data: { error }, status: 400 } });

const SUMMARY = {
  id: 7, bid_date: '2024-12-02', status: 'draft' as const, payer_name: 'Smith, Jane',
  site_address: null, approved_on: null, invoice_id: null, subtotal: '1200.00',
  line_count: 2, eff_tax_rate: '0.0550', tax_estimated: true,
  tax_amount: '66.00', total: '1266.00',
};
const SETTINGS = { sales_tax_rate: '0.0550', updated_at: null, updated_by: null };
const PAYER = {
  id: 9, name: 'Smith, Jane', mailing_address: '412 Township Rd',
  mailing_city: 'Elkhart', mailing_state: 'IN', mailing_zip: '46514',
  legacy_billing_no: null, sites_owned: 2,
};
const SITE = {
  id: 98237, legacy_cust_number: 442, payer_label: 'Smith, Jane',
  site_address: 'Lot 7 CR-42', site_city: null, site_state: null, site_zip: null,
  county_id: null, status: 'active' as const, permit_number: null,
  service_interval_days: 1095, last_service_date: '2023-06-01',
};

const wire = (over: Record<string, (url: string) => Promise<unknown>> = {}) => {
  api.get.mockImplementation((url: string) => {
    if (url.startsWith('/api/bids')) return over.bids ? over.bids(url) : ok([SUMMARY]);
    if (url === '/api/settings') return over.settings ? over.settings(url) : ok(SETTINGS);
    if (url.startsWith('/api/payers')) return over.payers ? over.payers(url) : ok([PAYER]);
    if (url.startsWith('/api/properties/search')) {
      return over.properties ? over.properties(url) : ok([SITE]);
    }
    throw new Error(`test wire has no handler for GET ${url}`);
  });
};

const renderAt = () => render(
  <MemoryRouter initialEntries={['/bids']}>
    <Routes>
      <Route path="/bids" element={<BidsPage />} />
      <Route path="/bids/:id" element={<div>detail-marker-7</div>} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  jest.clearAllMocks();
  wire();
});

const wire_saw = (q: string) =>
  (api.get as jest.Mock).mock.calls.some((c) => String(c[0]).includes(encodeURIComponent(q)));

// Every MUI Popper in this file pays for itself in jsdom, and the two-payer
// dialog pays double; the sequences below are correct and simply slow here.
jest.setTimeout(30000);

describe('T-BIL-10: the bids desk', () => {
  it('transcribes the server’s money, and says which tax is still an estimate', async () => {
    renderAt();
    expect(await screen.findByText('Smith, Jane')).toBeInTheDocument();
    expect(screen.getByText(/\$1,266\.00 \(tax est\.\)/)).toBeInTheDocument();
    expect(screen.getByText(/Sales tax: 5\.5%/)).toBeInTheDocument();
  });

  it('an invoiced bid carries no estimate word — its tax was fixed at approval', async () => {
    wire({ bids: () => ok([{ ...SUMMARY, status: 'invoiced', tax_estimated: false }]) });
    renderAt();
    await screen.findByText('Smith, Jane');
    expect(screen.queryByText(/\(tax est\.\)/)).not.toBeInTheDocument();
  });

  it('the clerk types a percent and the wire carries a decimal', async () => {
    (api.patch as jest.Mock).mockImplementation(() => ok(SETTINGS));
    renderAt();
    // The rate text first: the settings load fills this field asynchronously
    // and typing before it lands races the effect (the field is controlled).
    await screen.findByText(/Sales tax: 5\.5%/);
    const field = screen.getByLabelText('sales tax percent');
    fireEvent.change(field, { target: { value: '5.5' } });
    await userEvent.click(screen.getByRole('button', { name: 'save sales tax' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith(
      '/api/settings/sales-tax', { sales_tax_rate: '0.0550' }, expect.anything(),
    ));
  });

  it('a 550% rate never reaches the wire — the field refuses it', async () => {
    renderAt();
    await screen.findByText(/Sales tax: 5\.5%/);
    const field = screen.getByLabelText('sales tax percent');
    fireEvent.change(field, { target: { value: '550' } });
    await userEvent.click(screen.getByRole('button', { name: 'save sales tax' }));
    expect(await screen.findByText(/percent below 100/)).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
  });
});

describe('T-BIL-10: opening a bid needs a payer, and a payer the search cannot find is one form away', () => {
  it('searches, picks, creates — and lands on the draft', async () => {
    (api.post as jest.Mock).mockImplementation(() => ok({ ...SUMMARY, lines: [] }));
    renderAt();
    await screen.findByText('Smith, Jane');
    await userEvent.click(screen.getByRole('button', { name: 'new bid' }));
    const payerBox = await screen.findByLabelText('payer search');
    await userEvent.click(payerBox);
    await userEvent.type(payerBox, 'Smith');
    await userEvent.click(await screen.findByRole('option', { name: /Smith, Jane/ }));
    await userEvent.click(screen.getByRole('button', { name: 'create bid' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/api/bids',
      expect.objectContaining({ payer_id: 9, property_id: null }),
      expect.anything(),
    ));
    expect(await screen.findByText('detail-marker-7')).toBeInTheDocument();
  });

  it('an empty search offers the form, not a shrug — and the new biller becomes the pick', async () => {
    wire({ payers: (url) => ok(url.includes('Whitfield') ? [] : [PAYER]) });
    (api.post as jest.Mock)
      .mockImplementationOnce(() => ok({ ...PAYER, id: 55, name: 'Whitfield, Ray' }))
      .mockImplementation(() => ok({ ...SUMMARY, lines: [] }));
    renderAt();
    await screen.findByText('Smith, Jane');
    await userEvent.click(screen.getByRole('button', { name: 'new bid' }));
    const payerBox = await screen.findByLabelText('payer search');
    await userEvent.click(payerBox);
    await userEvent.type(payerBox, 'Whitfield');
    await waitFor(() => expect(wire_saw('Whitfield')).toBe(true));
    await userEvent.click(await screen.findByRole('button', {
      name: 'Add “Whitfield” as a new biller',
    }));
    const org = screen.getByLabelText('Organization (optional)');
    await userEvent.type(org, 'Whitfield Holdings');
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create biller' }));
    // payerService.post is a two-argument call — the create path carries no
    // request config, and the assertion follows the wire, not the habit.
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/api/payers', expect.objectContaining({ org_name: 'Whitfield Holdings' }),
    ));
    // The pick followed the create without a re-search guessing which row is new.
    // toHaveValue is exact and will not unwrap an asymmetric matcher, so
    // the substring promise is made the plain way.
    expect((within(dialog).getByLabelText('payer search') as HTMLInputElement).value)
      .toMatch(/^Whitfield, Ray — 412 Township Rd/);
  });

  it('a bid can carry a site — the office search, not the driver’s', async () => {
    (api.post as jest.Mock).mockImplementation(() => ok({ ...SUMMARY, lines: [] }));
    renderAt();
    await screen.findByText('Smith, Jane');
    await userEvent.click(screen.getByRole('button', { name: 'new bid' }));
    const payerBox = await screen.findByLabelText('payer search');
    await userEvent.click(payerBox);
    await userEvent.type(payerBox, 'Smith');
    await userEvent.click(await screen.findByRole('option', { name: /Smith, Jane/ }));
    const siteBox = screen.getByLabelText('site search');
    await userEvent.click(siteBox);
    await userEvent.type(siteBox, 'Lot 7');
    await userEvent.click(await screen.findByRole('option', { name: 'Lot 7 CR-42' }));
    await userEvent.click(screen.getByRole('button', { name: 'create bid' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/api/bids', expect.objectContaining({ payer_id: 9, property_id: 98237 }),
      expect.anything(),
    ));
  });
});

describe('T-BIL-18: a site the search cannot find is one form away', () => {
  it('typing finds; typing never creates', async () => {
    renderAt();
    await screen.findByText('Smith, Jane');
    await userEvent.click(screen.getByRole('button', { name: 'new bid' }));
    const siteBox = await screen.findByLabelText('site search');
    await userEvent.click(siteBox);
    await userEvent.type(siteBox, 'Alberta Cove');
    await waitFor(() => expect(wire_saw('Alberta')).toBe(true));
    // SCH-12's bargain, charged again at the site door: a query is a query.
    expect((api.post as jest.Mock).mock.calls
      .some((c) => String(c[0]) === '/api/properties')).toBe(false);
  });

  it('the empty result opens the form, the form creates, and the created id is the pick', async () => {
    const NEW = { ...SITE, id: 515151, site_address: '1234 Alberta Cove',
      site_city: 'Oshkosh', site_state: 'WI', site_zip: '54904' };
    wire({ properties: (url) =>
      ok(url.includes('Alberta') ? [] : [SITE]) });
    (api.post as jest.Mock)
      .mockImplementationOnce(() => ok(NEW)) // POST /properties
      .mockImplementation(() => ok({ ...SUMMARY, lines: [] }));
    renderAt();
    await screen.findByText('Smith, Jane');
    await userEvent.click(screen.getByRole('button', { name: 'new bid' }));
    const payerBox = await screen.findByLabelText('payer search');
    await userEvent.click(payerBox);
    await userEvent.type(payerBox, 'Smith');
    await userEvent.click(await screen.findByRole('option', { name: /Smith, Jane/ }));
    const siteBox = screen.getByLabelText('site search');
    await userEvent.click(siteBox);
    await userEvent.type(siteBox, '1234 Alberta Cove');
    await userEvent.click(await screen.findByRole('button', {
      name: 'Add “1234 Alberta Cove” as a new site',
    }));
    // The address rode out of the search box into the form — the office does
    // not type the same string twice.
    expect(screen.getByLabelText('Site address')).toHaveValue('1234 Alberta Cove');
    await userEvent.type(screen.getByLabelText('City'), 'Oshkosh');
    await userEvent.type(screen.getByLabelText('State'), 'WI');
    await userEvent.type(screen.getByLabelText('ZIP'), '54904');
    await userEvent.click(screen.getByRole('button', { name: 'create site' }));
    // No legacy customer number is a field here: a site being bid for is not
    // in 61 years of ledgers, and inventing one is inventing history.
    expect(screen.queryByLabelText(/Legacy customer number/)).not.toBeInTheDocument();
    await waitFor(() => expect((api.post as jest.Mock).mock.calls.some(
      (c) => c[0] === '/api/properties'
        && (c[1] as any).site_address === '1234 Alberta Cove')));
    await userEvent.click(screen.getByRole('button', { name: 'create bid' }));
    await waitFor(() => expect((api.post as jest.Mock).mock.calls.some(
      (c) => c[0] === '/api/bids' && (c[1] as any).property_id === 515151)));
    expect(await screen.findByText('detail-marker-7')).toBeInTheDocument();
  });

  it('an empty address keeps the create button dead — a site a crew cannot find is not a site', async () => {
    wire({ properties: () => ok([]) });
    renderAt();
    await screen.findByText('Smith, Jane');
    await userEvent.click(screen.getByRole('button', { name: 'new bid' }));
    const siteBox = await screen.findByLabelText('site search');
    await userEvent.click(siteBox);
    await userEvent.type(siteBox, 'Nowhere Lane');
    // seed the form empty by hand: clear what the door prefills
    await userEvent.click(await screen.findByRole('button', {
      name: 'Add “Nowhere Lane” as a new site',
    }));
    const addr = screen.getByLabelText('Site address');
    await userEvent.clear(addr);
    expect(screen.getByRole('button', { name: 'create site' })).toBeDisabled();
    await userEvent.type(addr, '5 Nowhere Lane');
    expect(screen.getByRole('button', { name: 'create site' })).toBeEnabled();
  });
});

describe('T-BIL-10: the desk refusing, in the server’s words', () => {
  it('a dead endpoint says so and lists nothing invented', async () => {
    wire({ bids: () => refusal('No bid has id 7') });
    renderAt();
    expect(await screen.findByText('No bid has id 7')).toBeInTheDocument();
    expect(screen.queryByText('$1,266.00')).not.toBeInTheDocument();
  });
});
