-- 005  The service ledger: 48,216 pump-outs, the regulatory record of the business.
-- =============================================================================
-- Source: legacy.tblcustdumplog. This is the file the whole rebuild exists for — the
-- old app had no equivalent table, only a calendar and a state report holding
-- pre-computed counters.
--
-- Measured against the landed corpus before this file was written:
--   48,216 rows | 2 unparseable dates | 0 blank dates | 0 blank cust_number
--   0 cust_numbers missing from tblCustomers | 0 duplicate (property, date) pairs
--   0 dates after today | gallons blank on 19,202 | 4,685 unmatched certifications
--   70 unmatched waste types | 0 unmatched disposal sites | 45,251 no disposal site
--
-- The blank-gallon rows are LOADED, not quarantined. LED-04: a pump-out with no
-- gallons is allowed and flagged, not rejected. Quarantining them would have thrown
-- away 40% of the ledger and quietly emptied the due queue this exercise exists to
-- feed — the property was serviced, the crew simply never typed a number.

SET search_path TO septic_app, pg_catalog;

-- ---------------------------------------------------------------------------
-- Parse once into a temp table, then let load and quarantine read the same verdict.
--
-- Evaluating the parse inline in two separate INSERTs would run every expression
-- twice and allow the two halves to disagree about what a row means. One parse, two
-- consumers. src_ctid is carried through so the quarantined rows can be joined back
-- to their untouched landing row for the raw JSON, rather than re-derived.
--
-- row_no is physical order. The loader COPYs each CSV in line order and nothing has
-- updated these tables, so ctid order still equals file order. That is good enough to
-- point a human at a line in the original file; it is not a key, and a FULL VACUUM
-- would invalidate it. The preserved raw text is what actually matters.
-- ---------------------------------------------------------------------------
CREATE TABLE pg_temp.event_rows AS
SELECT
    d.ctid                                                     AS src_ctid,
    row_number() OVER (ORDER BY d.ctid)                        AS row_no,
    nullif(btrim(d.cust_number), '')::int                      AS cust_number,
    pr.id                                                      AS property_id,
    pg_temp.wb_date(d.service_pumped_date)                     AS service_date,
    d.service_pumped_date                                      AS service_date_raw,
    pg_temp.num(d.actualgallonspumped)                         AS gallons,
    wt.id                                                      AS waste_type_id,
    ds.id                                                      AS disposal_site_id,
    p.id                                                       AS pumper_id,
    pg_temp.clean(d.certification_number)                      AS cert_raw,
    pg_temp.clean(d.disposal_method)                           AS disposal_method,
    pg_temp.wb_date(d.disposal_date)                           AS disposal_date,
    pg_temp.clean(d.dnr_permit)                                AS dnr_permit,
    pg_temp.num(d.ph_adj_before)                               AS ph_before,
    pg_temp.num(d.ph_adj_after)                                AS ph_after,
    pg_temp.num(d.time_mins)::int                              AS duration_minutes,
    pg_temp.wb_date(d.county_form_date)                        AS county_form_date,
    d.type_of_waste                                            AS waste_raw
FROM legacy.tblcustdumplog d
LEFT JOIN properties pr     ON pr.legacy_cust_number = nullif(btrim(d.cust_number), '')::int
LEFT JOIN pumpers p         ON p.legacy_raw_cert     = pg_temp.clean(d.certification_number)
LEFT JOIN waste_types wt    ON wt.name               = pg_temp.clean(d.type_of_waste)
LEFT JOIN disposal_sites ds ON ds.name               = pg_temp.clean(d.disposal_site);

CREATE INDEX ON pg_temp.event_rows (src_ctid);

-- ---------------------------------------------------------------------------
-- Quarantine first (LED-05): a rejected row keeps its original text and a reason.
--
-- Only two rows fail, and they fail on the one thing the table cannot be without: a
-- service_events row with no service_date is not a record of anything. Everything
-- else that looks wrong is a NULL in a nullable column, not a rejection.
-- ---------------------------------------------------------------------------
INSERT INTO import_quarantine (source_file, row_no, raw, reason)
SELECT
    'tblCustDumpLog', e.row_no, to_jsonb(d),
    CASE WHEN e.property_id IS NULL AND e.service_date IS NULL
              THEN 'missing_property_and_service_date'
         WHEN e.property_id IS NULL
              THEN 'property_not_found: cust_number ' || coalesce(e.cust_number::text, '<blank>')
         WHEN e.service_date IS NULL
              THEN 'service_date_unparseable: '
                   || coalesce(nullif(btrim(e.service_date_raw), ''), '<blank>')
    END
FROM pg_temp.event_rows e
JOIN legacy.tblcustdumplog d ON d.ctid = e.src_ctid
WHERE e.property_id IS NULL OR e.service_date IS NULL;

-- ---------------------------------------------------------------------------
-- Load.
--
-- status is 'completed' for every row: the newest service date in the corpus is
-- 2026-06-27 and no date is in the future, so nothing here is still scheduled. A
-- 'scheduled' row can only ever come from the app, never from this file.
--
-- cert_unresolved is the honest answer to a question the source cannot answer. 4,685
-- events carry a certification matching none of the seven known pumpers, and 4,650 of
-- those are the single value '6043' spanning 1988-2023 — a real pumper whose name the
-- export lost, not a typo to correct. The number survives verbatim in
-- cert_as_recorded and the link stays null. Guessing which human did it would put a
-- false name on a regulatory record.
--
-- Four landing columns have nowhere to go and are recorded rather than dropped in
-- silence: service_time and disposal_time (a time of day with no date attached is
-- not a timestamp), and slurry_date / slurry_time (0 of 48,216 populated).
-- next_service_pump_date is ignored on purpose — P1 makes the due date arithmetic.
-- ---------------------------------------------------------------------------
INSERT INTO service_events (
    property_id, performed_by_pumper_id, cert_unresolved, cert_as_recorded,
    service_date, status, gallons_pumped, waste_type_id, waste_note,
    disposal_site_id, disposal_method, disposal_date, dnr_permit_number,
    ph_before, ph_after, duration_minutes, county_form_date, source
)
SELECT
    e.property_id, e.pumper_id,
    (e.pumper_id IS NULL AND e.cert_raw IS NOT NULL),
    left(e.cert_raw, 20),
    e.service_date, 'completed', e.gallons, e.waste_type_id,
    -- P4: an unmatched waste description stays as the text it arrived as rather than
    -- being forced into the nearest existing type. 70 rows.
    CASE WHEN e.waste_type_id IS NULL THEN pg_temp.clean(e.waste_raw) END,
    e.disposal_site_id, left(e.disposal_method, 50), e.disposal_date,
    left(e.dnr_permit, 30), e.ph_before, e.ph_after, e.duration_minutes,
    e.county_form_date, 'legacy_import'
FROM pg_temp.event_rows e
WHERE e.property_id IS NOT NULL AND e.service_date IS NOT NULL
ON CONFLICT (property_id, service_date) DO NOTHING;
