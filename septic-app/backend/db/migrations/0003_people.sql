-- 0003  People: who pumps, and who can log in.
-- =============================================================================
-- pumpers and users are deliberately separate tables. A person may pump without
-- ever having a login (owner, seasonal driver), and office staff have logins but no
-- certification. Collapsing them would force fake certifications or fake logins.

SET search_path TO septic_app, pg_catalog;

-- The regulatory identity. Source: tblOwner (7 rows). The certification number is
-- printed on every service record and every state filing, so it is the real key.
CREATE TABLE pumpers (
    id                    serial PRIMARY KEY,
    certification_number  varchar(20) NOT NULL UNIQUE,
    license_number        varchar(20),                 -- 'SY #602' on all 7 legacy rows
    first_name            varchar(100) NOT NULL,
    last_name             varchar(100) NOT NULL,
    company               varchar(160),
    phone                 varchar(20),
    is_active             boolean NOT NULL DEFAULT true,
    -- tblOwner cert 0 carries '?????' (a SQL Server encoding failure) and appears on
    -- invoices as Certification # = '0'. Imported INACTIVE so history still resolves.
    legacy_raw_cert       varchar(20),
    notes                 text
);

CREATE TABLE users (
    id             serial PRIMARY KEY,
    email          varchar(255) NOT NULL UNIQUE,
    password_hash  varchar(255) NOT NULL,
    first_name     varchar(100) NOT NULL,
    last_name      varchar(100) NOT NULL,
    role           user_role NOT NULL DEFAULT 'driver',
    -- One login per pumper, and a pumper may have no login at all.
    pumper_id      int UNIQUE REFERENCES pumpers(id) ON DELETE SET NULL,
    phone          varchar(20),
    is_active      boolean NOT NULL DEFAULT true,
    -- Last-login bookkeeping for a fleet of shared tablets.
    last_login_at  timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_active ON users (is_active) WHERE is_active;

COMMENT ON TABLE users IS
    'App accounts. Nothing is imported here: legacy auth was one shared plaintext '
    'password ("septic", tblSystem) and is deliberately not carried over.';
