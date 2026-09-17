-- 0035: a correction must say why, and who, and it keeps that record forever (BIL-05).
--
-- The original of an adjusted invoice was already preserved — the ledger is
-- append-only, the 0022 trigger freezes every money column, and an adjustment is a
-- new invoice that names the old one. What was missing is the other half of a
-- complaint-grade record: the reason the office filed the correction, and whose
-- hand did it. The adjust screen asked for a reason and then dropped it; nothing
-- stored who made a document. This is the same rule the due-date adjustment learned
-- in 0029 — a correction nobody had to explain for is a correction nobody can defend
-- when the customer calls six weeks later.
--
-- created_by is attribution read off the login, never the request body, and stays
-- NULL on the 3,283 legacy rows: they arrived before there was anyone to attribute
-- them to. adjust_reason is the human sentence, and the CHECK says the true thing
-- the database could not before — a row whose kind is a correction has to carry one.
-- Originals answer NULL because a bill needs no apology.

ALTER TABLE septic_app.invoices
  ADD COLUMN created_by int REFERENCES septic_app.users(id);

ALTER TABLE septic_app.invoices
  ADD COLUMN adjust_reason text;

-- Any correction that predates this column already exists with no explanation; give
-- it an honest one rather than a CHECK that refuses to install. This touches only
-- adjust_reason (not a frozen money column), so the append-only guard permits it.
UPDATE septic_app.invoices
   SET adjust_reason = '(no reason recorded before 0035)'
 WHERE adjust_reason IS NULL AND kind IN ('adjustment', 'credit');

ALTER TABLE septic_app.invoices
  ADD CONSTRAINT chk_adjust_explains CHECK (
    kind NOT IN ('adjustment', 'credit') OR adjust_reason IS NOT NULL
  );

COMMENT ON COLUMN septic_app.invoices.created_by IS
  'Who created this document, read from the login (BIL-05). NULL means the legacy '
  'import: a real row whose author predates every login in this system.';

COMMENT ON COLUMN septic_app.invoices.adjust_reason IS
  'The human sentence for a correction — required on an adjustment or credit, the '
  'column the complaint gets answered from. "Billed the wrong rate" is the kind of '
  'sentence this is for.';
