-- 0021  Invoice lines get a real reference (BIL-01); corrections get signed
--       money (BIL-05).
-- =============================================================================
-- BIL-01: a line item that is only a sentence is a description of a charge, not
-- a charge. The legacy corpus proves the cost of the free-text version: the
-- orphaned `tblInvoiceAmount` rows could not be attributed to anyone precisely
-- because a line was its own text (BIL-03). So: every line references a service
-- event or a product code; a description may ride along, never stand alone.
--
-- The pre-check counts violations BEFORE the constraint is added and refuses to
-- proceed rather than half-applying and failing on row 3,412 with a message that
-- names no numbers. It passes on the current corpus (measured: all 3,466 loaded
-- lines carry a product code, zero carry neither), and the constraint is the
-- permanent rule behind the check.
--
-- BIL-05: a correction document is allowed to make the book smaller. A credit
-- or adjustment whose total is negative is arithmetically honest, and the
-- 0009 CHECKs — written when every row was an original invoice — refused it.
-- Those CHECKs are now scoped by kind instead of deleted: the >= 0 rule still
-- guards originals, where a negative total would be the classic slow-burn bug.

SET search_path TO septic_app, pg_catalog;

ALTER TABLE invoice_lines
    ADD COLUMN service_event_id bigint REFERENCES service_events(id) ON DELETE SET NULL;

-- The column now exists; the count below is honest in both senses — it runs
-- after the column lands (so the query can name it) and before the constraint
-- lands (so the failure message can count rows instead of dying on row 3,412).
DO $$
DECLARE
    n bigint;
BEGIN
    SELECT count(*) INTO n FROM invoice_lines
     WHERE service_event_id IS NULL AND legacy_product_code IS NULL;
    IF n > 0 THEN
        RAISE EXCEPTION
            'BIL-01: % invoice line(s) reference neither a service event nor a product. Resolve or quarantine them first — this migration will not invent a reference, and adding the constraint over them would fail at an arbitrary row.', n;
    END IF;
END
$$;

ALTER TABLE invoice_lines
    ADD CONSTRAINT chk_line_reference
        CHECK (service_event_id IS NOT NULL OR legacy_product_code IS NOT NULL);

CREATE INDEX idx_lines_event ON invoice_lines (service_event_id)
    WHERE service_event_id IS NOT NULL;

-- Money signs, scoped by kind. (Names as recorded by Postgres; verified against
-- pg_constraint before this file was written rather than guessed.)
ALTER TABLE invoices
    DROP CONSTRAINT invoices_subtotal_check,
    DROP CONSTRAINT invoices_total_check,
    DROP CONSTRAINT invoices_check,
    ADD CONSTRAINT invoices_subtotal_check
        CHECK (subtotal >= 0 OR kind IN ('credit', 'adjustment')),
    ADD CONSTRAINT invoices_total_check
        CHECK (total >= 0 OR kind IN ('credit', 'adjustment')),
    ADD CONSTRAINT invoices_paid_within_total
        CHECK (kind IN ('credit', 'adjustment') OR amount_paid <= total + 0.01);
