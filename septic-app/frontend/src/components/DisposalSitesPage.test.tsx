import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DisposalSitesPage from './DisposalSitesPage';
import { disposalSiteService, DisposalSiteRow } from '../services/disposalSiteService';

/**
 * T-LED-07's screen. The behaviour worth asserting is not that a table
 * renders — it is that the two ledger truths survive contact with the mouse:
 * the count the server computed is shown before anything is deleted, a
 * deletion needs two deliberate clicks, and a refusal arrives in the
 * server's own words (it already names the site and the count; paraphrasing
 * would only make it vaguer).
 */

jest.mock('../services/disposalSiteService', () => {
  const actual = jest.requireActual('../services/disposalSiteService');
  return {
    ...actual,
    disposalSiteService: {
      list: jest.fn(), create: jest.fn(), update: jest.fn(),
      remove: jest.fn(), setDefault: jest.fn(),
    },
  };
});

const list = disposalSiteService.list as jest.Mock;
const create = disposalSiteService.create as jest.Mock;
const remove = disposalSiteService.remove as jest.Mock;
const setDefault = disposalSiteService.setDefault as jest.Mock;

const zss: DisposalSiteRow = {
  id: 1, name: 'ZSS', dnr_permit_no: '12345-6', accepts_slurry: true,
  permitted: true, events_using: 910, is_default: true,
};
const land: DisposalSiteRow = {
  id: 2, name: 'Land', dnr_permit_no: null, accepts_slurry: null,
  permitted: false, events_using: 0, is_default: false,
};

const apiError = (message: string) => ({ response: { data: { error: message } } });

beforeEach(() => {
  jest.clearAllMocks();
  list.mockResolvedValue([zss, land]);
  create.mockResolvedValue({ ...land, id: 3, name: 'New Site' });
  remove.mockResolvedValue(undefined);
  setDefault.mockResolvedValue(undefined);
});

describe('T-LED-07: the disposal sites screen', () => {
  it('shows what the ledger names each site with, and which one is the default', async () => {
    render(<DisposalSitesPage />);
    expect(await screen.findByText('ZSS')).toBeInTheDocument();
    expect(screen.getByText('910')).toBeInTheDocument();
    expect(screen.getByText('company default')).toBeInTheDocument();
    expect(screen.getByText('unused')).toBeInTheDocument();
    // Nobody may "Make default" the row that already is — one answer, one row.
    expect(screen.getAllByRole('button', { name: 'Make default' })).toHaveLength(1);
  });

  it('adds a site through the server and shows the reload', async () => {
    list
      .mockResolvedValueOnce([zss, land])
      .mockResolvedValueOnce([zss, land, { ...land, id: 3, name: 'New Site' }]);
    render(<DisposalSitesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add site' }));
    await userEvent.type(screen.getByLabelText('Name'), 'New Site');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(screen.getByText('New Site')).toBeInTheDocument();
  });

  it('a duplicate name bounces back with the server’s sentence, where it was typed', async () => {
    create.mockRejectedValueOnce(apiError('A disposal site named "ZSS" already exists.'));
    render(<DisposalSitesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add site' }));
    await userEvent.type(screen.getByLabelText('Name'), 'ZSS');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('A disposal site named "ZSS" already exists.')).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(1); // a refused create does not reload the list
  });

  it('deleting takes two deliberate clicks', async () => {
    render(<DisposalSitesPage />);
    // Scoped to Land's row: every row has a Delete button, and a test that
    // grabs "the" one is really grabbing whichever MUI emitted first.
    const landRow = within((await screen.findByText('Land')).closest('tr')!);
    await userEvent.click(landRow.getByRole('button', { name: 'Delete' }));
    expect(remove).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(2));
  });

  it('a refusal by the ledger keeps the server’s count on screen', async () => {
    remove.mockRejectedValueOnce(apiError(
      'The ledger names "Land" on 42 events. History cannot be deleted — rename the site instead.',
    ));
    render(<DisposalSitesPage />);
    const landRow = within((await screen.findByText('Land')).closest('tr')!);
    await userEvent.click(landRow.getByRole('button', { name: 'Delete' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
    expect(await screen.findByText(/ledger names "Land" on 42 events/)).toBeInTheDocument();
  });

  it('moving the company default is a call and a re-read, never a local guess', async () => {
    list
      .mockResolvedValueOnce([zss, land])
      .mockResolvedValueOnce([{ ...zss, is_default: false }, { ...land, is_default: true }]);
    render(<DisposalSitesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Make default' }));
    await waitFor(() => expect(setDefault).toHaveBeenCalledWith(2));
    expect(await screen.findByText('company default')).toBeInTheDocument();
  });
});
