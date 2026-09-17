-- Schema behaviour tests. Repeatable: everything runs in one transaction that is
-- rolled back, so it can be run against a populated database without side effects.
--
--   docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U septic_dev \
--     -d septic -f - < backend/db/dev/verify_schema.sql
--
-- Existence checks prove nothing. These assert behaviour: that the generated column
-- actually generates, that the 3 MP cap rejects a panorama, that the partial unique
-- index really allows exactly one current owner.

SET search_path TO septic_app, pg_catalog;
BEGIN;

CREATE FUNCTION _eq(what text, got anyelement, want anyelement) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF got IS DISTINCT FROM want THEN
        RAISE EXCEPTION 'ASSERT FAILED: % -- got %, want %', what, got, want;
    END IF;
    RAISE NOTICE '  ok    %', what;
END $$;

-- ------------------------------------------------------------- 0. fixtures ---
-- A user must exist before anything can own a photo or a note. That is the schema
-- being correct, not an obstacle to work around.
INSERT INTO users (email, password_hash, first_name, last_name, role)
VALUES ('_t@verify.invalid', 'not-a-real-hash', 'Verify', 'User', 'admin')
ON CONFLICT (email) DO NOTHING;

CREATE FUNCTION _uid() RETURNS int LANGUAGE sql STABLE AS
$$ SELECT id FROM septic_app.users WHERE email = '_t@verify.invalid' $$;

-- ---------------------------------------------------------------- 1. P1 ------
DO $$
DECLARE p properties%ROWTYPE;
BEGIN
    INSERT INTO properties (payer_label, last_service_date)
    VALUES ('_t generated', DATE '2024-01-15') RETURNING * INTO p;

    PERFORM _eq('next_service_due is generated (+1095 default)',
        p.next_service_due, DATE '2027-01-14');

    UPDATE properties SET last_service_date = DATE '2020-06-01' WHERE id = p.id;
    SELECT * INTO p FROM properties WHERE id = p.id;
    PERFORM _eq('next_service_due follows last_service_date',
        p.next_service_due, DATE '2023-06-01');

    UPDATE properties SET service_interval_days = 365 WHERE id = p.id;
    SELECT * INTO p FROM properties WHERE id = p.id;
    PERFORM _eq('next_service_due follows the interval',
        p.next_service_due, DATE '2021-06-01');

    -- The whole point of P1: it must not be writable.
    BEGIN
        UPDATE properties SET next_service_due = DATE '1999-01-01' WHERE id = p.id;
        RAISE EXCEPTION 'P1 VIOLATED: next_service_due was writable';
    -- 428C9 generated_column_not_updatable. Caught by SQLSTATE rather than a named condition because that name is
    -- not registered in this server's plpgsql condition list.
    EXCEPTION WHEN others THEN
        IF SQLSTATE = '428C9' THEN
            RAISE NOTICE '  ok    next_service_due cannot be written directly';
        ELSE
            RAISE 'P1: expected 428C9, got % (%)', SQLSTATE, SQLERRM;
        END IF;
    END;
END $$;

-- ------------------------------------------------------------ 2. P10 --------
DO $$
DECLARE d date;
BEGIN
    -- Set the precondition explicitly. This suite must not depend on ambient state:
    -- db/dev/fixture_as_of_date.sql legitimately pins the value in a dev database,
    -- and an assertion that only passes on an un-fixture'd database is a flaky test.
    UPDATE app_setting SET value = 'current_date' WHERE key = 'as_of_date';
    PERFORM _eq('business_today() falls back to real today',
        business_today(), current_date);

    UPDATE app_setting SET value = '2024-12-02' WHERE key = 'as_of_date';
    SELECT business_today() INTO d;
    PERFORM _eq('business_today() honours the fixture', d, DATE '2024-12-02');

    UPDATE app_setting SET value = 'current_date' WHERE key = 'as_of_date';

    -- must fail loudly, never silently return a plausible wrong date
    BEGIN
        UPDATE app_setting SET value = 'not-a-date' WHERE key = 'as_of_date';
        PERFORM business_today();
        RAISE EXCEPTION 'P10 VIOLATED: a bad as_of_date did not error';
    -- 22007 invalid_datetime_representation
    EXCEPTION WHEN others THEN
        IF SQLSTATE = '22007' THEN
            RAISE NOTICE '  ok    a bad as_of_date fails loudly';
        ELSE
            RAISE 'P10: expected 22007, got % (%)', SQLSTATE, SQLERRM;
        END IF;
    END;
    UPDATE app_setting SET value = 'current_date' WHERE key = 'as_of_date';
END $$;

