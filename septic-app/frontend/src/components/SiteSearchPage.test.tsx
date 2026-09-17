import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import SiteSearchPage from './SiteSearchPage';
import { propertyService } from '../services/propertyService';

/**
 * T-SCH-11's front door. The screen-level promise is small and specific:
 * office roles get the door, drivers do not (the menu hides a screen; only
 * the server's 403 keeps it — this asserts the hiding half), and the server's
 * refusal sentences about the typed values (a used cust number, a field that
 * is not ours to set) reappear in the dialog they were earned in.
 */

jest.mock('../services/propertyService', () => {
  const actual = jest.requireActual('../services/propertyService');
  return {
    ...actual,
    propertyService: { search: jest.fn(), create: jest.fn(), update: jest.fn(), detail: jest.fn() },
  };
});

const create = propertyService.create as jest.Mock;

const officeUser = {
  id: 5, first_name: 'Od', last_name: 'Fice', email: 'o@x.test', role: 'office',
};
const driverUser = { ...officeUser, id: 6, role: 'driver' };

const renderPage = () => render(<MemoryRouter><SiteSearchPage /></MemoryRouter>);

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.setItem('jwt_user', JSON.stringify(officeUser));
});
afterEach(() => localStorage.clear());

describe('T-SCH-11: adding a site from the search screen', () => {
  it('the office gets the door', async () => {
    renderPage();
    expect(await screen.findByRole('button', { name: 'Add a site' })).toBeInTheDocument();
  });

  it('a driver does not even see the door', async () => {
    localStorage.setItem('jwt_user', JSON.stringify(driverUser));
    renderPage();
    await screen.findByText('Find a site'); // the page rendered...
    expect(screen.queryByRole('button', { name: 'Add a site' })).not.toBeInTheDocument();
    // ...and the door is absent anyway. The server's 403 is the real gate;
    // this half only keeps it out of the way.
  });

  it('creates through the server with trimmed, typed-as-number values', async () => {
    // ~40 userEvent keystrokes through a MUI dialog, and jsdom charges full
    // price for every one; under a loaded runner this crossed 5s and reddened
    // for the clock, not the contract (measured, not assumed).
    jest.setTimeout(20000);
    create.mockResolvedValue({ id: 4242 });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Add a site' }));
    await userEvent.type(screen.getByLabelText(/Site address/), '  7 New Cust Lane  ');
    await userEvent.type(screen.getByLabelText('City'), 'Newville');
    await userEvent.type(screen.getByLabelText('Legacy customer number'), '4101');
    await userEvent.click(screen.getByRole('button', { name: 'Add site' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const body = create.mock.calls[0][0];
    expect(body.site_address).toBe('7 New Cust Lane');
    expect(body.legacy_cust_number).toBe(4101); // the radio number, not a string
    expect(body.service_interval_days).toBe(1095);
  });

  it('a used customer number bounces back with the number named, inside the dialog', async () => {
    create.mockRejectedValueOnce({
      response: { data: { message: 'Customer number 3494 is already used by another site.' } },
    });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Add a site' }));
    await userEvent.type(screen.getByLabelText(/Site address/), '7 New Cust Lane');
    await userEvent.type(screen.getByLabelText('Legacy customer number'), '3494');
    await userEvent.click(screen.getByRole('button', { name: 'Add site' }));
    expect(
      await screen.findByText('Customer number 3494 is already used by another site.'),
    ).toBeInTheDocument();
  });

  it('will not file a site with no address', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Add a site' }));
    expect(screen.getByRole('button', { name: 'Add site' })).toBeDisabled();
    expect(create).not.toHaveBeenCalled();
  });
});
