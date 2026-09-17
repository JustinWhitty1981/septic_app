-- Dev fixture: one published route on the snapshot's own today.
-- =============================================================================
-- Not a migration. Migrations stay environment-agnostic (0001's header says so), and this
-- file exists only so a developer and the test suite can point the driver app at a day that
-- actually has stops in it. Applied by hand, like fixture_as_of_date.sql:
--
--   docker compose exec -T postgres psql -U septic_dev -d septic \
--     -f - < septic-app/backend/db/dev/fixture_route.sql
--
-- Two things it has to get right, and both are easy to get wrong quietly.
--
--  1. **The date is `business_today()`, not the wall clock.** The fixture pins "today" to
--     2024-12-02. A route dated against the real clock would sit in the table, be perfectly
--     valid, and never appear in `/api/dispatch/today` — which reads as a broken feature
--     rather than as a fixture dated in the wrong calendar (P10).
--
--  2. **It respects SCH-08, the rule the index does not enforce.** Writing stops straight into
--     `route_stops` bypasses the endpoint that checks for double-booking, so a fixture that
--     ignored the rule would leave the dev database holding a state the API refuses to create.
--     Every pick below is filtered against the same predicate the endpoint uses.
--
-- The stops are *chosen*, not hard-coded. Property ids move when the ETL is re-run against a
-- fresh export, and a fixture pinned to ids would silently stop matching anything and publish
-- an empty day. Each pick is a characteristic instead, so the five stops exercise the five
-- things a stop card has to render: the overdue band that is actually real work, a composite
-- tank string, an opted-out household, a county whose spelling had to be normalised, and a
-- legacy memo.

SET search_path TO septic_app, pg_catalog;

-- ---------------------------------------------------------------- the driver ----
-- The seeded login. If it is missing the fixture stops loudly rather than routing nobody.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE email = 'driver@septic.test') THEN
    RAISE EXCEPTION 'fixture_route: driver@septic.test does not exist. Run npm run seed:user first.';
  END IF;
END $$;

INSERT INTO routes (route_date, driver_id, truck_label, status)
SELECT business_today(),
       (SELECT id FROM users WHERE email = 'driver@septic.test'),
       'Dev truck',
       'draft'
ON CONFLICT (route_date, driver_id) DO NOTHING;

