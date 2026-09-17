-- 0016  A day can be renumbered: the stop-order constraint is deferrable.
-- =============================================================================
-- Found by running it, not by reading it. Reversing a three-stop day — the single most
-- obvious thing a person does with a route — returned 500:
--
--   duplicate key value violates unique constraint "route_stops_route_id_sequence_no_key"
--
-- The renumber is one statement, `UPDATE … FROM unnest(…) WITH ORDINALITY`, which is what
-- makes it atomic. It is also what kills it: a unique index is checked **per row, as the
-- rows are written**, not at the end of the statement. Writing stop A from 1 to 3 collides
-- with stop C, which still holds 3 and has not been updated yet. There is no ordering of the
-- assignment that avoids this for an arbitrary permutation — a reversal always has somebody
-- standing on the number you are moving into.
--
-- So the constraint has to be told what it is guarding. It exists to make a half-applied
-- order impossible, and "at the end of the statement, row by row" is the wrong moment for a
-- set of writes that is only valid as a whole. DEFERRABLE moves the check to commit, which is
-- the moment the renumbering is actually finished.
--
-- INITIALLY IMMEDIATE, deliberately. Every other writer in the database keeps the behaviour
-- 0007 gave them: a duplicate sequence fails the instant it is attempted. Only the reorder
-- endpoint opts into deferral, and it does so with `SET CONSTRAINTS … DEFERRED` inside its own
-- transaction, so the deferral cannot leak into anybody else's work — it dies with the
-- transaction whether that transaction commits or rolls back.
--
-- This is not a loosening. The same set of rows is rejected at commit that would have been
-- rejected at statement time; the only rows that ever pass through the deferral are the ones
-- that were never in conflict to begin with, once every write in the statement has landed.
--
-- The constraint is dropped and re-added rather than altered, because Postgres offers no
-- ALTER CONSTRAINT … DEFERRABLE. The drop rebuilds the unique index; on 0 rows in dev and a
-- few hundred in production that is instant, and it is the only way to say this.

SET search_path TO septic_app, pg_catalog;

ALTER TABLE route_stops
    DROP CONSTRAINT route_stops_route_id_sequence_no_key;

ALTER TABLE route_stops
    ADD CONSTRAINT route_stops_route_id_sequence_no_key
    UNIQUE (route_id, sequence_no) DEFERRABLE INITIALLY IMMEDIATE;

-- COMMENT ON CONSTRAINT also names the table, which COMMENT ON COLUMN does not.
COMMENT ON CONSTRAINT route_stops_route_id_sequence_no_key ON route_stops IS
    'One stop per position per route. DEFERRABLE so a whole-day renumbering can be one '
    'statement: the check belongs at commit, where the new order is complete. Left INITIALLY '
    'IMMEDIATE so every writer except the reorder endpoint still fails immediately (0016).';
