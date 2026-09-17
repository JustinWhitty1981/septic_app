-- 0008  Field capture: notes and photos.
-- =============================================================================
-- Offline contract:
--   * client_uuid UNIQUE is the entire replay mechanism.
--   * Conflicts are directional, so no merge logic is ever needed. The server owns
--     schedule and status; a device owns only its own notes and photos, which are
--     append-only. Nothing is concurrently edited by two parties.

SET search_path TO septic_app, pg_catalog;

CREATE TABLE job_notes (
    id                bigserial PRIMARY KEY,
    client_uuid       uuid UNIQUE,                        -- P6
    service_event_id  bigint REFERENCES service_events(id) ON DELETE CASCADE,
    property_id       int  REFERENCES properties(id)     ON DELETE CASCADE,
    route_stop_id     int  REFERENCES route_stops(id)    ON DELETE CASCADE,
    author_id         int  NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    body              text NOT NULL,
    -- The phone's own clock. Used to order notes captured offline, where the server
    -- receive-time would collapse them all into the moment connectivity returned.
    client_created_at timestamptz NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    CHECK (service_event_id IS NOT NULL
        OR property_id      IS NOT NULL
        OR route_stop_id    IS NOT NULL)
);

CREATE INDEX idx_notes_event    ON job_notes (service_event_id);
CREATE INDEX idx_notes_property ON job_notes (property_id, client_created_at DESC);

-- P9: this row is METADATA ONLY. The bytes live in object storage. A bytea column
-- would push multi-megabyte payloads through the ORM, the pool, every SELECT and
-- every backup.
CREATE TABLE media (
    id               bigserial PRIMARY KEY,
    client_uuid      uuid UNIQUE,                          -- P6
    service_event_id bigint REFERENCES service_events(id) ON DELETE CASCADE,
    property_id      int  REFERENCES properties(id)     ON DELETE CASCADE,
    route_stop_id    int  REFERENCES route_stops(id)    ON DELETE CASCADE,
    uploaded_by      int  NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

    -- object storage coordinates
    storage_bucket   varchar(100) NOT NULL,
    storage_key      varchar(500) NOT NULL,

    sha256           char(64)   NOT NULL,                  -- dedupe + integrity
    mime_type        varchar(32) NOT NULL DEFAULT 'image/jpeg',
    byte_size        int  NOT NULL CHECK (byte_size > 0),
    width            int,
    height           int,
    kind             varchar(16) NOT NULL DEFAULT 'full',   -- 'full' | 'thumb'
    parent_media_id  int REFERENCES media(id) ON DELETE CASCADE,  -- thumb -> original

    taken_at         timestamptz,
    caption          varchar(500),
    -- Opt-in only. Phone EXIF (GPS, device model, exact capture time) is stripped by
    -- default; properties already have addresses and warehousing a driver's GPS track
    -- at every stop is a liability nobody asked for.
    gps_lat          numeric(9,6),
    gps_lng          numeric(9,6),
    upload_status    varchar(16) NOT NULL DEFAULT 'pending', -- pending|ready|failed

    created_at       timestamptz NOT NULL DEFAULT now(),
    deleted_at       timestamptz,   -- soft delete; a GC job issues DeleteObject after

    UNIQUE (storage_bucket, storage_key),
    -- The 3-megapixel cap, enforced in the database as a last line. Capped on TOTAL
    -- pixels, not on one edge: an edge cap lets a 10,000x300 panorama through.
    CHECK (width IS NULL OR height IS NULL OR width * height <= 3000000),
    CHECK (kind IN ('full', 'thumb')),
    CHECK (kind <> 'thumb' OR parent_media_id IS NOT NULL),
    CHECK (upload_status IN ('pending', 'ready', 'failed'))
);

CREATE INDEX idx_media_event    ON media (service_event_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_media_property ON media (property_id)      WHERE deleted_at IS NULL;
CREATE INDEX idx_media_sha      ON media (sha256);
CREATE INDEX idx_media_orphan   ON media (created_at)
    WHERE upload_status = 'pending' AND deleted_at IS NULL;
