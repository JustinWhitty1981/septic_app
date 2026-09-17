import { homeFor, OFFICE_ROLES } from './nav';

// The one assertion that matters: a driver does not land on the due queue. It was the
// login form's hardcoded /due-queue default, not this function, that broke that — so the
// regression has to be pinned at the shared source the router and the login form agree on.
describe('homeFor', () => {
  it('sends every desk role to the due queue', () => {
    for (const role of OFFICE_ROLES) expect(homeFor(role)).toBe('/due-queue');
  });

  it('sends a driver to their own day', () => {
    expect(homeFor('driver')).toBe('/dispatch');
  });

  it('sends an unknown or absent role to the day, not the office board', () => {
    expect(homeFor(undefined)).toBe('/dispatch');
    expect(homeFor('technician')).toBe('/dispatch');
  });
});
