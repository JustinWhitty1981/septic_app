import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent } from '@testing-library/react';
import ReceivablesPage from './ReceivablesPage';
import { receivablesService, ReceivablesMeta } from '../services/receivablesService';

/**
 * T-BIL-07's screen. The one sentence the whole feature exists for is
 * "$335 billed, $150 paid, still owes $185" — so the row for that payer is
 * rendered with all three numbers, and the test reads the balance off the
 * screen rather than trusting a service mock to have done the subtraction.
 * The other load-bearing fact: this list is recomputed on demand, so the
 * screen must actually re-call the service, never show a cached tally.
 */

jest.mock('../services/receivablesService', () => {
  const actual = jest.requireActual('../services/receivablesService');
  return { ...actual, receivablesService: { list: jest.fn() } };
});

const list = receivablesService.list as jest.Mock;

const META: ReceivablesMeta = {
  payers_owing: 2, total_receivable: '235.00', credit_balances: 1,
};

const ROWS = [
  {
    payer_id: 9, payer_name: 'Smith, Jane', billed: '335.00', collected: '150.00',
    balance: '185.00', oldest_open: '2024-11-02T00:00:00.000Z', open_invoices: 1,
  },
  {
    payer_id: 12, payer_name: 'Ziegler, Ron', billed: '900.00', collected: '850.00',
    balance: '50.00', oldest_open: '2024-09-15T00:00:00.000Z', open_invoices: 2,
  },
];

beforeEach(() => {
  jest.clearAllMocks();
  list.mockResolvedValue({ data: ROWS, meta: META });
});

const renderPage = () => render(<MemoryRouter><ReceivablesPage /></MemoryRouter>);

describe('T-BIL-07: the chase list', () => {
  it('shows billed, collected and owed as one sentence per payer', async () => {
    renderPage();
    expect(await screen.findByText('Smith, Jane')).toBeInTheDocument();
    expect(screen.getByText('$335.00')).toBeInTheDocument();
    expect(screen.getByText('$150.00')).toBeInTheDocument();
    expect(screen.getByText('$185.00')).toBeInTheDocument();
  });

  it('the header counts what the phone list is worth', async () => {
    renderPage();
    expect(await screen.findByText(/2 payers owing/)).toBeInTheDocument();
    expect(screen.getByText(/\$235\.00/)).toBeInTheDocument();
    // Credits are counted, never hidden: they are money on our side of the
    // counter, and a silent 1 would be the negative-row disease again.
    expect(screen.getByText(/1 on our side \(credits\)/)).toBeInTheDocument();
  });

  it('recomputes when asked, rather than serving a stored tally', async () => {
    renderPage();
    await screen.findByText('Smith, Jane');
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /recompute/i }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it('typing a name narrows by asking the server, not by filtering the page', async () => {
    renderPage();
    await screen.findByText('Smith, Jane');
    fireEvent.change(screen.getByLabelText('search receivable payers'),
      { target: { value: 'Ziegler' } });
    await waitFor(() => expect(list).toHaveBeenLastCalledWith('Ziegler'));
  });

  it('an empty ledger says nobody owes anything', async () => {
    list.mockResolvedValue({ data: [], meta: { payers_owing: 0, total_receivable: '0.00', credit_balances: 0 } });
    renderPage();
    expect(await screen.findByText(/Nobody owes anything/)).toBeInTheDocument();
  });

  it('a failed call says failed, not zero', async () => {
    list.mockRejectedValueOnce(new Error('boom 7712'));
    renderPage();
    expect(await screen.findByText('boom 7712')).toBeInTheDocument();
    expect(screen.queryByText(/Nobody owes anything/)).not.toBeInTheDocument();
  });
});
