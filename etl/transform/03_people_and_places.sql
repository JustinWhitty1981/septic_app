-- 002  Payers, properties, and who owns which property.
-- =============================================================================
-- A payer is a mailing address, not a contact record (SCH-07): 118 of 7,572 have a
-- phone number and none have an email. Nothing here invents a way to reach them.

SET search_path TO septic_app, pg_catalog;

-- billing_alt_phone_ext has nowhere to go: payers has phone_ext but no
-- alt_phone_ext. Recorded rather than quietly dropped.
INSERT INTO payers AS py (
    legacy_billing_no, first_name, last_name, mailing_address, mailing_city,
    mailing_state, mailing_zip, phone, phone_ext, alt_phone, tax_exempt
)
SELECT
    -- The landing zone is all TEXT (ETL-06: the loader is a pipe, not a parser), so
    -- every key cast happens here where it is visible. Verified beforehand: all 7,572
    -- billing numbers and all 7,541 customer numbers are digits within int4 range.
    b.billing_number::int,
    pg_temp.clean(b.billing_first_name),
    pg_temp.clean(b.billing_last_name),
    pg_temp.clean(b.billing_address),
    pg_temp.clean(b.billing_city),
    pg_temp.clean(b.billing_state),
    pg_temp.clean(b.billing_zip),
    pg_temp.clean(b.billing_phone),
    pg_temp.clean(b.billing_phone_ext),
    pg_temp.clean(b.billing_alt_phone),
    false
FROM legacy.tblbilling b
WHERE coalesce(b.billing_number, '') <> ''
ON CONFLICT (legacy_billing_no) DO UPDATE SET
    first_name     = EXCLUDED.first_name,
    last_name      = EXCLUDED.last_name,
    mailing_address = EXCLUDED.mailing_address,
    mailing_city   = EXCLUDED.mailing_city,
    mailing_state  = EXCLUDED.mailing_state,
    mailing_zip    = EXCLUDED.mailing_zip,
    phone          = EXCLUDED.phone,
    phone_ext      = EXCLUDED.phone_ext,
    alt_phone      = EXCLUDED.alt_phone;

-- ---------------------------------------------------------------------------
-- properties — one row per tblCustomers record, 7,541 of them.
--
-- county_id is resolved by exact match against county_alias and nothing else. The
-- original string always survives in county_raw, so a wrong or missing resolution is
-- a visible, correctable fact rather than a lost one.
--
-- status is 'active' only where the property has actually been serviced. A property
-- with no service history is 'unknown', not 'active' — the source cannot say the
-- system still exists, and property_status has a value for exactly that doubt.
-- ---------------------------------------------------------------------------
INSERT INTO properties AS pr (
    legacy_cust_number, payer_label, site_address, site_city, site_state, site_zip,
    county_id, county_raw, town, plss_section, plss_range, parcel_id, permit_number,
    system_type_id, tank_location_note, jobsite_location_note, pump_style_note,
    chamber_pump_note, system_condition_note,
    baffle_inlet_material_id, baffle_inlet_date,
    baffle_outlet_material_id, baffle_outlet_date,
    hose_count, pump_installed_date, reminder_opt_out, status, legacy_memo
)
SELECT
    c.cust_number::int,
    nullif(btrim(concat_ws(', ', pg_temp.clean(c.cust_last_name),
                                pg_temp.clean(c.cust_first_name))), ''),
    pg_temp.clean(c.cust_address),
    pg_temp.clean(c.cust_city),
    pg_temp.clean(c.cust_state),
    pg_temp.clean(c.cust_zip),
    ca.county_id,
    nullif(btrim(c.county), ''),
    pg_temp.clean(c.town),
    pg_temp.clean(c.section),
    pg_temp.clean(c.range),
    pg_temp.clean(c.parcel),
    pg_temp.clean(c.permit_number),
    st.id,
    pg_temp.clean(c.tank_location),
    pg_temp.clean(c.job_site_location),
    pg_temp.clean(c.style_of_pump),
    pg_temp.clean(c.chamber_pump_info),
    pg_temp.clean(c.septic_condition),
    bi.id,
    pg_temp.wb_date(c.baffles_inlet_date),
    bo.id,
    pg_temp.wb_date(c.baffles_outlet_date),
    pg_temp.num(c.no_of_hoses),
    pg_temp.wb_date(c.pump_installed_date),
    lower(coalesce(c.don_t_send_reminder, '')) = 'true',
    CASE WHEN EXISTS (SELECT 1 FROM legacy.tblcustdumplog d
                      WHERE d.cust_number = c.cust_number)
         THEN 'active'::property_status ELSE 'unknown'::property_status END,
    nullif(btrim(c.memo), '')