-- ---------------------------------------------------------------- the stops ----
WITH day AS (
  SELECT r.id AS route_id
    FROM routes r
    JOIN users u ON u.id = r.driver_id
   WHERE r.route_date = business_today()
     AND u.email = 'driver@septic.test'
),
-- The five characteristics. UNION, not UNION ALL: a property that satisfies two of them —
-- an opted-out site with a composite tank, say — must not be booked twice, which the unique
-- index would reject and the fixture would report as its own failure.
picks AS (
  -- The two most overdue sites inside the last month. DATA_MODEL §13.8: of the ~1,925
  -- properties the queue calls overdue, only ~290 fell due this year. These are those.
  (SELECT p.id, p.next_service_due
     FROM properties p
    WHERE p.status = 'active' AND p.last_service_date IS NOT NULL
      AND p.next_service_due BETWEEN business_today() - 30 AND business_today()
    ORDER BY p.next_service_due LIMIT 2)

  UNION
  -- A site whose tanks do not fit in one row. Measured, because the first draft of this
  -- looked for a '+' in tanks.raw_text and there is not one anywhere in the 10,051 rows:
  -- composites are not '1500+800', they are two rows, and the awkward part is the string
  -- each row keeps — '800PC', '1500w.fltr', '2000 triple'. 5,213 of 10,051 raw_text values
  -- are not a bare number, and 2,446 properties have more than one tank. DRV-03 wants the
  -- verbatim string and the parsed rows on the same card, and this is the case that needs it.
  (SELECT p.id, p.next_service_due
     FROM properties p
    WHERE p.status = 'active'
      AND (SELECT count(*) FROM tanks t WHERE t.property_id = p.id) > 1
      AND EXISTS (SELECT 1 FROM tanks t2
                   WHERE t2.property_id = p.id AND t2.raw_text ~ '[^0-9]')
    ORDER BY p.id LIMIT 1)

  UNION
  -- One of the 856 households that asked not to be reminded. DRV-10.
  (SELECT p.id, p.next_service_due
     FROM properties p
    WHERE p.reminder_opt_out AND p.status = 'active'
    ORDER BY p.id LIMIT 1)

  UNION
  -- A county that needed normalising. 34 spellings for ~7 counties; 'FDL' accounts for 26 of
  -- them and 'Fond du lac' for 6. DRV-11 wants both spellings on the card.
  (SELECT p.id, p.next_service_due
     FROM properties p
    WHERE lower(p.county_raw) IN ('fdl', 'fond du lac') AND p.status = 'active'
    ORDER BY p.id LIMIT 1)

  UNION
  -- A site with a legacy Memo — the 7,427 free-text notes a driver reads standing at the
  -- truck. DRV-05.
  (SELECT p.id, p.next_service_due
     FROM properties p
    WHERE p.legacy_memo IS NOT NULL AND length(trim(p.legacy_memo)) > 20
      AND p.status = 'active'
    ORDER BY p.id LIMIT 1)
),
eligible AS (
  SELECT DISTINCT ON (x.id) x.id AS property_id, x.next_service_due
    FROM picks x
   WHERE NOT EXISTS (
            -- SCH-08, the same predicate route.controller.ts applies. A fixture that created
            -- a double-booking would leave the dev database holding a row the API cannot be
            -- made to produce, and the first test to notice would be a confusing one: correct
            -- data, wrong story.
            SELECT 1
              FROM route_stops s
              JOIN routes r2 ON r2.id = s.route_id
             WHERE s.property_id = x.id
               AND r2.route_date = business_today()
               AND s.status NOT IN ('done', 'skipped')
               AND r2.id <> (SELECT route_id FROM day)
          )
   ORDER BY x.id
),
numbered AS (
  -- Numbered from the highest sequence already on the day, and only for sites that are not
  -- already on it. The first draft numbered the whole eligible set from 1, which was fine
  -- until the picks changed and a re-run tried to put a new stop at position 2 — a
  -- constraint violation on a file whose whole job is to be run twice. A fixture that only
  -- works on an empty database is a fixture that breaks the first time somebody needs it.
  SELECT e.property_id,
         (SELECT count(*) FROM route_stops WHERE route_id = (SELECT route_id FROM day))
           + row_number() OVER (ORDER BY e.next_service_due NULLS LAST, e.property_id) AS seq
    FROM eligible e
   WHERE NOT EXISTS (
     SELECT 1 FROM route_stops es
      WHERE es.route_id = (SELECT route_id FROM day) AND es.property_id = e.property_id
   )
)
INSERT INTO route_stops (route_id, property_id, sequence_no)
SELECT d.route_id, n.property_id, n.seq
  FROM day d
 CROSS JOIN numbered n
 -- Five. A driver's day is ~4 stops peaking near 13; five is a day that looks like one, and
 -- the cap is what makes a third, fourth and fifth run leave the day exactly as wide as it is.
 WHERE n.seq <= 5;

-- ---------------------------------------------------------------- publish it ----
-- Published, because a draft is invisible to a driver by design (SCH-09) and a fixture that
-- left the day unpublished would test nothing about the dispatch endpoint.
UPDATE routes
   SET status = 'published', version = version + 1
 WHERE route_date = business_today()
   AND driver_id = (SELECT id FROM users WHERE email = 'driver@septic.test')
   AND status = 'draft';

-- ---------------------------------------------------------------- the receipt ----
-- A fixture that publishes an empty day is worse than no fixture: the endpoint would answer
-- 404 and the developer would debug the endpoint. So say what was built, and warn when it is
-- nothing.
DO $$
DECLARE
  n int;
  as_of date;
BEGIN
  SELECT business_today() INTO as_of;
  SELECT count(*) INTO n
    FROM route_stops s JOIN routes r ON r.id = s.route_id
   WHERE r.route_date = as_of
     AND r.driver_id = (SELECT id FROM users WHERE email = 'driver@septic.test');

  IF n = 0 THEN
    -- RAISE takes a format string plus arguments, not a concatenated expression: `||` here is
    -- a syntax error at parse time, which is a thing to know before the receipt is the only
    -- thing telling you the fixture did nothing.
    RAISE WARNING 'fixture_route: published with 0 stops as of %. The properties table does not match the profile this fixture selects from - check the ETL ran.', as_of;
  ELSE
    RAISE NOTICE '  ok    fixture_route: % stops on the route for business_today() = %', n, as_of;
  END IF;
END $$;

