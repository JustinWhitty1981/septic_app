import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import PropertyDetailPage from './PropertyDetailPage';
import { propertyService, PropertyDetail } from '../services/propertyService';
import { ownerService, payerService } from '../services/payerService';
import { routeService } from '../services/routeService';
import { ledgerService } from '../services/ledgerService';

/**
 * T-SCH-11's edit half, and the reason this file exists: the first shipped
 * version of the save handler did `setRow(response)`. The PATCH answered 200
 * with the *row*, the page re-rendered the assembled *detail*, and
 * `row.tanks.length` threw — a saved edit followed by an uncaught exception,
 * the worst failure mode a write can have because the data really did save
 * and the screen really did die. A test on this screen is really a test on
 * the response-shape contract: after a save, the detail must be re-read.
 */

jest.mock('../services/propertyService', () => {
  const actual = jest.requireActual('../services/propertyService');
  return {
    ...actual,
    propertyService: { detail: jest.fn(), update: jest.fn(), create: jest.fn(), search: jest.fn() },
  };
});
jest.mock('../services/payerService', () => ({
  ownerService: { list: jest.fn(), assign: jest.fn() },
  payerService: { search: jest.fn(), create: jest.fn() },
}));
jest.mock('../services/routeService', () => ({
  routeService: { drivers: jest.fn(), addStopForDay: jest.fn(), forDate: jest.fn() },
}));
jest.mock('../services/ledgerService', () => {
  const actual = jest.requireActual('../services/ledgerService');
  return { ...actual, ledgerService: { lookups: jest.fn(), correct: jest.fn(), record: jest.fn() } };
});

const detail = propertyService.detail as jest.Mock;
const update = propertyService.update as jest.Mock;
const ownersList = ownerService.list as jest.Mock;
const assign = ownerService.assign as jest.Mock;
const payerSearch = payerService.search as jest.Mock;
const payerCreate = payerService.create as jest.Mock;
const schedDrivers = routeService.drivers as jest.Mock;
const addStopForDay = routeService.addStopForDay as jest.Mock;
const lookups = ledgerService.lookups as jest.Mock;
const recordEvent = ledgerService.record as jest.Mock;

const row = (over: Partial<PropertyDetail> = {}): PropertyDetail => ({
  id: 98237, legacy_cust_number: null, payer_label: 'Justin Whitty',
  site_address: '3489 Brooks Rd', site_city: 'Oshkosh', site_state: 'WI', site_zip: '54904',
  county_id: null, status: 'active', permit_number: null, service_interval_days: 1095,
  last_service_date: null, next_service_due: null, town: null, county_raw: null,
  county_name: null, system_type_name: null, tank_location_note: 'Test',
  jobsite_location_note: 'This guy is a jerk', pump_style_note: "It's a pump",
  chamber_pump_note: "It's a chamber", system_condition_note: 'In good shape',
  reminder_opt_out: false, legacy_memo: null,
  tanks: [], owners: [], recent_events: [], ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.setItem('jwt_user', JSON.stringify({
    id: 1, first_name: 'Od', last_name: 'Fice', email: 'o@x.test', role: 'office',
  }));
  // The exact two-call sequence of a save: detail #1 renders the page, the
  // PATCH resolves with a bare row (no tanks/owners/events — that is the
  // server's real shape), and detail #2 is what must land in the page state.
  detail.mockResolvedValue({ data: row() });
  update.mockResolvedValue(row({ site_city: 'After' }));
  ownersList.mockResolvedValue([]);
  assign.mockResolvedValue({ ownership: { id: 8 }, closed_ownership_id: 7 });
  payerSearch.mockResolvedValue([
    { id: 99, name: 'New Owner', mailing_address: null, mailing_city: null,
      mailing_state: null, mailing_zip: null, legacy_billing_no: null, sites_owned: 2 },
  ]);
  schedDrivers.mockResolvedValue({
    data: [{ id: 12, first_name: 'Marco', last_name: 'Rivera', role: 'driver' }],
  });
  addStopForDay.mockResolvedValue({
    data: { id: 5001, sequence_no: 1, status: 'pending', route_id: 4101,
            route_date: '2024-12-05', driver_id: 12, route_created: true },
  });
  payerCreate.mockResolvedValue({
    id: 501, name: 'Justin Whitty', mailing_address: '3489 Brooks Rd', mailing_city: 'Oshkosh',
    mailing_state: 'WI', mailing_zip: '54904', legacy_billing_no: null, sites_owned: 0,
  });
});
afterEach(() => localStorage.clear());