-- ------------------------------------------------- 3. media 3 MP cap --------
DO $$
DECLARE n int;
BEGIN
    INSERT INTO media (uploaded_by, storage_bucket, storage_key, sha256, byte_size, width, height)
    VALUES (_uid(), 'b','ok-3mp','a',100,2000,1500);                       -- exactly 3.0 MP

    BEGIN
        INSERT INTO media (uploaded_by, storage_bucket, storage_key, sha256, byte_size, width, height)
        VALUES (_uid(), 'b','too-big','b',100,4000,3000);                  -- 12 MP
        RAISE EXCEPTION 'a 12 MP image was accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE '  ok    rejects an over-resolution image';
    END;

    -- The cap is on TOTAL pixels, deliberately, and these two cases are what makes
    -- that difference observable.
    --
    -- (a) 10,000 x 300 is exactly 3.0 MP. It must be ACCEPTED. A naive "max width
    --     3000px" rule would reject it, which would be wrong: memory during decode
    --     scales with pixels, not with the longest edge.
    INSERT INTO media (uploaded_by, storage_bucket, storage_key, sha256, byte_size, width, height)
    VALUES (_uid(), 'b','panorama-3mp','c',100,10000,300);
    RAISE NOTICE '  ok    accepts a 10000x300 panorama (3.0 MP, cap is not per-edge)';

    -- (b) 2,000 x 8,000 is 16 MP but only 2,000px wide. A per-edge width cap would
    --     wave this through. This is the case the total-pixel rule exists to catch.
    BEGIN
        INSERT INTO media (uploaded_by, storage_bucket, storage_key, sha256, byte_size, width, height)
        VALUES (_uid(), 'b','tall-16mp','e',100,2000,8000);
        RAISE EXCEPTION 'a 2000x8000 (16 MP) image was accepted -- cap is per-edge, not total';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE '  ok    rejects 16 MP that is narrow enough to fool a width cap';
    END;

    BEGIN
        INSERT INTO media (uploaded_by, storage_bucket, storage_key, sha256, byte_size, kind)
        VALUES (_uid(), 'b','thumb-no-parent','d',100,'thumb');
        RAISE EXCEPTION 'a thumbnail with no parent was accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE '  ok    a thumbnail must reference its original';
    END;

    SELECT count(*) INTO n FROM media WHERE deleted_at IS NULL;
    PERFORM _eq('exactly two valid media rows survived', n, 2);
END $$;

-- ------------------------------------------- 4. due queue + as-of coupling ---
DO $$
DECLARE r record;
BEGIN
    UPDATE app_setting SET value = '2024-12-02' WHERE key = 'as_of_date';

    -- Due 2024-11-01: overdue as of the fixture, NOT overdue as of real today.
    UPDATE properties SET last_service_date = DATE '2021-11-02',
                          service_interval_days = 1095
     WHERE payer_label = '_t generated';

    SELECT * INTO r FROM v_due_queue WHERE payer_label = '_t generated';
    PERFORM _eq('v_due_queue sees the property', r.property_id IS NOT NULL, true);
    PERFORM _eq('days_overdue uses business_today(), not current_date',
        r.days_overdue, 31);

    UPDATE app_setting SET value = 'current_date' WHERE key = 'as_of_date';
    SELECT * INTO r FROM v_due_queue WHERE payer_label = '_t generated';
    PERFORM _eq('the same row reads differently under a real clock',
        r.days_overdue > 600, true);

    UPDATE app_setting SET value = '2024-12-02' WHERE key = 'as_of_date';
END $$;

-- ------------------------------------- 5. exactly one current owner ----------
DO $$
DECLARE py1 int; py2 int; pr int;
BEGIN
    INSERT INTO payers (last_name) VALUES ('_t one') RETURNING id INTO py1;
    INSERT INTO payers (last_name) VALUES ('_t two') RETURNING id INTO py2;
    SELECT id INTO pr FROM properties WHERE payer_label = '_t generated';

    INSERT INTO property_ownerships (payer_id, property_id) VALUES (py1, pr);

    BEGIN
        INSERT INTO property_ownerships (payer_id, property_id) VALUES (py2, pr);
        RAISE EXCEPTION 'a second current owner was accepted';
    EXCEPTION WHEN unique_violation THEN
        RAISE NOTICE '  ok    partial unique index allows one current owner';
    END;

    -- Closing the first ownership must free the slot.
    UPDATE property_ownerships SET ownership_end = DATE '2024-01-01'
      WHERE payer_id = py1 AND property_id = pr;
    INSERT INTO property_ownerships (payer_id, property_id) VALUES (py2, pr);
    RAISE NOTICE '  ok    closing the prior owner frees the slot';
END $$;

