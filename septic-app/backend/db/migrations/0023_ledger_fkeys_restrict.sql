-- 0023  Three foreign keys that could edit the ledger behind its own back (LED-01 fixup).
-- =============================================================================
-- 0020 put a trigger on service_events forbidding UPDATE. 0006 left three foreign
-- keys whose ON DELETE SET NULL makes Postgres issue exactly such an UPDATE
-- whenever a referenced row is removed: deleting a pumper, a waste type, or a
-- disposal site silently rewrites the regulatory rows that name them. The
-- contradiction was caught the honest way — by the test cleanup hitting the
-- guard and the suite refusing to end — and the guard won only because the
-- cleanup happened not to be running with the repair GUC raised.
--
-- RESTRICT is also the truer business rule, and it is the same rule LED-03
-- states for one of these columns out loud:
--
--   * a pumper who appears in the ledger cannot be deleted; a certification is
--     retired, not removed, and "who pumped it" must stay answerable;
--   * a waste type that appears in the ledger cannot be deleted; the value list
--     is closed by deactivation, not by erasing history;
--   * a disposal site the ledger names cannot be deleted — that is the column
--     the state report exists to group by.
--
-- The reference rows stay deletable in the ordinary case: Postgres checks the
-- restriction and the caller learns the row is cited, loudly and before any
-- write, instead of discovering afterwards that 30,000 ledger rows quietly lost
-- a field.

SET search_path TO septic_app, pg_catalog;

ALTER TABLE service_events
    DROP CONSTRAINT service_events_performed_by_pumper_id_fkey,
    ADD CONSTRAINT service_events_performed_by_pumper_id_fkey
        FOREIGN KEY (performed_by_pumper_id) REFERENCES pumpers(id) ON DELETE RESTRICT,
    DROP CONSTRAINT service_events_waste_type_id_fkey,
    ADD CONSTRAINT service_events_waste_type_id_fkey
        FOREIGN KEY (waste_type_id) REFERENCES waste_types(id) ON DELETE RESTRICT,
    DROP CONSTRAINT service_events_disposal_site_id_fkey,
    ADD CONSTRAINT service_events_disposal_site_id_fkey
        FOREIGN KEY (disposal_site_id) REFERENCES disposal_sites(id) ON DELETE RESTRICT;
