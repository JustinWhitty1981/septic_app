-- 0007  Scheduling -- the primary feature.
-- =============================================================================
-- Sized from the data, not from taste. 2024: 2,160 jobs over 234 operating days,
-- median 9/day company-wide, p90 18, max 30, across an average of 2.34 active
-- pumpers (max 5). A driver's day is ~4 stops, peaking near 13.
--
-- That is one scrollable ordered list with large tap targets. It is NOT a calendar
-- grid, and NOT a map-first UI.

SET search_path TO septic_app, pg_catalog;

CREATE TABLE routes (
    id             serial PRIMARY KEY,
    route_date     date NOT NULL,
    driver_id      int  NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    truck_label    varchar(30),
    status         route_status NOT NULL DEFAULT 'draft',
    started_at     timestamptz,
    completed_at   timestamptz,
    -- Optimistic lock: two tablets can be open on the same route.
    version        int NOT NULL DEFAULT 0,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (route_date, driver_id)
);

CREATE INDEX idx_routes_date ON routes (route_date DESC);

CREATE TABLE route_stops (
    id                serial PRIMARY KEY,
    route_id          int NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
    property_id       int NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
    service_event_id  bigint REFERENCES service_events(id) ON DELETE SET NULL,
    sequence_no       smallint NOT NULL,
    status            stop_status NOT NULL DEFAULT 'pending',
    arrived_at        timestamptz,
    completed_at      timestamptz,
    version           int NOT NULL DEFAULT 0,
    UNIQUE (route_id, sequence_no)
);

CREATE INDEX idx_stops_route     ON route_stops (route_id, sequence_no);
CREATE INDEX idx_stops_property  ON route_stops (property_id);
-- A property should not sit on two live routes on the same day.
CREATE UNIQUE INDEX uq_stop_one_open_route
    ON route_stops (property_id, route_id)
    WHERE status NOT IN ('done', 'skipped');
