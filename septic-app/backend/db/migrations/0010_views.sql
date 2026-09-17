-- 0010  Read models.
-- =============================================================================
-- P1: the due queue is derived, so it is a VIEW. There is no `due_date` column to go
-- stale and no sync job to forget to run.
--
-- P10: days_overdue is measured against business_today(), NOT current_date. Against
-- the dev snapshot that is the difference between a sane 1,926 and a nonsense 4,608.

SET search_path TO septic_app, pg_catalog;

CREATE VIEW v_due_queue AS
SELECT p.id                     AS property_id,
       p.legacy_cust_number,
       p.payer_label,
       p.site_address,
       p.site_city,
       p.next_service_due,
       business_today() - p.next_service_due AS days_overdue,
       p.status
FROM   properties p
WHERE  p.status = 'active'
  AND  p.last_service_date IS NOT NULL
ORDER  BY p.next_service_due;

COMMENT ON VIEW v_due_queue IS
    'Derived from last_service_date + service_interval_days. Never materialised.';

-- One round trip per driver launch, so the PWA can cache a whole day at once.
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
LEFT JOIN tanks     t ON t.property_id = p.id
GROUP  BY r.id, r.route_date, r.status, r.version,
          s.id, s.sequence_no, s.status, s.version,
          s.arrived_at, s.completed_at,
          p.id, p.legacy_cust_number, p.payer_label, p.site_address, p.site_city,
          p.site_state, p.site_zip, p.tank_location_note, p.jobsite_location_note,
          p.chamber_pump_note, p.system_condition_note, p.reminder_opt_out,
          p.next_service_due;

COMMENT ON VIEW v_driver_dispatch IS
    'The single launch query. Everything a driver needs offline, in one response.';