FROM legacy.tblcustomers c
LEFT JOIN county_alias ca        ON ca.alias = nullif(btrim(c.county), '')
LEFT JOIN septic_system_types st ON st.name  = pg_temp.clean(c.septic_system_type)
LEFT JOIN baffle_materials bi    ON bi.name  = pg_temp.baffle_canonical(pg_temp.clean(c.baffles_inlet_material))
LEFT JOIN baffle_materials bo    ON bo.name  = pg_temp.baffle_canonical(pg_temp.clean(c.baffles_outlet_material))
WHERE coalesce(c.cust_number, '') <> ''
ON CONFLICT (legacy_cust_number) DO UPDATE SET
    payer_label   = EXCLUDED.payer_label,
    site_address  = EXCLUDED.site_address,
    site_city     = EXCLUDED.site_city,
    site_state    = EXCLUDED.site_state,
    site_zip      = EXCLUDED.site_zip,
    county_id     = EXCLUDED.county_id,
    county_raw    = EXCLUDED.county_raw,
    town          = EXCLUDED.town,
    plss_section  = EXCLUDED.plss_section,
    plss_range    = EXCLUDED.plss_range,
    parcel_id     = EXCLUDED.parcel_id,
    permit_number = EXCLUDED.permit_number,
    system_type_id = EXCLUDED.system_type_id,
    tank_location_note  = EXCLUDED.tank_location_note,
    jobsite_location_note = EXCLUDED.jobsite_location_note,
    pump_style_note     = EXCLUDED.pump_style_note,
    chamber_pump_note   = EXCLUDED.chamber_pump_note,
    system_condition_note = EXCLUDED.system_condition_note,
    baffle_inlet_material_id = EXCLUDED.baffle_inlet_material_id,
    baffle_inlet_date        = EXCLUDED.baffle_inlet_date,
    baffle_outlet_material_id = EXCLUDED.baffle_outlet_material_id,
    baffle_outlet_date       = EXCLUDED.baffle_outlet_date,
    hose_count        = EXCLUDED.hose_count,
    pump_installed_date = EXCLUDED.pump_installed_date,
    reminder_opt_out  = EXCLUDED.reminder_opt_out,
    status            = EXCLUDED.status,
    legacy_memo       = EXCLUDED.legacy_memo;

-- ---------------------------------------------------------------------------
-- property_ownerships — the link the legacy app stored as a billing_number column on
-- the customer row. One payer can cover several properties.
--
-- This is a dated link with an open end rather than a foreign key on properties,
-- because ownership changing is a real recorded event that must not overwrite the
-- fact that someone else owned it before (SCH-06).
--
-- is_primary is true everywhere: the legacy model had exactly one billing
-- relationship per property, so there is no second-owner concept to preserve.
--
-- There is no natural key here to upsert against, which is why 00_reset.sql clears
-- the ETL's own rows first. Without that, a second run doubles every link.
-- ---------------------------------------------------------------------------
INSERT INTO property_ownerships (payer_id, property_id, is_primary, ownership_start, source)
SELECT py.id, pr.id, true, pg_temp.wb_date(c.contract_date), 'legacy'
FROM legacy.tblcustomers c
JOIN payers py     ON py.legacy_billing_no  = nullif(btrim(c.billing_number), '')::int
JOIN properties pr ON pr.legacy_cust_number = c.cust_number::int
WHERE coalesce(c.billing_number, '') <> ''
  AND NOT EXISTS (
      SELECT 1 FROM property_ownerships x
      WHERE x.payer_id = py.id AND x.property_id = pr.id AND x.source = 'legacy'
  );
