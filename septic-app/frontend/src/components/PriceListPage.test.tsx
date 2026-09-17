import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PriceListPage from './PriceListPage';
import { bidService, BidItem } from '../services/bidService';

/**
 * T-BIL-17's screen. The spine is what this page refuses to be: it does not
 * compute money, its ordering is the reader's click and never a hidden
 * opinion (the whole list arrives in one request, so the sort can be honest
 * about every row), and it
 * has no delete button — the third of those is asserted outright, because
 * "we never delete price history" is only a rule while the UI cannot
 * violate it. Retirement is a PATCH with its target named by id; the
 * mutation that would betray it (shipping a DELETE to a route that does not
 * exist) reddens the retire test and nothing else can catch it.
 */

jest.mock('../services/bidService', () => {
  const actual = jest.requireActual('../services/bidService');
  return {
    ...actual,
    bidService: {
      bidItems: jest.fn(), createBidItem: jest.fn(), updateBidItem: jest.fn(),
    },
  };
});

const bidItems = bidService.bidItems as jest.Mock;
const createBidItem = bidService.createBidItem as jest.Mock;
const updateBidItem = bidService.updateBidItem as jest.Mock;

const labor: BidItem = { id: 1, name: 'Licensed plumber labor', unit: 'hour',
  unit_price: '300.00', is_active: true, created_at: '2024-11-01' };
const pipe: BidItem = { id: 2, name: 'Schedule 40 PVC pipe', unit: 'feet',
  unit_price: '3.00', is_active: true, created_at: '2024-11-01' };
const trench: BidItem = { id: 3, name: 'Trench digging (2022 rate)', unit: 'hour',
  unit_price: '120.00', is_active: false, created_at: '2022-03-01' };

const apiError = (message: string) => ({ response: { data: { error: message } } });

beforeEach(() => {
  jest.clearAllMocks();
  bidItems.mockResolvedValue({ data: [labor, pipe] });
  createBidItem.mockResolvedValue({ data: { ...pipe, id: 9 } });
  updateBidItem.mockResolvedValue({ data: labor });
});

