import React from 'react';
import { render, screen } from '@testing-library/react';
import { StopCard } from './DispatchPage';
import { DispatchStop, TankOnCard } from '../services/routeService';

/**
 * T-DRV-03b / 04b / 05b / 10b / 11b — the rendering half of five requirements.
 *
 * These five sat at 🟡 with a `T-DRV-XXb` todo beside each one, on the grounds that the
 * payload had been asserted against the database row it came from and nobody had ever looked
 * at the card. This file looks at the card.
 *
 * ## The fixtures are queries, not inventions
 *
 * Every awkward value below is a row in the dev database, with the property id in the test
 * name. That matters more here than in a backend test: a synthetic fixture proves the
 * component handles the case you thought of, and the reason these requirements exist at all is
 * that the records are stranger than anyone would invent. Property 1193 has a tank whose
 * verbatim text is `4-100 Pits` and whose parsed volume is 100 — the parse understates that
 * site fourfold, which is exactly the disagreement DRV-03 exists to make visible.
 *
 * ## What "not behind a tap" can be proved to mean here
 *
 * DRV-04 and DRV-05 say *on the card, without opening a detail view*. jsdom cannot tell me
 * whether a human would find the text by looking, so those tests assert the part that is
 * checkable: the text is in the document after render, with no interaction, in the card's own
 * subtree and in reading order ahead of anything that would have to be opened. That is
 * narrower than the English. It is stated rather than glossed over, because a test that
 * quietly means less than its requirement is how a checklist starts lying.
 */

const card = (over: Partial<DispatchStop> = {}): DispatchStop => ({
  stop_id: 41,
  sequence_no: 1,
  stop_status: 'pending',
  stop_version: 0,
  arrived_at: null,
  completed_at: null,
  property_id: 1193,
  legacy_cust_number: 1381,
  payer_label: "Gourmet's Delight Mushroom Farm, *",
  site_address: 'N4970 Mushroom Road',
  site_city: 'Eden',
  site_state: 'WI',
  site_zip: '53019-',
  county_name: 'Fond du Lac',
  county_raw: 'Fond du Lac',
  tank_location_note: null,
  jobsite_location_note: null,
  chamber_pump_note: null,
  system_condition_note: null,
  reminder_opt_out: false,
  next_service_due: '2025-03-14',
  tanks: [],
  ...over,
});

const show = (over: Partial<DispatchStop> = {}) => render(
  <StopCard stop={card(over)} queued={undefined} onRecord={async () => undefined} />
);

/** Property 1193, verbatim out of `tanks`. Six rows, four of them the same string. */
const TANKS_1193: TankOnCard[] = [
  { sequence_no: 1, role: 'primary', gallons: 1000, has_filter: false, raw: '1000' },
  { sequence_no: 2, role: 'secondary', gallons: 1500, has_filter: false, raw: '1500offc' },
  { sequence_no: 3, role: 'secondary', gallons: 100, has_filter: false, raw: '4-100 Pits' },
  { sequence_no: 4, role: 'secondary', gallons: 100, has_filter: false, raw: '4-100 Pits' },
  { sequence_no: 5, role: 'secondary', gallons: 100, has_filter: false, raw: '4-100 Pits' },
  { sequence_no: 6, role: 'secondary', gallons: 100, has_filter: false, raw: '4-100 Pits' },
];

