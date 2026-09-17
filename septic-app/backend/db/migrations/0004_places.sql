-- 0004  Places: the hub of the whole model.
-- =============================================================================
-- `properties` is what legacy tblCustomers ACTUALLY holds: a septic system at a
-- site, not a person. The legacy name is a lie that has propagated into every
-- screen. Renaming it here is the single highest-value vocabulary fix in the rebuild.

SET search_path TO septic_app, pg_catalog;

CREATE TABLE properties (
    id                       serial PRIMARY KEY,
    -- P2: crews say "cust #3494" on the radio. `Job Site Location` literally contains
    -- 'See their house cust #3494'. This number is a natural key, not a curiosity.
    legacy_cust_number       int UNIQUE,
    payer_label              varchar(200),              -- 'Eubanks Rental', 'Zommers Property'

    site_address             varchar(255),
    site_city                varchar(100),
    site_state               char(2),                   -- normalised; legacy had 'WI' and 'Wi'
    site_zip                 varchar(10),               -- '54932-' -> '54932'; +4 kept where present
    county_id                int REFERENCES counties(id) ON DELETE SET NULL,
    town                     varchar(100),              -- 131 values
    plss_section             varchar(10),               -- '25SE','6NE' -- text, never an int
    plss_range               varchar(10),               -- 6 legacy values; one is '189871'
    parcel_id                varchar(40),               -- 'T06-14-18-06-14-001-00' (3,550 of 7,541)
    permit_number            varchar(30),               -- 5,120 distinct / 5,168 filled -> NOT unique

    system_type_id           int REFERENCES septic_system_types(id) ON DELETE SET NULL,

    -- Field notes. These are what a driver actually reads at the truck.
    tank_location_note       text,                      -- "NW/house - 55'W&10'N - all 3 expd"
    jobsite_location_note    text,                      -- "1/2 mile South of Cty F - West side"
    pump_style_note          text,
    chamber_pump_note        text,
    system_condition_note    text,

    baffle_inlet_material_id  int REFERENCES baffle_materials(id) ON DELETE SET NULL,
    baffle_inlet_date        date,
    baffle_outlet_material_id int REFERENCES baffle_materials(id) ON DELETE SET NULL,
    baffle_outlet_date       date,
    hose_count               numeric(4,2),              -- legacy holds '1 1/2' as a unicode fraction
    pump_installed_date      date,

    -- P1: the interval is the rule; the next-due date is arithmetic, never typed in.
    -- 1095d (3yr) covers 33,170 of 45,816 events (69%); 730d 7,027; 365d 3,434 = 91% combined.
    service_interval_days    int NOT NULL DEFAULT 1095 CHECK (service_interval_days > 0),
    last_service_date        date,                      -- maintained by the ledger, not by a user

    -- GENERATED. Cannot drift, cannot be hand-edited into inconsistency, and does not
    -- inherit the legacy +1-day bug that made Next Service Pump Date disagree with
    -- service_date + interval in 32,396 of 45,804 rows.
    -- Legal here only because date + integer is IMMUTABLE; business_today() is STABLE
    -- and could never be used in this expression.
    next_service_due         date GENERATED ALWAYS AS
                                 (last_service_date + service_interval_days) STORED,

    reminder_opt_out         boolean NOT NULL DEFAULT false,  -- 856 TRUE / 6,685 FALSE
    status                   property_status NOT NULL DEFAULT 'active',

    legacy_memo              text,                      -- P3: 7,427 verbatim, immutable
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now()
);

-- The one query the whole scheduling feature depends on.
CREATE INDEX idx_props_next_due ON properties (next_service_due) WHERE status = 'active';
CREATE INDEX idx_props_county   ON properties (county_id)        WHERE status = 'active';
CREATE INDEX idx_props_city     ON properties (site_city)        WHERE status = 'active';

COMMENT ON COLUMN properties.next_service_due IS
    'Generated. Never written to directly. See docs/DATA_MODEL.md P1.';

-- Multi-tank is the norm, not the edge case: 4,098 of 7,440 tank strings are composite.
-- '1500w.fltr+800 PC' becomes two rows: (primary,1500,filter) + (pre_cleanout,800).
CREATE TABLE tanks (
    id               serial PRIMARY KEY,
    property_id      int NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    sequence_no      smallint NOT NULL,
    role             tank_role NOT NULL,
    capacity_gallons int CHECK (capacity_gallons > 0),
    has_filter       boolean NOT NULL DEFAULT false,
    raw_text         varchar(100) NOT NULL,   -- '1650 triple' -- always preserved (P3)
    UNIQUE (property_id, sequence_no)
);

CREATE INDEX idx_tanks_property ON tanks (property_id);