describe('T-BIL-17: the price list, managed', () => {
  it('shows the server’s money and each row’s standing', async () => {
    render(<PriceListPage />);
    expect(await screen.findByText('Licensed plumber labor')).toBeInTheDocument();
    expect(screen.getByText('$300.00')).toBeInTheDocument();
    expect(screen.getByText('$3.00')).toBeInTheDocument();
    expect(screen.getAllByText('active')).toHaveLength(2);
    // Retired rows are hidden by default — the picker's world is active-only.
    expect(screen.queryByText('Trench digging (2022 rate)')).not.toBeInTheDocument();
  });

  it('adds an item as typed strings — the float never walks back in', async () => {
    bidItems
      .mockResolvedValueOnce({ data: [labor, pipe] })
      .mockResolvedValue({ data: [labor, pipe, { ...pipe, id: 9, name: 'Rock removal' }] });
    render(<PriceListPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'add item' }));
    await userEvent.type(screen.getByLabelText('new item name'), '  Rock removal  ');
    await userEvent.type(screen.getByLabelText('new item unit'), 'load');
    await userEvent.type(screen.getByLabelText('new item price'), '300.5');
    await userEvent.click(screen.getByRole('button', { name: 'save new item' }));
    await waitFor(() => expect(createBidItem).toHaveBeenCalledWith({
      name: 'Rock removal', unit: 'load', unit_price: '300.5',
    }));
    expect(await screen.findByText('Rock removal')).toBeInTheDocument();
    expect(bidItems).toHaveBeenCalledTimes(2); // a re-read, not a local append
  });

  it('a refusal arrives in the server’s sentence and nothing reloads', async () => {
    createBidItem.mockRejectedValueOnce(
      apiError('unit_price must be a number at least 0 — nothing was added'));
    render(<PriceListPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'add item' }));
    await userEvent.type(screen.getByLabelText('new item name'), 'Refund line');
    await userEvent.type(screen.getByLabelText('new item unit'), 'each');
    await userEvent.type(screen.getByLabelText('new item price'), '-10');
    await userEvent.click(screen.getByRole('button', { name: 'save new item' }));
    expect(await screen.findByText(
      'unit_price must be a number at least 0 — nothing was added')).toBeInTheDocument();
    expect(bidItems).toHaveBeenCalledTimes(1);
  });

  it('a price edits in place — the list is a current reference, not history', async () => {
    bidItems
      .mockResolvedValueOnce({ data: [labor, pipe] })
      .mockResolvedValue({ data: [{ ...labor, unit_price: '325.00' }, pipe] });
    render(<PriceListPage />);
    const row = within((await screen.findByText('Licensed plumber labor')).closest('tr')!);
    await userEvent.click(row.getByRole('button', { name: 'edit item 1' }));
    const price = row.getByLabelText('item price 1');
    await userEvent.clear(price);
    await userEvent.type(price, '325');
    await userEvent.click(row.getByRole('button', { name: 'save item 1' }));
    await waitFor(() => expect(updateBidItem).toHaveBeenCalledWith(1,
      expect.objectContaining({ unit_price: '325' })));
    expect(await screen.findByText('$325.00')).toBeInTheDocument();
  });

  it('retiring is a PATCH naming the row — and there is no delete anywhere on the page', async () => {
    bidItems
      .mockResolvedValueOnce({ data: [labor, pipe] })
      .mockResolvedValue({ data: [{ ...labor, is_active: false }, pipe] });
    render(<PriceListPage />);
    const row = within((await screen.findByText('Licensed plumber labor')).closest('tr')!);
    await userEvent.click(row.getByRole('button', { name: 'retire item 1' }));
    await waitFor(() => expect(updateBidItem)
      .toHaveBeenCalledWith(1, { is_active: false }));
    expect(await screen.findByText('retired')).toBeInTheDocument();
    // The affordance that would betray the rule does not exist, asserted.
    expect(screen.queryAllByRole('button', { name: /delete|remove/i })).toHaveLength(0);
  });

  it('retired rows show on request, and restore is the same door back', async () => {
    bidItems
      .mockResolvedValueOnce({ data: [labor, pipe] })
      .mockResolvedValueOnce({ data: [labor, pipe, trench] })
      .mockResolvedValue({ data: [labor, pipe, { ...trench, is_active: true }] });
    render(<PriceListPage />);
    await userEvent.click(await screen.findByLabelText('show retired'));
    expect(await screen.findByText('Trench digging (2022 rate)')).toBeInTheDocument();
    expect(bidItems).toHaveBeenLastCalledWith(true);
    const row = within(screen.getByText('Trench digging (2022 rate)').closest('tr')!);
    await userEvent.click(row.getByRole('button', { name: 'restore item 3' }));
    await waitFor(() => expect(updateBidItem)
      .toHaveBeenCalledWith(3, { is_active: true }));
  });
});

describe('the list sorts by the column the reader clicked', () => {
  it('price sorts the whole list, not the accident of insertion', async () => {
    bidItems.mockResolvedValue({ data: [labor, pipe] });
    render(<PriceListPage />);
    await screen.findByText('Licensed plumber labor');
    const names = () => Array.from(
      document.querySelectorAll('tbody tr td:first-child'),
    ).map((td) => td.textContent);
    expect(names()).toEqual(['Licensed plumber labor', 'Schedule 40 PVC pipe']);

    await userEvent.click(screen.getByRole('button', { name: /price/i }));
    expect(names()).toEqual(['Schedule 40 PVC pipe', 'Licensed plumber labor']);

    await userEvent.click(screen.getByRole('button', { name: /price/i }));
    expect(names()).toEqual(['Licensed plumber labor', 'Schedule 40 PVC pipe']);
  });
});