// The page reads :id off the route — render it the way App mounts it, or the
// first thing it does is refuse "That is not a site number." The /routes
// probe exists so a navigation from the schedule dialog lands somewhere we
// can read the query the handoff carried.
const BoardProbe = () => {
  const loc = useLocation();
  const note = (loc.state as { addedNote?: string } | null)?.addedNote ?? '';
  return <div data-testid="board-landing">{loc.pathname}{loc.search} {note}</div>;
};
const renderPage = (state?: unknown) => render(
  <MemoryRouter initialEntries={[{ pathname: '/properties/98237', state }]}>
    <Routes>
      <Route path="/properties/:id" element={<PropertyDetailPage />} />
      <Route path="/routes" element={<BoardProbe />} />
      <Route path="/due-queue" element={<BoardProbe />} />
    </Routes>
  </MemoryRouter>,
);

describe('T-SCH-11: editing a site on the detail page', () => {
  it('renders the page it was given', async () => {
    renderPage();
    expect(await screen.findByText('3489 Brooks Rd')).toBeInTheDocument();
  });

  it('a successful save re-reads the detail — it does not render the row the PATCH returned', async () => {
    detail
      .mockResolvedValueOnce({ data: row() })
      .mockResolvedValueOnce({ data: row({ site_city: 'After' }) });
    renderPage();
    await screen.findByText('3489 Brooks Rd');
    await userEvent.click(await screen.findByRole('button', { name: 'edit site' }));
    await userEvent.clear(screen.getByLabelText('City'));
    await userEvent.type(screen.getByLabelText('City'), 'After');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][1]).toMatchObject({ site_city: 'After' });
    // The crash this pins: setRow(updateResponse) would render a row without
    // `tanks` and die. The page surviving to the new city proves the re-read
    // happened and the full detail is what is on screen.
    await waitFor(() => expect(detail).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/^After WI 54904/)).toBeInTheDocument();
  });

  it('a refused edit says why, in the dialog, and changes nothing on the page', async () => {
    update.mockRejectedValueOnce({
      response: { data: { message: 'status must be one of: active, inactive, sealed, unknown' } },
    });
    renderPage();
    await screen.findByText('3489 Brooks Rd');
    await userEvent.click(await screen.findByRole('button', { name: 'edit site' }));
    await userEvent.click(await screen.getByRole('button', { name: 'Save changes' }));
    expect(
      await screen.findByText('status must be one of: active, inactive, sealed, unknown'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Oshkosh WI 54904/)).toBeInTheDocument(); // page untouched
    expect(detail).toHaveBeenCalledTimes(1); // no reload after a refusal
  });
});

