/**
 * How a person in Wisconsin reads a date.
 *
 * The API speaks ISO (`YYYY-MM-DD`, deliberately: unambiguous across time
 * zones, sortable, and the reason `GET /due-queue` answers with calendar
 * strings instead of UTC instants that would move a due date by a day west
 * of Greenwich). Display speaks the way the office writes it on a work
 * order — `09/06/2026`.
 *
 * Formatting happens here, at the screen, and never at the server or in the
 * payload: a server-formatted date is a locale baked into an API, and the
 * state report that leaves this building is ISO no matter how nice the
 * office's calendars are.
 */

/** 'MM/DD/YYYY' from an ISO date string (or a Date). Empty stays empty;
 * anything unrecognised passes through rather than rendering blank — a
 * mystery string on screen is a question somebody can ask, a blank is not. */
export function usDate(value: string | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return String(value);
    const mm = String(value.getMonth() + 1).padStart(2, '0');
    const dd = String(value.getDate()).padStart(2, '0');
    return `${mm}/${dd}/${value.getFullYear()}`;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  return m ? `${m[2]}/${m[3]}/${m[1]}` : String(value);
}

/** 'MM/DD/YYYY h:mm AM/PM' for the moments the ledger stamps — a driver's
 * arrival is a time as well as a day. Server instants are UTC; this reads
 * them in the browser's zone, which on the office LAN and the handsets is
 * Central, which is the zone the shift actually happened in. */
export function usDateTime(value: string | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return String(value);
  const hm = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${usDate(d)} ${hm}`;
}
