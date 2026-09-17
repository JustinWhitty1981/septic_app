-- 0027  Company settings: one default disposal site (DRV-20).
-- =============================================================================
-- The driver's workflow is arrive → pump → gallons → next site. Asking a
-- person standing beside a truck to choose where the waste went, from a list
-- of 105 legacy free-text names, is not a workflow — it is how the
-- completion taps of 2026-09 quietly died (the site rule met the empty
-- vocabulary in DRV-07's second incident).
--
-- The implication lives in exactly one row. A settings *table* with many
-- keys is a junk drawer with a PRIMARY KEY; this one row answers one question,
-- and the CHECK makes sure nobody files a second answer next to it.
--
-- Why the default is a UI pre-fill and not a server fallback: a service
-- event's disposal site is the number the county report asks per site. A
-- value the server invented because a field arrived empty is not a fact
-- anyone can defend at an audit — it is a guess with a timestamp. Here the
-- guess is made once, by the office, in the open.
--
-- The seed is the most-used site in the legacy corpus (ZSS: 910 of the 2,965
-- imported events that name a site at all — 2965 of 48,216 name any). That
-- is a guess, stated as one, and PATCH /api/disposal-sites/default is where
-- the office corrects it.

CREATE TABLE IF NOT EXISTS septic_app.company_settings (
    id                       int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    default_disposal_site_id int REFERENCES septic_app.disposal_sites(id),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    updated_by               int REFERENCES septic_app.users(id) ON DELETE SET NULL
);

INSERT INTO septic_app.company_settings (id, default_disposal_site_id)
SELECT 1, s.id FROM septic_app.disposal_sites s
 WHERE s.name = 'ZSS'
   AND NOT EXISTS (SELECT 1 FROM septic_app.company_settings);

COMMENT ON TABLE septic_app.company_settings IS
  'DRV-20: the one row that answers "where does waste usually go". Read by '
  'GET /api/disposal-sites to mark is_default; the driver''s Done dialog '
  'pre-selects it. Never read by the ledger write path — `done` must still '
  'name a site, so a guess is never mistaken for a capture.';
COMMENT ON COLUMN septic_app.company_settings.default_disposal_site_id IS
  'Seeded to the legacy corpus'' most-used site (ZSS, 910 of 2,965 sited '
  'imported events). A stated guess; the office owns correcting it.';