describe('T-SCH-06: the billed-to half of the page', () => {
  const withOwner = row({
    owners: [{
      id: 7, payer_id: 12, is_primary: true, source: 'legacy',
      payer_name: 'Zommers, Ed', phone: null, email: null,
      ownership_start: '1994-05-20',
    }],
  });

  it('records a change of bill-to end to end', async () => {
    detail
      .mockResolvedValueOnce({ data: withOwner })
      .mockResolvedValueOnce({
        data: { ...withOwner, owners: [{ ...withOwner.owners[0], id: 8, payer_id: 99,
          payer_name: 'New Owner', source: 'app', ownership_start: '2024-12-02' }] },
      });
    renderPage();
    await screen.findByText('3489 Brooks Rd');
    await userEvent.click(await screen.findByRole('button', { name: 'reassign owner' }));
    const box = await screen.findByLabelText('payer search');
    await userEvent.type(box, 'new');
    await waitFor(() => expect(payerService.search).toHaveBeenCalled());
    await userEvent.click(await screen.findByRole('option', { name: /New Owner/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Record change' }));
    await waitFor(() => expect(ownerService.assign).toHaveBeenCalledWith(98237, 99));
    expect(await screen.findByText('New Owner')).toBeInTheDocument();
  });

  it('a site with no owner is a door, not a dead end — the first owner is recordable', async () => {
    // The warning alone was the whole UI for this state: a site added through
    // the new "add a site" flow existed, was billable by nobody, and offered
    // no button to change that. The dialog is the same event as a reassign —
    // close-nothing, open-one — so the flow must work from the empty state.
    detail
      .mockResolvedValueOnce({ data: row() }) // owners: []
      .mockResolvedValueOnce({
        data: { ...row(), owners: [{
          id: 8, payer_id: 99, is_primary: true, source: 'app',
          payer_name: 'New Owner', phone: null, email: null,
          ownership_start: '2024-12-02',
        }] },
      });
    renderPage();
    expect(await screen.findByText(/nobody to bill/)).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'record owner' }));
    expect(screen.queryByText(/current owner/)).not.toBeInTheDocument(); // copy is truthful
    await userEvent.type(await screen.findByLabelText('payer search'), 'new');
    await userEvent.click(await screen.findByRole('option', { name: /New Owner/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Record change' }));
    await waitFor(() => expect(ownerService.assign).toHaveBeenCalledWith(98237, 99));
    expect(await screen.findByText('New Owner')).toBeInTheDocument();
    expect(screen.queryByText(/nobody to bill/)).not.toBeInTheDocument();
  });
});

describe('T-SCH-12: the biller who does not exist yet', () => {
  it('the empty search offers the form, the form fires on the click, and the ' +
     'created biller is the pick — then the first owner can be recorded', async () => {
    // The user's exact situation: a new site whose payer_label names a
    // person the payers table has never heard of. Typing must not create
    // anything (the search stays a search); the button opens the form; the
    // form's response row becomes the selected payer without a re-search
    // that could grab a same-named household instead.
    detail
      .mockResolvedValueOnce({ data: row() }) // owners: []
      .mockResolvedValueOnce({
        data: { ...row(), owners: [{
          id: 8, payer_id: 501, is_primary: true, source: 'app',
          payer_name: 'Justin Whitty', phone: null, email: null,
          ownership_start: '2024-12-02',
        }] },
      });
    payerSearch.mockResolvedValue([]); // nobody named Justin Whitty exists
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'record owner' }));
    await userEvent.type(await screen.findByLabelText('payer search'), 'justin');
    await waitFor(() => expect(payerSearch).toHaveBeenCalled());
    expect(payerCreate).not.toHaveBeenCalled(); // typing finds people; it does not make them

    await userEvent.click(await screen.findByRole('button', {
      name: 'Add “justin” as a new biller',
    }));
    expect(screen.getByRole('button', { name: 'Create biller' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('First name'), 'Justin');
    await userEvent.type(screen.getByLabelText('Last name'), 'Whitty');
    await userEvent.type(screen.getByLabelText('Mailing address'), '3489 Brooks Rd');
    await userEvent.click(screen.getByRole('button', { name: 'Create biller' }));
    await waitFor(() => expect(payerCreate).toHaveBeenCalledTimes(1));
    expect(payerCreate.mock.calls[0][0]).toMatchObject({
      first_name: 'Justin', last_name: 'Whitty', mailing_address: '3489 Brooks Rd',
    });

    // Back in search view with the new payer already picked: the row the
    // server named back is the row that gets recorded.
    await userEvent.click(await screen.getByRole('button', { name: 'Record change' }));
    await waitFor(() => expect(ownerService.assign).toHaveBeenCalledWith(98237, 501));
    // 'Justin Whitty' now appears twice on the page — the free-text
    // payer_label header and the new owner record. Assert the billing half:
    // the name on file, not the decoration.
    const billedTo = screen.getByText('Name on file').parentElement!;
    expect(await within(billedTo).findByText('Justin Whitty')).toBeInTheDocument();
  }, 20000);
});

describe('T-SCH-13: an open site can be put on a driver\'s day', () => {
  const openDialog = async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'add to schedule' }));
  };

  it('driver + day, one click: the site lands at the end of the draft and the ' +
     'confirmation says whether the day was made here', async () => {
    renderPage();
    await openDialog();
    const day = await screen.findByLabelText('schedule day');
    fireEvent.change(day, { target: { value: '2024-12-05' } });

    const submit = screen.getByRole('button', { name: 'Add to schedule' });
    expect(submit).toBeDisabled(); // a day without a driver is a half-thought

    await userEvent.click(screen.getByLabelText('schedule driver'));
    await userEvent.click(await screen.findByRole('option', { name: 'Marco Rivera' }));

    await userEvent.click(screen.getByRole('button', { name: 'Add to schedule' }));
    await waitFor(() => expect(addStopForDay).toHaveBeenCalledWith({
      property_id: 98237, driver_id: 12, route_date: '2024-12-05',
    }));
    // The page itself can carry warning alerts; the confirmation must be the
    // dialog's, not whichever alert happens to sort first.
    const done = await within(await screen.findByRole('dialog')).findByRole('alert');
    expect(done).toHaveTextContent('stop 1');
    expect(done).toHaveTextContent('Marco Rivera');
    expect(done).toHaveTextContent('new day'); // route_created was true
    expect(done).toHaveTextContent('draft');   // it is not the driver's yet
  });
});

