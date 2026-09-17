-- 0024  One live row per content hash (DRV-18).
-- =============================================================================
-- DRV-18 says a retried photo upload must not duplicate, keyed on sha256. The
-- upload endpoint can look before it writes, and it does — but check-and-insert
-- is two statements, and a phone on a bad signal retries precisely when the
-- first attempt is still in flight. Without a constraint, the race's outcome is
-- two rows, and the second PUT overwrote the object the first row points at.
-- This is the same lesson SCH-05 learned about owners and SCH-08 learned about
-- routes: the rule that matters lives in the database, and the endpoint's
-- careful transaction is the courtesy, not the guarantee.
--
-- Partial (`WHERE deleted_at IS NULL`) on purpose. `deleted_at` is the table's
-- soft-delete: a deleted row keeps existing forever, and a photo deleted by
-- mistake and re-uploaded should be a new row — with its own uploader, caption,
-- and timestamp — not a resurrection of the old one. Deduplication is about
-- *live* duplicates; an index over tombstones would make re-uploading a
-- deleted photo permanently impossible, which is the opposite of the feature.
--
-- The old `idx_media_sha` (0005, non-unique) becomes redundant for lookups but
-- is left in place: media rows are written rarely, and dropping an index that
-- something unseen might lean on is not this migration's job.
CREATE UNIQUE INDEX IF NOT EXISTS uq_media_sha_live
    ON septic_app.media (sha256)
 WHERE deleted_at IS NULL;

COMMENT ON INDEX septic_app.uq_media_sha_live IS
  'DRV-18: one live media row per byte-identical upload; tombstones excluded '
  'so a re-upload after a soft delete opens a new row.';

-- The same argument, one table over: `job_notes.client_uuid` had no unique
-- constraint at all, which made the note endpoint's replay check a read in a
-- transaction — correct alone, fiction under a race. A phone that retries on
-- the timeout it cannot see through must get the first note back, not a twin.
CREATE UNIQUE INDEX IF NOT EXISTS uq_notes_client_uuid
    ON septic_app.job_notes (client_uuid)
 WHERE client_uuid IS NOT NULL;
