-- 0015  The dispatch view carries the county, in both spellings.
-- =============================================================================
-- 0010 built v_driver_dispatch as "the single launch query", and DRV-01 depends on that
-- being true: one request, the whole day, nothing fetched per stop. When the driver slice
-- was built, the view turned out to be missing one field DRV-11 asks for — the county —
-- and there was nowhere else to get it from without a second query per launch.
--
-- Both spellings, not one. `county_id` is derived and `county_raw` is the evidence it was
-- derived from (0013). Showing only the normalised name would make a driver standing in
-- "Campbellsport" hear "Marathon" and hang up, and 38 of the 7,541 properties have no
-- county_id at all — 0013 refused to guess which county a municipality sits in, per LED-06.
-- A card that renders only county_name would render those blank, which reads as missing
-- data rather than as a deliberate refusal to guess.
--
-- CREATE OR REPLACE is the mechanism the immutability rule provides for exactly this, and it
-- turned out not to be available here: it requires the new query to keep every existing
-- column name in the same position, so appending county_name/county_raw ahead of `tanks`
-- fails with `cannot change name of view column "tanks" to "county_name"` (pg 42P16). The
-- column order is part of the response shape the PWA caches, so putting the new fields at the
-- end to satisfy the rule would have been the wrong trade.
--
-- So: drop and recreate. Safe here and only here because nothing depends on this view — no
-- view, rule, or matview references it (checked against pg_depend), and a view has no
-- indexes, no data and no grants to lose. A dependency would have forced the column order
-- above instead.

SET search_path TO septic_app, pg_catalog;

DROP VIEW IF EXISTS v_driver_dispatch;

CREATE VIEW v_driver_dispatch AS
SELECT r.id            AS route_id,
       r.route_date,
       r.status        AS route_status,
       r.version       AS route_version,
       s.id            AS stop_id,
       s.sequence_no,
       s.status        AS stop_status,
       s.version       AS stop_version,
       s.arrived_at,
       s.completed_at,
       p.id            AS property_id,
       p.legacy_cust_number,
       p.payer_label,
       p.site_address,
       p.site_city,
       p.site_state,
       p.site_zip,
       p.tank_location_note,
       p.jobsite_location_note,
       p.chamber_pump_note,
       p.system_condition_note,
       p.reminder_opt_out,
       p.next_service_due,
       c.name          AS county_name,
       p.county_raw,
       COALESCE(
         json_agg(
           json_build_object(
             'sequence_no', t.sequence_no,
             'role',        t.role,
             'gallons',     t.capacity_gallons,
             'has_filter',  t.has_filter,
             'raw',         t.raw_text
           ) ORDER BY t.sequence_no
         ) FILTER (WHERE t.id IS NOT NULL),
         '[]'::json
       ) AS tanks
FROM   routes r
JOIN   route_stops s ON s.route_id    = r.id
JOIN   properties  p ON p.id          = s.property_id
LEFT JOIN counties  c ON c.id          = p.county_id
LEFT JOIN tanks     t ON t.property_id = p.id
GROUP  BY r.id, r.route_date, r.status, r.version,
          s.id, s.sequence_no, s.status, s.version,
          s.arrived_at, s.completed_at,
          p.id, p.legacy_cust_number, p.payer_label, p.site_address, p.site_city,
          p.site_state, p.site_zip, p.tank_location_note, p.jobsite_location_note,
          p.chamber_pump_note, p.system_condition_note, p.reminder_opt_out,
          p.next_service_due, c.name, p.county_raw;

COMMENT ON VIEW v_driver_dispatch IS
    'The single launch query. Everything a driver needs offline, in one response. '
    'Carries county_name and county_raw (0015) so DRV-11 needs no second request.';
