-- 0034: a line may say whether the sales-tax rate touches it (BIL-16, BIL-20).
--
-- The rate itself is the one company-wide number the office sets (0028,
-- BIL-16); until now it fell on every line of a taxed invoice at once. This is
-- the half that was missing: not a second rate, but a per-line word for whether
-- the one rate applies here at all. A pump-out and a resale certificate handed
-- across the counter share a document, and they are not both taxed — the state
-- report and the customer's statement can only say so if the line itself does.
--
-- NOT NULL DEFAULT true is the honest seed, not a placeholder. Every line the
-- system has ever stamped was taxed, because the rate was charged across the
-- whole subtotal. Defaulting true is what keeps a document built before this
-- column existed identical to one built after it: an all-true document taxes
-- the whole subtotal, exactly as before. A clerk takes a line off tax by
-- unchecking it. The value is intent only — the amount of tax is still the
-- database's, computed once over the sum of the taxable lines (BIL-04).

ALTER TABLE septic_app.invoice_lines
  ADD COLUMN taxable boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN septic_app.invoice_lines.taxable IS
  'Whether the company sales-tax rate applies to this line (BIL-16). '
  'Intent, not money: the tax itself is computed server-side over the '
  'taxable lines only. Default true — every legacy line was taxed.';
