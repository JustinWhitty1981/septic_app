-- 0025  Payments: from a number to a receipt (BIL-06/07).
-- =============================================================================
-- The table already exists — the billing import (0009/06_billing) brought 3,199
-- legacy receipts across, and they are clean: every invoice's payments sum to
-- its header's amount_paid, 3,199 for 3,199. So this migration is not a new
-- ledger; it is the three columns that make a row a receipt instead of an
-- amount, and the guard that keeps them that way.
--
--   * received_by — who took the money. Nullable on purpose, and that null is
--     the truth: the 3,199 imported rows predate any login in this system, and
--     backfilling them with a synthetic "system" user would invent custody
--     nobody had. New rows from the endpoint always carry a name; the column
--     comment makes that asymmetry visible rather than letting NULL mean
--     something different for two kinds of row silently.
--   * note — check number notes, "paid at dump site", the sentence a receipt
--     deserves.
--   * client_uuid — the field-side retry pattern (DRV-13) on the office side:
--     a payment clicked twice on a frozen machine is one receipt.
--
-- amount's CHECK tightens from >= 0 to > 0: the corpus says no legacy row is
-- zero, so the stricter rule cannot orphan history, and a $0 payment is not a
-- receipt — it is a placeholder, which is a thing this system refuses.
--
-- The FK flips CASCADE to RESTRICT (the 0023 argument): deleting an invoice
-- that money has been received against must not silently erase the receipts.
--
-- paid_at gains a default because the endpoint, not the caller, should be the
-- one saying when the office clock saw the money arrive.
--
-- No `source` column is needed: app-side payments can only attach to app-side
-- invoices, and 00_reset rebuilds legacy rows by deleting through
-- `legacy_invoice_no IS NOT NULL` — the app's receipts live on the far side of
-- that fence and survive a reload untouched (asserted in the ETL suite).
ALTER TABLE septic_app.payments
    ADD COLUMN IF NOT EXISTS received_by integer
        REFERENCES septic_app.users(id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS note       varchar(500),
    ADD COLUMN IF NOT EXISTS client_uuid uuid;

-- >= 0 had been the rule; > 0 is the rule. If any zero had existed this would
-- fail loudly, which is the correct outcome: fix history deliberately, or do
-- not change the rule at all.
ALTER TABLE septic_app.payments
    DROP CONSTRAINT payments_amount_check,
    ADD CONSTRAINT payments_amount_check CHECK (amount > 0);

ALTER TABLE septic_app.payments
    DROP CONSTRAINT payments_invoice_id_fkey,
    ADD CONSTRAINT payments_invoice_id_fkey
        FOREIGN KEY (invoice_id) REFERENCES septic_app.invoices(id) ON DELETE RESTRICT;

ALTER TABLE septic_app.payments ALTER COLUMN paid_at SET DEFAULT CURRENT_DATE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_client_uuid
    ON septic_app.payments (client_uuid) WHERE client_uuid IS NOT NULL;

-- The 0020 argument at its third example: a receipt that can be edited is not
-- a receipt. A payment entered wrong is corrected by another row (or, if the
-- money actually went out, by an adjustment invoice — BIL-05 keeps corrections
-- in one ledger). The ETL reset names this escape hatch out loud; nothing else
-- does.
CREATE TRIGGER no_edit_payments
    BEFORE UPDATE OR DELETE OR TRUNCATE ON septic_app.payments
    FOR EACH STATEMENT EXECUTE FUNCTION septic_app.guard_append_only();

COMMENT ON COLUMN septic_app.payments.received_by IS
  'BIL-06: the login that took the money. NULL means the row came from the
   legacy import, which had no logins to name — not "the office", whoever that
   was.';
COMMENT ON TABLE septic_app.payments IS
  'BIL-06: money received, one row per receipt, append-only. invoices.amount_paid
   is the SUM of these rows (recomputed, never incremented); a wrong receipt is
   corrected by another row, and a refund is an adjustment invoice.';
