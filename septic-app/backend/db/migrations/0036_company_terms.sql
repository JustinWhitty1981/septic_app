-- 0036  Company payment terms: when the invoice says money is due, and what late costs.
-- =============================================================================
-- The statement the office mails has to state its own terms on its face — "due
-- in 30 days, 1.5% a month thereafter" is not information a customer should have
-- to be told by phone, and it is certainly not a figure retyped per document.
-- The same reason the sales-tax rate lives in one row (BIL-16): a number that
-- changes on every form is a number that drifts toward whatever the last clerk
-- felt, and it is why setting the tax from the bid screen felt "temporary" —
-- nothing made it look like a company decision.
--
-- These are company decisions, made once, in the open, with `updated_by` naming
-- who (0027's rule). The printed invoice reads them; the bid and new-invoice
-- forms read the tax the same way.
--
-- Bounds are the requirement, not decoration. A day count is capped at 365 so a
-- fat finger cannot print "due in 3000 days"; the late rate is a MONTHLY rate
-- (0.015 = 1.5%) and shares the tax column's <1 bound for the exact reason
-- spelled out on sales_tax_rate — a percent typed as a rate (1.5 for 1.5%)
-- would demand a 150% monthly penalty on every past-due account in the county.
ALTER TABLE septic_app.company_settings
  ADD COLUMN payment_term_days integer NOT NULL DEFAULT 30
    CHECK (payment_term_days BETWEEN 0 AND 365);

ALTER TABLE septic_app.company_settings
  ADD COLUMN late_fee_rate_monthly numeric(5,4) NOT NULL DEFAULT 0.0150
    CHECK (late_fee_rate_monthly >= 0 AND late_fee_rate_monthly < 1);

COMMENT ON COLUMN septic_app.company_settings.payment_term_days IS
  'NET-days: the printed terms count due-date this many days from the invoice date. '
  '0 means due on receipt.';
COMMENT ON COLUMN septic_app.company_settings.late_fee_rate_monthly IS
  'MONTHLY late rate on past-due invoices, stored as a rate (0.015 = 1.5%/month), '
  'printed on the invoice so the penalty is disclosed the day the bill is sent.';
