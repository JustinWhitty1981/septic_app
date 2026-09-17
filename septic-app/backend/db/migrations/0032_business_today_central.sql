-- 0032: the business clock runs on Central time, not container time.
--
-- business_today() fell through its 'current_date' sentinel to the server's
-- own clock, and the server's clock is UTC. For the six evening hours when
-- Central is behind UTC (18:00–23:59 Central), the office board, the due
-- queue's "Today", the ledger's server-stamped service_date and the "day you
-- may not complete yesterday's stop" rule all answered with tomorrow. First
-- live report: 09/06/2026, 7:40 PM — the screen said 09/07.
--
-- The zone is pinned in the function rather than in container configuration
-- so a fresh Postgres on the wrong UTC box still gives the business the
-- right day: the office is in Central Standard Time (the zone name also
-- carries the daylight-saving rule, so the shift is correct year-round).
--
-- The sentinel value in app_setting stays the literal string 'current_date'
-- — it marks "the knob is released", and the released clock is now defined
-- here, in one place, in the business's own zone.
CREATE OR REPLACE FUNCTION business_today() RETURNS date
LANGUAGE sql STABLE
SET search_path = septic_app, pg_catalog
AS $fn$
    SELECT COALESCE(
        (SELECT NULLIF(value, 'current_date')::date
           FROM septic_app.app_setting
          WHERE key = 'as_of_date'),
        (now() AT TIME ZONE 'America/Chicago')::date
    );
$fn$;

COMMENT ON FUNCTION business_today() IS
    'The as-of date, in the business zone (America/Chicago). Use this instead '
    'of current_date — which answers in the server clock''s zone, UTC here.';
