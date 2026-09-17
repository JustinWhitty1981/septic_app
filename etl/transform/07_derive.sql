-- 007  Derive last_service_date, which turns the due queue on.
-- =============================================================================
-- properties.last_service_date is not a fact anyone is allowed to type. It is the
-- newest completed service event for the property, and nothing else (0004 marks the
-- column 'maintained by the ledger, not by a user'). next_service_due is generated
-- from it, so this one statement is what makes SCH-01 mean anything: until it runs,
-- every property has a NULL last_service_date and a NULL due date, and v_due_queue
-- returns nothing no matter how much of the ledger is loaded.
--
-- Set to NULL first rather than only updating properties that have events. A
-- property whose events were removed must lose its due date too; an UPDATE that only
-- ever adds would leave a stale date pointing at a service that no longer happened.

SET search_path TO septic_app, pg_catalog;

UPDATE properties SET last_service_date = NULL WHERE last_service_date IS NOT NULL;

-- 'completed' only. A scheduled or dispatched stop is a plan, and treating a plan as
-- a completed service would push the next due date out by a full interval on the
-- strength of a visit that has not happened. cancelled and no_access are excluded by
-- the same reasoning.
UPDATE properties AS p
SET last_service_date = s.last_seen,
    updated_at        = now()
FROM (
    SELECT property_id, max(service_date) AS last_seen
    FROM service_events
    WHERE status = 'completed'
    GROUP BY property_id
) s
WHERE p.id = s.property_id;

-- service_interval_days is left at its default of 1095 for every property, and that
-- is a decision rather than an oversight. The legacy Next Service Date was a
-- hand-edited guess that disagreed with service_date + interval in 32,396 of 45,804
-- rows, so there is no stored interval to recover — only the observed gaps. Deriving
-- a per-property interval from history would be a scheduling rule with business
-- consequences (it decides who gets a reminder and when), and tblCustDumpLog does
-- carry days_between_pumps, so the arithmetic is possible. It is not done here because
-- the transform's job is to move the data, not to invent the rule. Flagged in
-- DATA_MODEL s13 for the owner to set.
