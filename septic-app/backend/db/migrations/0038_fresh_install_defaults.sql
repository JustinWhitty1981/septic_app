-- 0038  A fresh install must boot with usable settings, not borrowed ones.
-- =============================================================================
-- Two things looked fine on the migrated database and fail on a clean one:
--
--   1. 0027 created the settings singleton with `SELECT 1, s.id FROM
--      disposal_sites s ...` — a row borrowed from the first disposal site.
--      The sites predate the company on the migrated database, so nobody
--      noticed; on a fresh install there is no first site yet, the SELECT
--      yields zero rows, and GET /api/settings answers success with a null
--      body while the first PATCH finds nothing to update.
--
--   2. 0037 defaulted company_name to the previous operator's letterhead.
--      A new company deploying this repo would print that name on every
--      invoice and bid until someone found the settings screen. A default is
--      only safe if it is safe to print.
--
-- Both are fixed forward (NF-05), never by editing 0027/0037. No existing
-- row is touched: the INSERT is DO NOTHING, the DEFAULT only speaks to rows
-- created after this point, and the office's decisions win over anything
-- stated here.
SET search_path TO septic_app, pg_catalog;

INSERT INTO company_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE company_settings
  ALTER COLUMN company_name SET DEFAULT 'Septic Service';
