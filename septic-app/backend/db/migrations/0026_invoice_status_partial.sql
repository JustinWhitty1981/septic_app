-- runner: no-transaction

-- 0026  The status word 'partial' exists (BIL-06).
-- =============================================================================
-- The book had four words — draft, open, paid, void — and no way to say the
-- most common thing a receivables desk says: "partially paid." Legacy data
-- shows the shape of the gap directly: one imported invoice carries payments
-- and still reads 'open', because 'open' was the closest word available and
-- the schema cannot be blamed for a clerk choosing it.
--
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction, which is why this
-- file is (so far) the only one the runner executes outside BEGIN/COMMIT; the
-- statement is IF NOT EXISTS, so the loss of rollback costs a re-run rather
-- than a corrupted schema.
--
-- The value is *added*, never relied on to exist at parse time elsewhere:
-- every write of 'partial' in the codebase goes through the recomputation in
-- invoice.controller.recordPayment, and the receivables view derives from
-- numbers rather than from the word. The word is for humans reading rows.
ALTER TYPE septic_app.invoice_status ADD VALUE IF NOT EXISTS 'partial';
