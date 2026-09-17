import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import UsersPage from './UsersPage';
import { userService, AccountRow } from '../services/userService';

/**
 * AUT-12's screen. The behaviour worth asserting is not that a table renders —
 * it is the promises the endpoints make that a human needs to see kept:
 * deactivating another account is offered, deactivating yourself is not, the
 * token epoch (the receipt that AUT-11's revocation fired) is visible, and a
 * forgotten password now has an answer on this screen — reset — with the same
 * password-manager guard the create form had to learn the hard way.
 */

jest.mock('../services/userService', () => {
  const actual = jest.requireActual('../services/userService');
  return {
    ...actual,
    userService: {
      list: jest.fn(), create: jest.fn(), setActive: jest.fn(),
      resetPassword: jest.fn(),
    },
  };
});

const list = userService.list as jest.Mock;
const create = userService.create as jest.Mock;
const setActive = userService.setActive as jest.Mock;
const resetPassword = userService.resetPassword as jest.Mock;

const me: AccountRow = {
  id: 1, email: 'admin@example.test', first_name: 'Ada', last_name: 'Admin',
  role: 'admin', is_active: true, last_login_at: null, created_at: '2026-01-01',
  tokens_epoch: 0,
};
const driver: AccountRow = {
  ...me, id: 2, email: 'dana@example.test', first_name: 'Dana', last_name: 'Reyes',
  role: 'driver', tokens_epoch: 3,
};

const renderPage = () => render(<MemoryRouter><UsersPage /></MemoryRouter>);

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.setItem('jwt_user', JSON.stringify(me));
  list.mockResolvedValue([me, driver]);
  setActive.mockResolvedValue(undefined);
  create.mockResolvedValue({ ...me, id: 9 });
  resetPassword.mockResolvedValue({ ...driver });
});
afterEach(() => localStorage.clear());

describe('T-AUT-12: the accounts screen', () => {
  it('lists accounts with the epoch that proves revocation moved', async () => {
    renderPage();
    expect(await screen.findByText('dana@example.test')).toBeInTheDocument();
    // Dana's epoch of 3 means three forced logouts have happened on her account.
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('never offers to disable the account you are logged in as', async () => {
    renderPage();
    await screen.findByText('dana@example.test');
    // Exactly one Disable button exists — Dana's. Mine is hidden, not disabled:
    // the server refuses self-deactivation, and the screen agrees with it.
    expect(screen.getAllByRole('button', { name: 'Disable' })).toHaveLength(1);
  });

  it('disabling is one click and reloads, so the epoch change is visible', async () => {
    list.mockResolvedValueOnce([me, driver])
      .mockResolvedValueOnce([me, { ...driver, is_active: false, tokens_epoch: 4 }]);
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(setActive).toHaveBeenCalledWith(2, false));
    expect(await screen.findByText('disabled')).toBeInTheDocument();
    // The epoch moved on the way back in: 3 -> 4. That is AUT-11's receipt.
    expect(await screen.findByText('4')).toBeInTheDocument();
  });

  it('creates an account and surfaces the password policy in the server’s words', async () => {
    create.mockRejectedValueOnce({
      response: { data: { error: 'Password does not meet requirements' } },
    });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /New account/i }));
    await userEvent.type(screen.getByLabelText('First name'), 'Nia');
    await userEvent.type(screen.getByLabelText('Last name'), 'Novak');
    await userEvent.type(screen.getByLabelText('Email'), 'nia@example.test');
    await userEvent.type(screen.getByLabelText('Password'), 'short');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('Password does not meet requirements')).toBeInTheDocument();
    expect(create).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1); // failed create does not reload the list
  });

  it('the password field tells the password manager to stay out', async () => {
    // The trap this account system shipped with: an unmarked type="password"
    // input is a *login* field to every password manager, and the manager
    // autocompletes its own guess over what the admin typed — the account is
    // created with a password nobody chose. new-password is the standard
    // "this is a credential being born" signal, and the toggle is the human
    // check that no manager can override. The reset dialog carries the same
    // guard: a reset autofilled by a manager lands the admin's own password
    // on someone else's account, which is the shared-password corpus again
    // with extra steps.
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /New account/i }));
    const input = await screen.findByLabelText('Password');
    expect(input).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getByLabelText('toggle password visibility')).toBeInTheDocument();
  });
});

// The forgotten-password path, which used to end at a keyboard with
// seed-user.ts. The claims: every row offers the reset (yours included —
// changing your own password is legitimate), the server's refusal words
// arrive untampered, and a successful reset reloads the list so the moved
// epoch is visible the same way a deactivation's is.
describe('T-AUT-12: password reset on the accounts screen', () => {
  it('offers a reset on every row, including your own', async () => {
    renderPage();
    await screen.findByText('dana@example.test');
    expect(screen.getByRole('button', { name: 'Reset password for dana@example.test' }))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset password for admin@example.test' }))
      .toBeInTheDocument();
  });

  it('resets another account and reloads, so the epoch change is visible', async () => {
    list.mockResolvedValueOnce([me, driver])
      .mockResolvedValueOnce([me, { ...driver, tokens_epoch: 4 }]);
    renderPage();
    await userEvent.click(await screen.findByRole('button',
      { name: 'Reset password for dana@example.test' }));
    await userEvent.type(await screen.findByLabelText('New password'), 'Rotat3d-Passw0rd!');
    await userEvent.click(screen.getByRole('button', { name: 'Reset password' }));
    await waitFor(() => expect(resetPassword).toHaveBeenCalledWith(2, 'Rotat3d-Passw0rd!'));
    expect(await screen.findByText('4')).toBeInTheDocument();
  });

  it('reseting your own account ends this session — the epoch moved under it', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button',
      { name: 'Reset password for admin@example.test' }));
    // The dialog warns before the click, not after: an admin who changes their
    // own password is about to be signed out of this device.
    expect(await screen.findByText(/including this screen/i)).toBeInTheDocument();
    await userEvent.type(await screen.findByLabelText('New password'), 'Rotat3d-Passw0rd!');
    await userEvent.click(screen.getByRole('button', { name: 'Reset password' }));
    await waitFor(() => expect(resetPassword).toHaveBeenCalledWith(1, 'Rotat3d-Passw0rd!'));
    expect(localStorage.getItem('jwt_user')).toBeNull();
  });

  it('a refused reset names the policy in the server’s words and never reloads', async () => {
    resetPassword.mockRejectedValueOnce({
      response: { data: { error: 'Password does not meet requirements' } },
    });
    renderPage();
    await userEvent.click(await screen.findByRole('button',
      { name: 'Reset password for dana@example.test' }));
    await userEvent.type(await screen.findByLabelText('New password'), 'weak');
    await userEvent.click(screen.getByRole('button', { name: 'Reset password' }));
    expect(await screen.findByText('Password does not meet requirements')).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(1); // a refused reset changed nothing to show
  });

  it('the reset field tells the password manager to stay out', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button',
      { name: 'Reset password for dana@example.test' }));
    const input = await screen.findByLabelText('New password');
    expect(input).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getByLabelText('toggle password visibility')).toBeInTheDocument();
  });
});
