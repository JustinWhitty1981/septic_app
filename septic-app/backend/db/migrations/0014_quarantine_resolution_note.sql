-- 0014  The quarantine queue records what was decided, not merely that it was.
-- =============================================================================
-- import_quarantine has carried resolved_at and resolved_by since 0011, which is enough to
-- drain the queue and not enough to trust it. The two columns answer *that* a row was dealt
-- with and *who* dealt with it. Neither answers what they decided — so closing one of the six
-- orphan_line_negative_invoice_number rows leaves no trace of which invoice number the person
-- believed was meant, and the next reviewer cannot tell a considered resolution from an
-- accidental click. `unresolve` exists in the UI precisely because those two look identical.
--
-- DATA_MODEL §13 item 10 recorded this as an open item rather than fixing it, because the
-- table belongs to 0011 and 0011 is checksummed: scripts/migrate.ts stores a sha256 per file
-- and exits 1 on a mismatch, so a comment edit registers as schema drift. The consequence is
-- that a one-column fix costs a migration, and §13 said to spend one only when there was
-- something else to spend it on. This is that something else — the scheduling slice needed a
-- file, and this is the other thing that belonged in it.
--
-- Nullable, and deliberately unconstrained. A note is prose; a CHECK on its length would be
-- an opinion about somebody else's audit trail. The endpoint trims it and stores NULL for an
-- empty one, so "no note" has exactly one representation rather than four.
--
-- Nothing backfills it. The 3,876 rows here are unresolved, and the 0 already resolved have
-- no note to invent.

SET search_path TO septic_app, pg_catalog;

ALTER TABLE import_quarantine
    ADD COLUMN resolution_note text;

COMMENT ON COLUMN import_quarantine.resolution_note IS
    'What the resolver decided, in their own words. NULL means never recorded — which is '
    'different from the empty string, and the API only ever writes NULL.';