describe('T-SCH-14: back to the queue it came from', () => {
  it('when the clerk arrived from the queue, the confirmation returns them there — reloaded, with the add still shown',
    async () => {
      jest.setTimeout(20000);
      renderPage({ from: 'due-queue' });
      await userEvent.click(await screen.findByRole('button', { name: 'add to schedule' }));
      fireEvent.change(await screen.findByLabelText('schedule day'),
        { target: { value: '2024-12-05' } });
      await userEvent.click(screen.getByLabelText('schedule driver'));
      await userEvent.click(await screen.findByRole('option', { name: 'Marco Rivera' }));
      await userEvent.click(screen.getByRole('button', { name: 'Add to schedule' }));

      const done = await within(await screen.findByRole('dialog')).findByRole('alert');
      expect(done).toHaveTextContent('stop 1');

      // No back button: the dialog knows where it came from. "Close" becomes
      // "Back to due queue", and the confirmation text rides along so the add
      // is still on screen while the re-read list settles (it no longer
      // contains this site — it is booked now).
      await userEvent.click(
        await within(screen.getByRole('dialog')).findByRole('button',
          { name: /back to due queue/i }));
      const landing = await screen.findByTestId('board-landing');
      expect(landing).toHaveTextContent('/due-queue');
      expect(landing).toHaveTextContent('stop 1');
    });
});

// The door SCH-14: the confirmation must load the route it just made a stop on.
describe('T-SCH-14: the confirmation is a door, not a dead end', () => {
  it('hands the clerk to the route to order and publish',
    async () => {
      renderPage();
      await userEvent.click(await screen.findByRole('button', { name: 'add to schedule' }));
      fireEvent.change(await screen.findByLabelText('schedule day'),
        { target: { value: '2024-12-05' } });
      await userEvent.click(screen.getByLabelText('schedule driver'));
      await userEvent.click(await screen.findByRole('option', { name: 'Marco Rivera' }));
      await userEvent.click(screen.getByRole('button', { name: 'Add to schedule' }));

      const done = await within(await screen.findByRole('dialog')).findByRole('alert');
      expect(done).toHaveTextContent('stop 1');
      // Confirming is not the end of the thought — the stop landed at the end
      // of the day and is still a draft. The dialog must offer to open that
      // exact route, carrying the id the server minted, not a blank board.
      await userEvent.click(
        await within(screen.getByRole('dialog')).findByRole('button',
          { name: /adjust stops & publish/i }));
      expect(await screen.findByTestId('board-landing'))
        .toHaveTextContent('/routes?date=2024-12-05&focus=4101');
    });
});

