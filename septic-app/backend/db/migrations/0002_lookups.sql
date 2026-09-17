-- 0002  Controlled vocabularies.
-- =============================================================================
-- Every one of these exists because the legacy data is dirty in a specific,
-- measured way. The counts are in the comments so the next person can re-derive
-- the normalisation instead of trusting it.

SET search_path TO septic_app, pg_catalog;

-- Legacy: 34 distinct spellings for ~6 real counties.
--   Fond du Lac 5,729 (76%) | Calumet 624 | Sheboygan 589 | Manitowoc 384
--   Dodge 74 | Winnebago 32   plus aliases 'FDL' (26), 'Fond du lac' (6)
CREATE TABLE counties (
    id          serial PRIMARY KEY,
    name        varchar(80) NOT NULL UNIQUE,
    wi_county_fips char(3)
);

-- The misspellings are data, not errors to discard: they are how the legacy rows
-- say what they mean, and the ETL must resolve them without losing the original.
CREATE TABLE county_alias (
    alias       varchar(80) PRIMARY KEY,
    county_id   int NOT NULL REFERENCES counties(id) ON DELETE CASCADE,
    source      varchar(20) NOT NULL DEFAULT 'legacy'
);

CREATE TABLE septic_system_types (
    id          serial PRIMARY KEY,
    name        varchar(120) NOT NULL UNIQUE,
    is_standard boolean NOT NULL DEFAULT true   -- false = curated, not a DNR category
);

-- Legacy lookup defines 9 values; the service log actually uses 65.
-- The 9 are the spine, the other 56 are free text that leaked into a enum-shaped column.
CREATE TABLE waste_types (
    id               serial PRIMARY KEY,
    name             varchar(120) NOT NULL UNIQUE,
    is_dnr_permitted boolean NOT NULL DEFAULT false,
    is_legacy_lookup boolean NOT NULL DEFAULT true   -- false = invented by users
);

-- 105 distinct free-text values: 'ZSS', 'Ziegelbauer slurry', 'land spread', ...
CREATE TABLE disposal_sites (
    id              serial PRIMARY KEY,
    name            varchar(160) NOT NULL UNIQUE,
    dnr_permit_no   varchar(40),
    accepts_slurry  boolean
);

-- 282 of 507 distinct values collapse to ~6 real materials (PVC, cast iron,
-- fibreglass, concrete, clay, ABS). The rest are '4" PVC tee' and similar.
CREATE TABLE baffle_materials (
    id          serial PRIMARY KEY,
    name        varchar(120) NOT NULL UNIQUE
);

-- tblInvoiceDetails is a real 99-row catalog. 17 codes are USED but undefined there,
-- so the ETL must create those as stubs rather than drop the line items.
CREATE TABLE service_types (
    id             serial PRIMARY KEY,
    code           varchar(20) NOT NULL UNIQUE,
    description    varchar(255) NOT NULL,
    default_price  numeric(10,2) CHECK (default_price >= 0),
    is_active      boolean NOT NULL DEFAULT true,
    is_legacy_catalog boolean NOT NULL DEFAULT true  -- false = stub created by ETL
);
