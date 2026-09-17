-- 0006  The service ledger -- the reason this business keeps records at all.
-- =============================================================================
-- Source: tblCustDumpLog, 48,216 rows / 19 columns, 1965-05-02 .. 2026-06-27.
-- This is the regulatory record. The old codebase had NO equivalent table: it had a
-- tank-inspection calendar and a state-report table with pre-computed counters.
--
-- APPEND-ONLY (P5). A correction is a new row, never an UPDATE.

SET search_path TO septic_app, pg_catalog;

CREATE TABLE service_events (
    id                     bigserial PRIMARY KEY,
    -- P6: offline-first. A queued write replayed ten times must land once.
    client_uuid            uuid UNIQUE,

    property_id            int NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
    performed_by_pumper_id int REFERENCES pumpers(id) ON DELETE SET NULL,
    -- 4,685 events carry a cert string that matches none of the 7 known pumpers. 21
    -- distinct values, but ONE of them ('6043') is 4,650 of them and spans 1988-2023.
    -- That is a real certification, not a typo -- so it is flagged, never guessed at.
    cert_unresolved        boolean NOT NULL DEFAULT false,
    cert_as_recorded       varchar(20),

    service_date           date NOT NULL,
    status                 event_status NOT NULL DEFAULT 'completed',

    gallons_pumped         numeric(8,1) CHECK (gallons_pumped >= 0),   -- 29,014 filled
    waste_type_id          int REFERENCES waste_types(id) ON DELETE SET NULL,  -- P4
    waste_note             text,                                              -- P4
    disposal_site_id       int REFERENCES disposal_sites(id) ON DELETE SET NULL,
    disposal_method        varchar(50),
    disposal_date          date,                                    -- only 5,519 of 48,216

    -- These three are 0-of-48,216 filled in the entire legacy corpus. The Access app
    -- had the fields but made them painful, so nobody used them. Capturing them at the
    -- truck in the mobile app is the whole point of their existing.
    dnr_permit_number      varchar(30),
    ph_before              numeric(4,2) CHECK (ph_before BETWEEN 0 AND 14),
    ph_after               numeric(4,2) CHECK (ph_after  BETWEEN 0 AND 14),
    duration_minutes       int CHECK (duration_minutes >= 0),

    county_form_date       date,                                     -- 35,158 filled

    source                 varchar(16) NOT NULL DEFAULT 'legacy_import',  -- | 'app'
    created_at             timestamptz NOT NULL DEFAULT now(),

    -- Load-bearing. Verified 0 duplicate (property, date) pairs across all 48,216
    -- rows. Makes the ETL re-runnable and stops a property being booked twice in a day.
    UNIQUE (property_id, service_date)
);

CREATE INDEX idx_events_date   ON service_events (service_date DESC);
CREATE INDEX idx_events_pumper ON service_events (performed_by_pumper_id, service_date DESC);
CREATE INDEX idx_events_open   ON service_events (status)
    WHERE status IN ('scheduled', 'dispatched');

COMMENT ON TABLE service_events IS
    'Append-only regulatory ledger. Corrections are new rows.';