describe('T-DRV-03b: the tank configuration, both ways', () => {
  it('renders every verbatim string and every parsed volume for all six tanks', () => {
    show({ tanks: TANKS_1193 });

    expect(screen.getAllByText('“1000”')).toHaveLength(1);
    expect(screen.getAllByText('“1500offc”')).toHaveLength(1);
    expect(screen.getAllByText('“4-100 Pits”')).toHaveLength(4);

    expect(screen.getAllByText('1,000 gal')).toHaveLength(1);
    expect(screen.getAllByText('1,500 gal')).toHaveLength(1);
    expect(screen.getAllByText('100 gal')).toHaveLength(4);
  });

  it('pairs each verbatim string with the volume it was parsed from', () => {
    // The discriminating one. A card that rendered all the raws and all the volumes in two
    // separate lists would satisfy the reading above and still be useless: the whole value of
    // showing both is seeing *which* parse produced *which* number.
    show({ tanks: TANKS_1193 });

    for (const raw of screen.getAllByText('“4-100 Pits”')) {
      expect(raw.parentElement).toHaveTextContent('100 gal');
    }
    expect(screen.getByText('“1500offc”').parentElement).toHaveTextContent('1,500 gal');
    expect(screen.getByText('“1000”').parentElement).toHaveTextContent('1,000 gal');
  });

  it('leaves the fourfold disagreement on 1193 visible instead of choosing a side', () => {
    // `4-100 Pits` is four 100-gallon pits. The parser recorded one of them. Nothing here
    // resolves that — the office has to — but a card that showed only `100 gal` would let a
    // driver and an invoice both act on a number that is wrong by a factor of four, and a
    // card that showed only the raw text would not add up. Both, on the same line, is the
    // most this requirement can ask for.
    show({ tanks: TANKS_1193 });

    const row = screen.getAllByText('“4-100 Pits”')[0].parentElement!;
    expect(row).toHaveTextContent('4-100 Pits');
    expect(row).toHaveTextContent('100 gal');
    expect(row).toHaveTextContent('secondary');
  });

  it('says a size was not parsed rather than showing nothing', () => {
    // 47 of the 10,051 tanks have no parsed capacity, and all 47 still have raw text — so
    // this is a live row, not a defensive branch. An absent line reads as "no tank" rather
    // than "a tank whose text we could not read", which are two different things to a driver
    // standing at the site with a tape measure.
    show({ tanks: [{ sequence_no: 1, role: 'primary', gallons: null, has_filter: false, raw: 'see plat' }] });

    expect(screen.getByText('size not parsed')).toBeInTheDocument();
    expect(screen.getByText('“see plat”')).toBeInTheDocument();
  });

  it('says so when the site has no tanks recorded at all', () => {
    show({ tanks: [] });
    expect(screen.getByText('No tanks recorded for this site.')).toBeInTheDocument();
  });
});