-- ------------------------------- 6. ledger + offline idempotency -------------
DO $$
DECLARE pr int; u uuid := gen_random_uuid();
BEGIN
    SELECT id INTO pr FROM properties WHERE payer_label = '_t generated';

    INSERT INTO service_events (property_id, service_date, gallons_pumped)
    VALUES (pr, DATE '2024-11-01', 1500);

    BEGIN
        INSERT INTO service_events (property_id, service_date) VALUES (pr, DATE '2024-11-01');
        RAISE EXCEPTION 'a duplicate (property, date) service event was accepted';
    EXCEPTION WHEN unique_violation THEN
        RAISE NOTICE '  ok    UNIQUE (property_id, service_date) holds';
    END;

    -- A queued write replayed ten times must land once. This is the entire offline
    -- conflict story for notes.
    INSERT INTO job_notes (property_id, author_id, body, client_created_at, client_uuid)
    VALUES (pr, _uid(), 'queued twice', now(), u);

    BEGIN
        INSERT INTO job_notes (property_id, author_id, body, client_created_at, client_uuid)
        VALUES (pr, _uid(), 'queued twice', now(), u);
        RAISE EXCEPTION 'P6 VIOLATED: a replayed client_uuid was accepted';
    EXCEPTION WHEN unique_violation THEN
        RAISE NOTICE '  ok    client_uuid makes a replayed write idempotent';
    END;

END $$;

-- ---------------------------------------------------- 7. views project -----
-- "is queryable" was the assertion here, and it passed for a view that had returned zero
-- rows since the day it was created. A count over an empty view is a perfectly good zero,
-- the SELECT parsed, and the NOTICE said ok. That is a test which cannot fail — worse than
-- no test, because it is read as evidence, and for fifteen migrations it was the only thing
-- anybody had ever said out loud about v_driver_dispatch.
--
-- So build a day inside this transaction and ask the view to project it. What is under test
-- is the join, not the parse:
--
--   - a published route with stops must produce rows at all, which for most of this
--     project's life it did not;
--   - a site with no tanks must still arrive, because the LEFT JOIN is the only thing
--     standing between an inner join and a property silently vanishing from a driver's day;
--   - both county spellings must be present, since DRV-11 cannot be served by one and 0015
--     exists to add the second. Naming the columns is the assertion: a view that lost one
--     would fail to parse this block.
DO $$
DECLARE
    pr    int;
    pr2   int;
    rt    int;
    row   record;
    n     int;
BEGIN
    INSERT INTO properties (payer_label, site_address, county_raw, last_service_date)
    VALUES ('_t dispatch', '_t 1 Main St', 'FDL', DATE '2024-01-15')
    RETURNING id INTO pr;

    INSERT INTO tanks (property_id, sequence_no, role, capacity_gallons, has_filter, raw_text)
    VALUES (pr, 1, 'primary', 1000, false, '1000+500');

    -- A second site with nothing under it. The interesting case, and the one an inner join
    -- would delete from a driver's list without saying so.
    INSERT INTO properties (payer_label, site_address, last_service_date)
    VALUES ('_t no tanks', '_t 2 Elm St', DATE '2024-01-15')
    RETURNING id INTO pr2;

    INSERT INTO routes (route_date, driver_id, status)
    VALUES (business_today(), _uid(), 'published')
    RETURNING id INTO rt;

    INSERT INTO route_stops (route_id, property_id, sequence_no) VALUES
        (rt, pr, 1), (rt, pr2, 2);

    SELECT count(*) INTO n FROM v_driver_dispatch WHERE route_id = rt;
    PERFORM _eq('v_driver_dispatch projects a published day', n, 2);

    SELECT * INTO row FROM v_driver_dispatch WHERE route_id = rt AND property_id = pr;
    PERFORM _eq('  ... stops keep their order', row.sequence_no::int, 1);
    PERFORM _eq('  ... the county keeps its raw spelling', row.county_raw, 'FDL');
    PERFORM _eq('  ... the tank string survives verbatim',
                row.tanks -> 0 ->> 'raw', '1000+500');
    PERFORM _eq('  ... and the route reaches the payload',
                row.route_status, 'published'::route_status);

    SELECT json_array_length(tanks) INTO n
      FROM v_driver_dispatch WHERE route_id = rt AND property_id = pr2;
    PERFORM _eq('a site with no tanks arrives with an empty list, not a null', n, 0);

    -- v_due_queue is populated by the ETL rather than by this file, so the honest assertion
    -- is that it is not empty — which against a loaded database is a claim about the load.
    SELECT count(*) INTO n FROM v_due_queue;
    IF n = 0 THEN
        RAISE EXCEPTION 'ASSERT FAILED: v_due_queue returned 0 rows — the ETL has not run';
    END IF;
    RAISE NOTICE '  ok    v_due_queue returns % rows', n;
END $$;

ROLLBACK;
SELECT 'ALL SCHEMA ASSERTIONS PASSED' AS result;

