import { usDate, usDateTime } from './format';

/**
 * The one function every screen's dates run through, so the traps live in
 * one tested place: the ISO-into-UTC-midnight parse that shifts a day west
 * of Greenwich (the same bug `GET /due-queue` refuses by answering with
 * calendar strings), blanks that must stay blank, and strings the function
 * was not promised — which pass through rather than render as nothing,
 * because a wrong date on a pump-out ticket is exactly the kind of quiet
 * blank the office should never have to discover.
 */

describe('usDate', () => {
  it('reads the Wisconsin way', () => {
    expect(usDate('2026-09-06')).toBe('09/06/2026');
    expect(usDate('2024-12-02')).toBe('12/02/2024');
  });

  it('never lets the clock move a calendar day', () => {
    // 'YYYY-MM-DD' parsed whole, not through a UTC-midnight Date: a
    // formatter that went via new Date() would print 08/31 west of Greenwich.
    expect(usDate('2026-09-01')).toBe('09/01/2026');
    expect(usDate('2026-09-01T00:00:00.000Z')).toBe('09/01/2026');
  });

  it('blanks stay blank and mysteries pass through', () => {
    expect(usDate(null)).toBe('');
    expect(usDate(undefined)).toBe('');
    expect(usDate('')).toBe('');
    expect(usDate('today')).toBe('today');       // the DRV-20 fallback word
    expect(usDate('5/18/2393')).toBe('5/18/2393'); // the legacy typo, visible
  });

  it('accepts a Date without pretending the timezone does not exist', () => {
    expect(usDate(new Date(2026, 8, 6))).toBe('09/06/2026'); // local parts
  });
});

describe('usDateTime', () => {
  it('shows the day and the hour a shift happened in', () => {
    const stamp = usDateTime('2026-09-06T14:30:00');   // zone-less = local
    expect(stamp).toContain('09/06/2026');
    expect(stamp).toMatch(/2:30\s?PM/);
  });
});
