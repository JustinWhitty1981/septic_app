-- 00  Reset the ETL's own output.
-- =============================================================================
-- The transform must be re-runnable (ETL-01), but most of what it writes has no
-- natural key to upsert against: property_ownerships, tanks, invoice_lines and
-- service_events are surrogate-keyed. Re-running without this step would double every
-- one of those rows, and a duplicate ledger row is worse than a missing one.
--
-- So the rule is narrow and it is this: the ETL deletes exactly the rows carrying its
-- own provenance, and nothing else. A row created by the application survives a
-- re-import, because it was not the ETL's to remove.

SET search_path TO septic_app, pg_catalog;

-- The append-only guard (0020, LED-01) refuses DELETE on the ledger and the invoice
-- book. This reset is the guard's one legitimate customer: it deletes exactly the
-- ETL's own provenance-tagged rows, inside the run's single transaction. SET LOCAL
-- — the bypass dies at COMMIT and is not available to any other session, or to any
-- later file that does not ask for it in its own transaction.
SET LOCAL septic.ledger_repair = 'on';

-- ---------------------------------------------------------------------------
-- The interlock.
--
-- Deleting the imported ledger would strand anything that points into it. Routes,
-- stops and photos are written by the application and have no legacy counterpart, so
-- their presence means the database has moved past being a landing target and TRUNCATE
-- would be data loss dressed up as a re-run.
--
-- This check runs before a single row is touched, and it fails loudly rather than
-- quietly keeping stale references alive.
-- The tables that can be damaged by replacing the imported ledger.
--
-- job_notes and media reference service_events ON DELETE CASCADE. Deleting the
-- imported events therefore deletes the field notes and photos the application hung
-- off them — the database will not complain, because the cascade is exactly what it
-- was told to do. route_stops is SET NULL, which is subtler: the stop survives and
-- quietly stops pointing at anything.
--
-- users is deliberately NOT here. Its only link is to pumpers, which this transform
-- upserts rather than deletes, so blocking on a seeded admin account would stop the
-- ETL during ordinary development and teach the next person to comment it out.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    t   text;
    n   bigint;
BEGIN
    FOR t IN SELECT unnest(ARRAY['routes', 'route_stops', 'media', 'job_notes'])
    LOOP
        EXECUTE format('SELECT count(*) FROM septic_app.%I', t) INTO n;
        IF n > 0 THEN
            RAISE EXCEPTION
              'refusing to re-run the ETL: septic_app.% holds % application row(s). '
              'Replacing the imported service_events would % these rows, and the '
              'database would not object. Export or clear them first.',
              t, n,
              CASE WHEN t IN ('media', 'job_notes')
                   THEN 'delete'
                   ELSE 'leave pointing at nothing' END;
        END IF;
    END LOOP;
END
$$;

-- Child tables first; the order here is the dependency order reversed.
DELETE FROM invoice_lines l
USING invoices i
WHERE i.id = l.invoice_id AND i.legacy_invoice_no IS NOT NULL;

DELETE FROM payments p
USING invoices i
WHERE i.id = p.invoice_id AND i.legacy_invoice_no IS NOT NULL;

DELETE FROM invoices WHERE legacy_invoice_no IS NOT NULL;

DELETE FROM inspections WHERE legacy_inspect_id IS NOT NULL;

DELETE FROM service_events WHERE source = 'legacy_import';

DELETE FROM tanks t
USING properties p
WHERE p.id = t.property_id AND p.legacy_cust_number IS NOT NULL;

DELETE FROM property_ownerships WHERE source = 'legacy';

DELETE FROM import_quarantine WHERE source_file LIKE 'tbl%';

DELETE FROM import_log WHERE source_file LIKE 'tbl%';

-- last_service_date is derived, and the derivation is 07_derive.sql's job. Clearing it
-- here means a property whose events all disappeared cannot keep advertising a stale
-- due date through v_due_queue.
UPDATE properties SET last_service_date = NULL WHERE legacy_cust_number IS NOT NULL;
