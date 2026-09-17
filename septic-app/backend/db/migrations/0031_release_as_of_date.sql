-- 0031  A fresh install must wake up on the real day (P10).
-- =============================================================================
-- 0001 seeded `as_of_date = '2024-12-02'` because the whole point of the
-- migration era was that the database *was* the snapshot: every
-- reconciliation test measured against the corpus as it stood on that date.
-- The business went live on 2026-09-05 and the knob was released by hand —
-- and that "by hand" was the bug: a released knob lives in one database,
-- while 0001 lives forever, so every fresh build (every `down -v`, every new
-- server, the eventual production box) woke up thinking it was December 2024.
-- The first driver who ever tests a rebuilt stack sees the office's published
-- routes vanish, because the office lives on the real calendar and the fresh
-- database does not.
--
-- So the release comes forward as data, not as an edit to frozen history:
-- 'current_date' is the sentinel 0001 already understands — COALESCE falls
-- through to the machine's clock. An as-of pin stays available on purpose
-- (SCH-03: backfill work is done by setting the knob and rolling it back
-- inside the work, the way stop-capture.test.ts pins it inside a
-- transaction); what is no longer available is accidentally living in 2024.

UPDATE app_setting
   SET value = 'current_date'
 WHERE key = 'as_of_date';

COMMENT ON COLUMN app_setting.value IS
    'Value for the key. For as_of_date: a date pins business_today() to it '
    '(migration-era behaviour), and the string current_date — the value set '
    'by 0031 — lets business_today() follow the machine. The office can set '
    'a pin for deliberate backfill work; a pin that arrives by rebuild is a '
    'bug, not a setting.';
