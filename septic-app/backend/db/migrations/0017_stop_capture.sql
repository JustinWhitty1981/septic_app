-- 0017  A driver's device starts writing this table, so it needs what that implies.
-- =============================================================================
-- Nothing in the application could set a stop's status until now: `stop_status` has carried
-- five values since 0007 and every one of them was unreachable. DRV-06/07 make
-- `route_stops` the fourth table a phone can write to, and two things follow from that which
-- 0007 could not have known.
--
-- ---------------------------------------------------------------- 1. resolved_at
--
-- DRV-06 asks for four transitions "each timestamped server-side". The table has two
-- timestamp columns, `arrived_at` and `completed_at`, so only three of the four can be
-- stamped, and the fourth is a lie waiting to be told: writing `completed_at` on a stop
-- marked `skipped` says the crew completed a site they never went to. On one marked
-- `no_access` it says the same about a site they stood outside of.
--
-- That is not a pedantic objection, because the column is read by people. "When did this
-- stop finish" is a question a dispatcher asks, and a `completed_at` that answers it for a
-- skipped stop is a fabricated fact about where a truck was at 2pm — the same class of
-- invention as the GPS track P8 refuses to warehouse and the due date P1 refuses to store.
--
-- So `resolved_at` is the honest column: the instant the stop left the working list, for
-- whatever reason, with the reason in `status` beside it. `completed_at` keeps its literal
-- meaning and is written only by `done`. A `skipped` stop now has a timestamp and no lie.
--
-- ---------------------------------------------------------------- 2. client_uuid
--
-- NF-03/P6: "every table a device can write has a client_uuid". The guard in
-- schema-invariants.test.ts lists service_events, job_notes and media — the three tables
-- 0008 built for field capture — and it is correct as far as it goes. `route_stops` was not
-- on the list because no device could write it. Now one can.
--
-- The requirement is not ceremony. A driver marks a stop arrived on a jobsite with no
-- signal; the write sits in the queue and goes out three times when the truck reaches
-- cover. The transition machine in the endpoint makes the *state* correct under a replay —
-- the second attempt finds the stop already arrived and refuses it — but "refused" is the
-- wrong answer to a write that already succeeded: the queue cannot drain, and the driver
-- watches an error on an action that worked. `client_uuid UNIQUE` is what lets the replay be
-- recognised as the same write and answered with the original result.
--
-- It is nullable and every existing row keeps NULL, which is safe: Postgres treats NULLs as
-- distinct in a unique index, so the office's own writes and the dev fixture are unaffected.
-- Only a device that supplies a uuid is held to it.
--
-- Note what this does NOT do: it does not make `arrived_at` replay-stable on its own. The
-- endpoint reads the existing row before writing, so a replay returns the first attempt's
-- timestamp rather than a new one. The column makes the replay identifiable; the read is
-- what makes it harmless.

SET search_path TO septic_app, pg_catalog;

ALTER TABLE route_stops
    ADD COLUMN resolved_at timestamptz;

ALTER TABLE route_stops
    ADD COLUMN client_uuid uuid UNIQUE;

COMMENT ON COLUMN route_stops.resolved_at IS
    'When the stop left the working list, whichever way it left it — done, no_access or '
    'skipped. completed_at means completed and nothing else (0017).';

COMMENT ON COLUMN route_stops.client_uuid IS
    'Client-generated, and the only replay defence on a table a phone now writes (P6/NF-03).';
