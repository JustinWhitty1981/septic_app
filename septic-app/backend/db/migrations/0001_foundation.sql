-- 0001  Foundation: settings, the as-of date (P10), and every enum in the model.
-- =============================================================================
-- business_today() exists because the development dataset is a snapshot that ends
-- 2024-12-02 while the wall clock keeps moving. Date rules that call current_date
-- directly read 4,608 overdue properties against the snapshot's own 1,926 -- and a
-- developer who sees that will write compensating logic that is wrong in production.
--
-- The default inserted here is 'current_date', i.e. real behaviour. Dev overrides it
-- via db/dev/fixture_as_of_date.sql. Migrations stay environment-agnostic.
--
-- Verified behaviour (rolled-back transaction, dev Postgres):
--   '2024-12-02'      -> 2024-12-02
--   'current_date'    -> real today
--   row absent        -> real today
--   'yesterday'       -> yesterday (Postgres parses bare relative date names)
--   'not-a-date'      -> ERROR invalid input syntax for type date  (fails loudly)

SET search_path TO septic_app, pg_catalog;

CREATE TABLE app_setting (
    key         text PRIMARY KEY,
    value       text NOT NULL,
    description text
);

COMMENT ON TABLE app_setting IS
    'Environment configuration that must be data, not code.';

INSERT INTO app_setting (key, value, description) VALUES
    ('as_of_date', 'current_date',
     'Business "today". A date, or the literal current_date. See docs/DATA_MODEL.md s6.1.')
ON CONFLICT (key) DO NOTHING;

-- STABLE, not IMMUTABLE: it reads a table and depends on current_date. That is fine
-- for views and WHERE clauses, but it can NEVER be used in a generated column or a
-- plain index expression -- those demand IMMUTABLE. next_service_due is deliberately
-- generated from immutable inputs only, so this constraint is not violated.
--
-- search_path is pinned inside the function so app_setting always resolves to the
-- septic_app copy regardless of the caller's search_path.
CREATE FUNCTION business_today() RETURNS date
LANGUAGE sql STABLE
SET search_path = septic_app, pg_catalog
AS $fn$
    SELECT COALESCE(
        (SELECT NULLIF(value, 'current_date')::date
           FROM septic_app.app_setting
          WHERE key = 'as_of_date'),
        current_date
    );
$fn$;

COMMENT ON FUNCTION business_today() IS
    'The as-of date. Use this instead of current_date in every date-relative rule.';

-- ---------------------------------------------------------------- enums -----

CREATE TYPE user_role AS ENUM ('admin', 'manager', 'driver', 'office');

CREATE TYPE property_status AS ENUM ('active', 'inactive', 'sealed', 'unknown');

CREATE TYPE tank_role AS ENUM ('primary', 'pre_cleanout', 'sand_filter', 'secondary');

CREATE TYPE event_status AS ENUM
    ('scheduled', 'dispatched', 'completed', 'cancelled', 'no_access');

CREATE TYPE route_status AS ENUM ('draft', 'published', 'in_progress', 'done');

CREATE TYPE stop_status AS ENUM
    ('pending', 'arrived', 'done', 'no_access', 'skipped');

CREATE TYPE invoice_status AS ENUM ('draft', 'open', 'paid', 'void');

CREATE TYPE payment_method AS ENUM ('check', 'cash', 'card', 'other');
