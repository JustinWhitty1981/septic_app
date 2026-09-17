/**
 * Where a role's "home" is, in one place.
 *
 * The landing decision was owned by App's `/` redirect and duplicated as a hardcoded
 * `/due-queue` on the login form's two navigation paths. The two drifted: a driver who
 * logged in fresh hit the due queue — 7,266 sites they cannot act on, with no way to
 * find the handful they were sent to — because the login path never consulted the role.
 * A driveway is not an office; the driver role exists because those are different jobs.
 *
 * Both the router and the login form now call this, so the answer cannot disagree
 * depending on which door the user came in.
 */

// The roles that sit at a desk. Typed as the string[] the menu's `roles` filter and the
// homeFor comparison both consume; a role typo here is caught by the same eyes that read
// the MENU, and a stale role simply stops matching (a person lands on their own home)
// rather than silently gating the wrong screen.
export const OFFICE_ROLES: readonly string[] = ['admin', 'manager', 'office'];

export const homeFor = (role: string | undefined): string =>
  role && OFFICE_ROLES.includes(role) ? '/due-queue' : '/dispatch';
