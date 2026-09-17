-- 0012  Make the app schema resolvable by default.
-- =============================================================================
-- Without this, `psql -U septic_dev -d ziegelbauer_septic` lands in search_path
-- "$user", public and reports:
--
--     SELECT business_today();
--     ERROR: function business_today() does not exist
--
-- Every ad-hoc query, psql session, and monitoring script then needs an explicit
-- `SET search_path`, which is the kind of thing that gets forgotten at 2am. Setting
-- it at the database level means the schema is simply *there* for anything that
-- connects.
--
-- Applies to new sessions, which is what we want: it does not disturb connections
-- that are already open.
--
-- This is added as a new migration rather than an edit to 0001 because a migration
-- that has been applied is immutable -- which scripts/migrate.ts will now refuse to
-- let you forget.

DO $$
BEGIN
    EXECUTE format(
        'ALTER DATABASE %I SET search_path = septic_app, public',
        current_database());
END $$;
