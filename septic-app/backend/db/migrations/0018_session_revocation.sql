-- 0018  Session revocation (AUT-11).
-- =============================================================================
-- Logout used to return 200 and do nothing: a token issued to a shared tablet
-- stayed valid for the full JWT_EXPIRES_IN regardless of what happened to the
-- account. A per-token denylist needs a jti the tokens do not carry, and it
-- revokes one session when the semantics wanted all of them — "this device is
-- no longer trusted" is a per-user statement.
--
-- So: one marker per user. `authenticate` refuses any token whose iat predates
-- it. Truncated up to the second and rounded forward one second, because iat
-- resolution is one second: a token minted in the same second *after* a logout
-- must survive (you can log out and straight back in), and one minted at or
-- before that second must not. The arithmetic is pinned by auth.test.ts.
--
-- The same read also makes `is_active = false` effective immediately: login
-- already refused inactive accounts (AUT-02), but tokens issued before the
-- deactivation kept working until they expired, which is the whole hole.

SET search_path TO septic_app, pg_catalog;

ALTER TABLE users
    ADD COLUMN tokens_invalid_before timestamptz;

COMMENT ON COLUMN users.tokens_invalid_before IS
    'Tokens issued before this instant are refused (AUT-11). NULL = never revoked.';
