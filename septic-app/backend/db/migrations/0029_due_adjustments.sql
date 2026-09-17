-- 0029  A booked site is not a due site, and an explained date is not a fudged one
--       (SCH-15, SCH-16).
-- =============================================================================
-- Two things this queue got wrong in opposite directions.
--
--   1. It showed sites the office had already routed. The queue is the work of
--      planning tomorrow; a site with an open stop on a future day is planned
--      work wearing due-work's clothes, and every scan of the list tempted a
--      second booking of the same pump-out. The hiding rule counts drafts as
--      booked too — after the SCH-13 handoff the office's model of a saved
--      draft is "it is on Tuesday", and a half-composed day is half-composed
--      whoever wrote it. What keeps the hiding honest is that nothing is
--      deleted: `scheduled_on` travels in the payload, the page can show the
--      row as *booked, not due*, and a stop that reaches a terminal outcome
--      with no service (skipped, no_access) puts the site back on the next
--      read. History never counts: only a stop on a day that has not happened
--      yet can stand in for a due date.
--
--   2. It could not be argued with. A competitor pumped the tank and the
--      customer is not due for three years: the generated column says overdue
--      and the office has no lawful way to disagree. `next_service_due` is
--      GENERATED ALWAYS (SCH-11: the 32,396 hand-typed legacy dates are why
--      the keyboard may not type arithmetic); so the answer is an overlay row,
--      never an edit. One OPEN adjustment per site — closing is an action with
--      a `closed_by` and a `closed_at`, after which the computed truth
--      stands again, because an adjustment that cannot be retired is a new
--      hand-typed date wearing a reason as a costume.
--
-- The CHECK the table cannot have: `adjusted_due_date > business_today()`.
-- `business_today()` is STABLE, not IMMUTABLE, so the constraint could not
-- trust its own answer; the API refuses past dates by naming the ledger's
-- correction route (LED-01) instead. What the database does hold is the
-- reason — NOT NULL, the same rule job_notes learned: a correction nobody
-- had to explain for is a correction nobody will be able to defend.

CREATE TABLE due_date_adjustments (
    id                 int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    property_id        int  NOT NULL REFERENCES properties (id),
    adjusted_due_date  date NOT NULL,
    reason             text NOT NULL,
    created_by         int  NOT NULL REFERENCES users (id),
    created_at         timestamptz NOT NULL DEFAULT now(),
    closed_by          int  REFERENCES users (id),
    closed_at          timestamptz,
    -- closing is one action; a half-closed row (closed_at without a who) is
    -- an attribution the ledger would have to guess at.
    CONSTRAINT chk_close_is_attributed
        CHECK ((closed_at IS NULL) = (closed_by IS NULL))
);

CREATE INDEX idx_adjustments_property ON due_date_adjustments (property_id);

-- One open adjustment per site. PARTIAL on purpose: the history of an
-- adjustment — opened, retired, opened again years later — is exactly the
-- kind of history this schema keeps, and a full-unique index would either
-- forbid it or force destructive "fixes".
CREATE UNIQUE INDEX uq_one_open_adjustment
    ON due_date_adjustments (property_id)
 WHERE closed_at IS NULL;

COMMENT ON TABLE due_date_adjustments IS
    'Overlay rows for v_due_queue: an explained disagreement with the generated '
    'due date. Never an UPDATE to properties; next_service_due keeps computing.';
COMMENT ON COLUMN due_date_adjustments.reason IS
    'Required, human. "Competitor pumped 8/2026" is the kind of sentence this '
    'column is for.';

-- ---------------------------------------------------------------------------
-- v_due_queue, restated (SCH-15/16). The only lawful way to change a view
-- under NF-05 is a new migration: DROP/CREATE, never CREATE OR REPLACE on
-- anything earlier files froze — and this file still owns the 0010 promise,
-- restated: derived, never materialised, business_today() and never the wall.
-- ---------------------------------------------------------------------------

DROP VIEW v_due_queue;

CREATE VIEW v_due_queue AS
SELECT p.id                     AS property_id,
       p.legacy_cust_number,
       p.payer_label,
       p.site_address,
       p.site_city,
       p.next_service_due,
       COALESCE(adj.adjusted_due_date, p.next_service_due)       AS effective_due_date,
       (adj.adjusted_due_date IS NOT NULL)                       AS adjusted,
       adj.reason                                                AS adjustment_reason,
       -- days_overdue keeps its 0010 name and its meaning, and follows the
       -- overlay: the queue asks "is this late?" about the date the office is
       -- acting on, not about a raw column it may have openly disputed.
       business_today() - COALESCE(adj.adjusted_due_date, p.next_service_due)
                                                                 AS days_overdue,
       sched.route_date                                          AS scheduled_on,
       sched.status                                              AS scheduled_status,
       CASE WHEN sched.last_name IS NULL THEN NULL
            ELSE trim(sched.last_name || ', ' || sched.first_name)
       END                                                       AS scheduled_driver
FROM   properties p
LEFT JOIN LATERAL (
           -- one open adjustment, if the office is disagreeing. The LIMIT 1 is
           -- redundancy the partial unique index already guarantees; the view
           -- refuses to multiply rows even handed a broken database.
           SELECT d.adjusted_due_date, d.reason
             FROM due_date_adjustments d
            WHERE d.property_id = p.id AND d.closed_at IS NULL
            LIMIT 1
       ) adj ON TRUE
LEFT JOIN LATERAL (
           -- the earliest future commitment. Terminal stop statuses — done,
           -- skipped, no_access — are deliberately NOT bookings: a skipped
           -- stop is a pump-out that did not happen, and the site comes back
           -- to the queue because that is the queue's whole job.
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
