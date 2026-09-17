-- 0022  The invoice guard's allowed path was a silent no-op (BIL-05 fixup).
-- =============================================================================
-- 0020's row-level BEFORE UPDATE trigger on `invoices` returned OLD on its
-- allowed path. A row-level BEFORE UPDATE that returns OLD does not "allow the
-- update" — it replaces the proposed row with the old one, i.e. it throws the
-- write away without complaint. Caught by tests/billing.test.ts: the case that
-- proves payment bookkeeping still works updated `amount_paid` from 0 to 100
-- and read 0 back. A guard that approves everything by doing nothing is worse
-- than no guard, because the test that checks "the allowed case is allowed"
-- passes the moment someone fixes the read instead of the write.
--
-- The ledger-wide statement-level guard is unaffected: statement-level triggers
-- ignore their return value, so `RETURN OLD` there was merely meaningless, not
-- wrong.
--
-- 0020's checksum is on record and its text is not edited (NF-05); the
-- correction is this file, applied forward like everything else.

SET search_path TO septic_app, pg_catalog;

CREATE OR REPLACE FUNCTION guard_invoice_header() RETURNS trigger AS $$
BEGIN
    IF coalesce(current_setting('septic.ledger_repair', true), '') = 'on' THEN
        RETURN NEW;
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
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
