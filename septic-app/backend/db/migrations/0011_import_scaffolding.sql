-- 0011  Migration scaffolding (P7).
-- =============================================================================
-- Nothing is silently dropped during the ETL. Every rejected row lands in
-- import_quarantine with a reason, and import_log makes a load auditable after the
-- fact. Known rejects already identified:
--   * 2 malformed service dates        ('12/21/217', '4/1/158')
--   * 8 malformed next-due dates       ('8/2/226', '7/1/316', '4/1/105', ...)
--   * 1 Range value of '189871'
--   * 1 Contract Date of '11/11/1111'

SET search_path TO septic_app, pg_catalog;

CREATE TABLE import_staging (
    id          bigserial PRIMARY KEY,
    source_file text NOT NULL,
    row_no      int  NOT NULL,
    raw         jsonb NOT NULL,
    loaded_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_staging_file ON import_staging (source_file);

CREATE TABLE import_quarantine (
    id          bigserial PRIMARY KEY,
    source_file text NOT NULL,
    row_no      int  NOT NULL,
    raw         jsonb NOT NULL,
    reason      text NOT NULL,
    -- NULL means "still needs a human". Set it once the row has been resolved.
    resolved_at timestamptz,
    resolved_by int REFERENCES users(id) ON DELETE SET NULL,
    quarantined_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_quarantine_open ON import_quarantine (source_file, reason)
    WHERE resolved_at IS NULL;

CREATE TABLE import_log (
    id           bigserial PRIMARY KEY,
    source_file  text NOT NULL,
    loaded       int NOT NULL DEFAULT 0,
    quarantined  int NOT NULL DEFAULT 0,
    skipped      int NOT NULL DEFAULT 0,
    started_at   timestamptz NOT NULL DEFAULT now(),
    finished_at  timestamptz,
    notes        text
);
