-- 0030  v_due_queue keeps the column it has always had (SCH-15, restated).
-- =============================================================================
-- 0029 restated the 0010 view and, in doing so, dropped `status` from its
-- column list — an oversight caught inside the hour by `GET /due-queue`,
-- which reads `q.status` and 500'd on the office's own screen. The guard is
-- not negotiable for a migration already applied, and "only on one machine"
-- is exactly the shape a guard is built for, so the fix comes forward as it
-- always does: same view, plus the column it never should have lost. The
-- queue endpoint, the etl invariant and the office page all read this view by
-- name and column; none of them should have to notice the correction.

DROP VIEW v_due_queue;

CREATE VIEW v_due_queue AS
SELECT p.id                     AS property_id,
       p.legacy_cust_number,
       p.payer_label,
       p.site_address,
       p.site_city,
       p.status,
       p.next_service_due,
       COALESCE(adj.adjusted_due_date, p.next_service_due)       AS effective_due_date,
       (adj.adjusted_due_date IS NOT NULL)                       AS adjusted,
       adj.reason                                                AS adjustment_reason,
       business_today() - COALESCE(adj.adjusted_due_date, p.next_service_due)
                                                                 AS days_overdue,
       sched.route_date                                          AS scheduled_on,
       sched.status                                              AS scheduled_status,
       CASE WHEN sched.last_name IS NULL THEN NULL
            ELSE trim(sched.last_name || ', ' || sched.first_name)
       END                                                       AS scheduled_driver
FROM   properties p
LEFT JOIN LATERAL (
           SELECT d.adjusted_due_date, d.reason
             FROM due_date_adjustments d
            WHERE d.property_id = p.id AND d.closed_at IS NULL
            LIMIT 1
       ) adj ON TRUE
LEFT JOIN LATERAL (
           SELECT r.route_date, r.status, u.last_name, u.first_name
             FROM route_stops s
             JOIN routes r ON r.id = s.route_id
             JOIN users  u ON u.id = r.driver_id
            WHERE s.property_id = p.id
              AND s.status IN ('pending', 'arrived')
              AND r.route_date >= business_today()
            ORDER BY r.route_date, r.id
            LIMIT 1
       ) sched ON TRUE
WHERE  p.status = 'active'
  AND  p.last_service_date IS NOT NULL
ORDER  BY effective_due_date, p.legacy_cust_number;

COMMENT ON VIEW v_due_queue IS
    'Derived from last_service_date + service_interval_days, overlaid by any '
    'open due_date_adjustments row, silenced by any open future stop. '
    'Never materialised.';
