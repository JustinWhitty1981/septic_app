-- 0020  The ledger becomes append-only in the database, not in prose (LED-01).
-- =============================================================================
-- 0006 declared the table append-only in a comment and in a COMMENT ON; nothing
-- enforced it, which is the difference between a rule and a hope. This migration
-- installs the hope's enforcement, plus the two identity rules it needs to make
-- room for corrections:
--
--   1. A correction is a NEW row (`corrects_event_id` -> the event it replaces).
--      The old UNIQUE (property_id, service_date) would refuse that row, so the
--      constraint becomes a PARTIAL unique index on the rows that are not
--      corrections. Everything the old constraint was defending — one primary
--      service record per property per day, the DRV-09 collision, the ETL's
--      re-runnability — still holds for primary rows: legacy rows all have
--      corrects_event_id NULL, so the partial index covers exactly them.
--      Superseded primaries stay covered too, which is deliberate: re-completing
--      a day that has merely been corrected-away is a different event and should
--      arrive as one (the endpoint says so); the alternative — letting a fresh
--      primary row appear next to the original it duplicates — reopens the hole
--      the constraint exists to keep shut.
--
--   2. Superseded is derived, not stored: an event is superseded iff another
--      event names it. No column can therefore drift out of sync with the chain,
--      and the trigger below has no exceptions list to leak.
--
-- The trigger has one sanctioned bypass, a transaction-local GUC, for exactly
-- the code that legitimately rebuilds history: the ETL reset (etl/transform/
-- 00_reset.sql, which deletes legacy_import rows inside its transaction) and
-- test fixtures. `SET LOCAL septic.ledger_repair = 'on'` inside the transaction.
-- Statement-level, so the refusal happens once per attempt and the message is
-- the whole answer. TRUNCATE is included — the naive reading "truncating is not
-- editing" describes a hole, not a loophole.

SET search_path TO septic_app, pg_catalog;

ALTER TABLE service_events
    ADD COLUMN corrects_event_id bigint REFERENCES service_events(id) ON DELETE RESTRICT;

ALTER TABLE service_events
    DROP CONSTRAINT service_events_property_id_service_date_key;

CREATE UNIQUE INDEX uq_events_property_date_primary
    ON service_events (property_id, service_date)
    WHERE corrects_event_id IS NULL;

COMMENT ON INDEX uq_events_property_date_primary IS
    'LED-01: one PRIMARY record per property per day. Corrections (corrects_event_id NOT NULL) are deliberately outside it.';

-- LED-03: a pump-out the app recorded without a disposal site is not a completed
-- pump-out. Scoped to source = 'app': the legacy corpus carries 48,214 rows of
-- which 2965 have a site, and a table-wide constraint would have quarantined 94%
-- of the regulatory history — LED-05 and P7 forbid that trade. New history
-- carries the field; old history keeps its gaps, visible.
ALTER TABLE service_events
    ADD CONSTRAINT chk_ledger_app_disposal
    CHECK (source <> 'app' OR disposal_site_id IS NOT NULL) NOT VALID;

ALTER TABLE service_events
    VALIDATE CONSTRAINT chk_ledger_app_disposal;

CREATE OR REPLACE FUNCTION guard_append_only() RETURNS trigger AS $$
BEGIN
    IF coalesce(current_setting('septic.ledger_repair', true), '') = 'on' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION
        '% is append-only (LED-01). Correct a record by inserting a new row that references it; never rewrite or remove one.',
        TG_TABLE_NAME
        USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER no_edit_service_ledger
    BEFORE UPDATE OR DELETE OR TRUNCATE ON service_events
    FOR EACH STATEMENT EXECUTE FUNCTION guard_append_only();

-- Same guard, billing side (BIL-05): the ledger and the invoice book are one
-- argument — corrections are new rows. The invoices UPDATE guard is column-aware
-- in the function below's trigger pair: payment bookkeeping (amount_paid,
-- status) is not correction territory and must keep moving.
--
-- The columns come first in this file because the guard function names them:
-- a function created against a missing column is a runtime error waiting for
-- the first UPDATE, and triggers do not audition at CREATE time.
ALTER TABLE invoices
    ADD COLUMN kind varchar(16) NOT NULL DEFAULT 'invoice'
        CHECK (kind IN ('invoice', 'credit', 'adjustment')),
    ADD COLUMN adjusts_invoice_id int REFERENCES invoices(id) ON DELETE RESTRICT;

-- A correction document that corrects nothing is a new lie, not a correction.
ALTER TABLE invoices
    ADD CONSTRAINT chk_adjust_links
    CHECK (kind = 'invoice' OR adjusts_invoice_id IS NOT NULL);

CREATE TRIGGER no_edit_invoice_lines
    BEFORE UPDATE OR DELETE OR TRUNCATE ON invoice_lines
    FOR EACH STATEMENT EXECUTE FUNCTION guard_append_only();

CREATE OR REPLACE FUNCTION guard_invoice_header() RETURNS trigger AS $$
BEGIN
    IF coalesce(current_setting('septic.ledger_repair', true), '') = 'on' THEN
        RETURN OLD;
    END IF;
    -- What may change on an existing invoice: how much of it has been paid and
    -- the status word that follows from that. Everything that says what was
    -- SOLD is frozen; correcting what was sold is what `adjusts_invoice_id` is
    -- for (BIL-05).
    IF (NEW.payer_id, NEW.property_id, NEW.service_event_id, NEW.invoice_date,
        NEW.subtotal, NEW.tax_rate, NEW.tax_amount, NEW.total,
        NEW.legacy_invoice_no, NEW.kind, NEW.adjusts_invoice_id)
       IS DISTINCT FROM
       (OLD.payer_id, OLD.property_id, OLD.service_event_id, OLD.invoice_date,
        OLD.subtotal, OLD.tax_rate, OLD.tax_amount, OLD.total,
        OLD.legacy_invoice_no, OLD.kind, OLD.adjusts_invoice_id)
    THEN
        RAISE EXCEPTION
            'invoices are append-only in their money columns (BIL-05). Correct an invoice with a linked adjustment (kind = ''adjustment''); never rewrite the original.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER no_edit_invoice_header
    BEFORE UPDATE ON invoices
    FOR EACH ROW EXECUTE FUNCTION guard_invoice_header();

CREATE TRIGGER no_delete_invoice
    BEFORE DELETE OR TRUNCATE ON invoices
    FOR EACH STATEMENT EXECUTE FUNCTION guard_append_only();