describe('T-DRV-04b: the customer number on the card', () => {
  it('prints it in the document after render, with nothing tapped', () => {
    show({ legacy_cust_number: 8239 });
    expect(screen.getByText('cust #8239')).toBeInTheDocument();
  });

  it('keeps the account number distinct from a number quoted inside a note', () => {
    // Property 7309, and the reason this row is P2. The card belongs to cust #8239; its own
    // jobsite note says "See cust #8240 for daughters place". A driver who cannot tell the
    // account from the anecdote calls the wrong number in, and the pump-out lands on the
    // daughter's permit. Presence of the string is not enough — it has to be the card's own
    // number, in the card's own position, not a substring of somebody's remark.
    show({
      legacy_cust_number: 8239,
      jobsite_location_note: 'South side - See cust #8240 for daughters place',
    });

    const own = screen.getByText('cust #8239');
    const quoted = screen.getByText('South side - See cust #8240 for daughters place');

    expect(own).not.toContainElement(quoted);
    expect(quoted).not.toContainElement(own);
    // 4 === DOCUMENT_POSITION_FOLLOWING: the card's number is read before the note.
    expect(own.compareDocumentPosition(quoted)).toBe(4);
  });

  it('leaves the line out when the property has no legacy number', () => {
    show({ legacy_cust_number: null });
    expect(screen.queryByText(/cust #/)).not.toBeInTheDocument();
  });
});

describe('T-DRV-05b: the field notes on the card', () => {
  it('shows all four notes with nothing to open', () => {
    // Property 188, four real notes, all of them abbreviated the way the legacy records are.
    show({
      tank_location_note: 'Need locs',
      jobsite_location_note: 'Reach from road * Joe & Carol',
      chamber_pump_note: 'MMand instld new systm 2017 9/',
      system_condition_note: 'Non Pressurized',
    });

    expect(screen.getByText('Tank location')).toBeInTheDocument();
    expect(screen.getByText('Need locs')).toBeInTheDocument();
    expect(screen.getByText('Job site')).toBeInTheDocument();
    expect(screen.getByText('Reach from road * Joe & Carol')).toBeInTheDocument();
    expect(screen.getByText('Chamber / pump')).toBeInTheDocument();
    expect(screen.getByText('MMand instld new systm 2017 9/')).toBeInTheDocument();
    expect(screen.getByText('System condition')).toBeInTheDocument();
    expect(screen.getByText('Non Pressurized')).toBeInTheDocument();
  });

  it('renders no note labels at all when the stop has none', () => {
    // Four labels with nothing under them would make an empty card look like a card whose
    // notes failed to load, which is a question the driver should never have to ask.
    show({});

    for (const label of ['Tank location', 'Job site', 'Chamber / pump', 'System condition']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
  });

  it('does not print a label for a note that is only whitespace', () => {
    // Measured, not assumed: there are currently zero such rows in `properties`. This guards
    // the filter itself, and the honest claim is that it has never yet had to fire.
    show({ tank_location_note: '   ' });
    expect(screen.queryByText('Tank location')).not.toBeInTheDocument();
  });
});

describe('T-DRV-10b: the reminder opt-out is marked', () => {
  it('marks a household that asked not to be reminded', () => {
    show({ reminder_opt_out: true });
    expect(screen.getByText('No reminders')).toBeInTheDocument();
    expect(screen.getByTestId('WarningIcon')).toBeInTheDocument();
  });

  it('does not mark one that did not', () => {
    // The requirement is only worth having if this half holds. A mark that is always on tells
    // a driver nothing, and 856 opted-out households out of 7,266 sites means the absence of
    // the chip is the common case and has to stay meaningful.
    show({ reminder_opt_out: false });
    expect(screen.queryByText('No reminders')).not.toBeInTheDocument();
    expect(screen.queryByTestId('WarningIcon')).not.toBeInTheDocument();
  });
});

describe('T-DRV-11b: the county, normalised, with the original retrievable', () => {
  it('shows the normalised name beside the spelling the paperwork used', () => {
    // Property 1903: `FDL` on the form, Fond du Lac in the county table. 26 rows say FDL.
    show({ county_name: 'Fond du Lac', county_raw: 'FDL' });
    expect(screen.getByText('Fond du Lac (recorded as “FDL”)')).toBeInTheDocument();
  });

  it('does not repeat the county back to itself when the form already spelled it right', () => {
    // Property 188, where the two agree. A parenthetical on every card would train a driver
    // to skim past the one time it matters.
    show({ county_name: 'Fond du Lac', county_raw: 'Fond du Lac' });
    expect(screen.getByText('Fond du Lac')).toBeInTheDocument();
    expect(screen.queryByText(/recorded as/)).not.toBeInTheDocument();
  });

  it('says the county was not recorded rather than leaving the line blank', () => {
    // Property 1519. One of the 49 sites 0013 refused to guess a county for. Blank reads as
    // missing data; this reads as a decision, which is what it was.
    show({ county_name: null, county_raw: null });
    expect(screen.getByText('County not recorded')).toBeInTheDocument();
  });

  it('keeps the original when the original is the only thing there', () => {
    // Property 4813: `Brothertown` written in the county field. Brothertown is a village in
    // Calumet County, so guessing would have been a guess about which county a municipality
    // sits in — LED-06 says the office decides that, not a migration. The card shows both
    // halves of that: nothing was concluded, and the paperwork's word survives.
    show({ county_name: null, county_raw: 'Brothertown' });
    expect(screen.getByText('County not recorded (recorded as “Brothertown”)')).toBeInTheDocument();
  });
});