describe('T-SCH-13: an open site can be put on a driver\'s day', () => {
  const openDialog = async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'add to schedule' }));
  };

  it('a clash comes back as the server wrote it: the other route, by name', async () => {
    addStopForDay.mockRejectedValue({
      response: { data: { message:
        'Already routed on 2024-12-05 to Marco Rivera (route 4102). Remove it there first.' } },
    });
    renderPage();
    await openDialog();
    fireEvent.change(await screen.findByLabelText('schedule day'),
      { target: { value: '2024-12-05' } });
    await userEvent.click(screen.getByLabelText('schedule driver'));
    await userEvent.click(await screen.findByRole('option', { name: 'Marco Rivera' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add to schedule' }));
    const alert = await within(await screen.findByRole('dialog')).findByRole('alert');
    expect(alert).toHaveTextContent(
      'Already routed on 2024-12-05 to Marco Rivera (route 4102). Remove it there first.');
    expect(screen.queryByText(/stop 1/)).toBeNull(); // nothing was pretended
  });

  it('a driver is not offered a button the server would refuse', async () => {
    localStorage.setItem('jwt_user', JSON.stringify({
      id: 5, first_name: 'Marco', last_name: 'Rivera', email: 'm@x.test', role: 'driver',
    }));
    renderPage();
    await screen.findByText('3489 Brooks Rd');
    expect(screen.queryByLabelText('add to schedule')).toBeNull();
    expect(schedDrivers).not.toHaveBeenCalled();
  });
});

describe('T-DRV-21: work the truck found, filed from the site record', () => {
  // The whole requirement is that a DRIVER can stand at the house and file
  // this; every assertion below therefore runs with the driver's login, not
  // the office's. The office backfills from the same dialog (the backend
  // suite proves the door is not role-locked); this one proves the phone
  // facing half.
  beforeEach(() => {
    localStorage.setItem('jwt_user', JSON.stringify({
      id: 7, first_name: 'Dana', last_name: 'Reyes', email: 'd@x.test', role: 'driver',
    }));
    lookups.mockResolvedValue({
      waste_types: [{ id: 3, name: 'Residential septic waste', is_dnr_permitted: false }],
      disposal_sites: [{ id: 150, name: 'ZSS', dnr_permit_no: null, accepts_slurry: false }],
    });
  });

  it('a driver files gallons, waste type, site and note — once, with one client_uuid',
    async () => {
      jest.setTimeout(20000);
      recordEvent.mockResolvedValue({
        event: { id: '900', service_date: '2026-09-05' }, warnings: undefined,
      });
      renderPage();
      await screen.findByText('3489 Brooks Rd');
      expect(screen.queryByLabelText('add to schedule')).toBeNull(); // still office-only
      await userEvent.click(screen.getByLabelText('record service'));

      const dialog = await screen.findByRole('dialog');
      fireEvent.change(within(dialog).getByLabelText('record gallons'),
        { target: { value: '1500' } });
      await userEvent.click(within(dialog).getByLabelText('record waste type'));
      await userEvent.click(await screen.findByRole('option', { name: 'Residential septic waste' }));
      await userEvent.click(within(dialog).getByLabelText('record disposal site'));
      await userEvent.click(await screen.findByRole('option', { name: 'ZSS' }));
      fireEvent.change(within(dialog).getByLabelText('record note'),
        { target: { value: 'Called direct, overflow' } });

      await userEvent.click(
        within(dialog).getByRole('button', { name: 'Record service' }));
      await waitFor(() => expect(recordEvent).toHaveBeenCalledTimes(1));
      const call = recordEvent.mock.calls[0][0] as Record<string, unknown>;
      expect(call.property_id).toBe(98237);
      expect(call.gallons_pumped).toBe(1500);
      expect(call.waste_type_id).toBe(3);
      expect(call.disposal_site_id).toBe(150);
      expect(call.waste_note).toBe('Called direct, overflow');
      // Minted once for the attempt and its retries — the shape is a uuid,
      // and the retry contract (DRV-13) hangs on it never changing.
      expect(call.client_uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

      const done = await within(screen.getByRole('dialog')).findByRole('alert');
      expect(done).toHaveTextContent('Filed for 09/05/2026');
    });

  it('the server’s refusal arrives untranslated, and the dialog keeps the attempt',
    async () => {
      jest.setTimeout(20000);
      // A client that somehow let a bad body through gets the server's own
      // sentence back — the page never paraphrases the ledger.
      recordEvent.mockRejectedValue({
        response: { data: { message: 'No disposal site has id 999.' } },
      });
      renderPage();
      await screen.findByText('3489 Brooks Rd');
      await userEvent.click(screen.getByLabelText('record service'));
      const dialog = await screen.findByRole('dialog');
      await userEvent.click(within(dialog).getByLabelText('record waste type'));
      await userEvent.click(await screen.findByRole('option', { name: 'Residential septic waste' }));
      // No site chosen — the submit gate catches the common case, and if it
      // ever slips, the server's sentence, not a paraphrase, is what appears.
      const submit = within(dialog).getByRole('button', { name: 'Record service' });
      expect(submit).toBeDisabled();
      fireEvent.change(within(dialog).getByLabelText('record gallons'),
        { target: { value: '900' } });
      // ...and even a client that let a body through gets the server's words.
      await userEvent.click(within(dialog).getByLabelText('record disposal site'));
      await userEvent.click(await screen.findByRole('option', { name: 'ZSS' }));
      await userEvent.click(submit);
      const alert = await within(screen.getByRole('dialog')).findByRole('alert');
      expect(alert).toHaveTextContent('No disposal site has id 999');
    });
});
