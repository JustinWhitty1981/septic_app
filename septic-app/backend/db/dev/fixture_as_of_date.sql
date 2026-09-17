-- Dev-only. NOT part of the migration chain. Run after `npm run migrate`:
--
--   docker compose exec -T postgres psql -U septic_dev -d septic \
--     -f - < backend/db/dev/fixture_as_of_date.sql
--
-- Pins "today" to the last day present in the legacy snapshot. Without this the dev
-- due queue reads 4,608 overdue properties instead of the snapshot's real 1,926, and
-- every date-relative screen looks broken when it isn't.
--
-- Production never runs this file: the migration already inserted 'current_date',
-- which is the correct real-world behaviour.

SET search_path TO septic_app, pg_catalog;

INSERT INTO app_setting (key, value, description)
VALUES ('as_of_date', '2024-12-02',
        'DEV FIXTURE. Pinned to max(service_pumped_date) in the legacy snapshot.')
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      description = EXCLUDED.description;

SELECT 'business_today() is now' AS note, business_today()::text AS as_of,
       (current_date - business_today())::int AS drift_days;
