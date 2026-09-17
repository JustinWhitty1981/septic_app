-- 0019  Session revocation, take two (AUT-11).
-- =============================================================================
-- 0018's marker was a timestamp compared against the token's `iat`. That was
-- wrong in a way only a test could find: `iat` resolves to one second, so a
-- token minted 0.4s BEFORE a logout is indistinguishable from one minted
-- 0.2s AFTER it. Every encoding of the marker traded one failure for the
-- other — truncate-down and a same-second re-login dies; truncate-up-and-
-- forward and the pre-logout token survives. The information is simply not in
-- a two-second-resolution comparison.
--
-- So: a counter, not a clock. Each login embeds the epoch it was issued in;
-- logout increments the column; `authenticate` refuses any token whose epoch
-- is behind. No arithmetic on wall-clock values, no boundary to get wrong:
-- "log out and immediately back in" is exact.
--
-- 0018 is not edited — its sha256 is recorded, and the drift guard (NF-05)
-- would fail the run if it changed. The dead column goes here instead.

SET search_path TO septic_app, pg_catalog;

ALTER TABLE users
    ADD COLUMN tokens_epoch integer NOT NULL DEFAULT 0,
    DROP COLUMN tokens_invalid_before;

COMMENT ON COLUMN users.tokens_epoch IS
    'AUT-11: login embeds the current epoch; logout increments it; tokens carrying an older epoch are refused.';
