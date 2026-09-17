-- 0013  Keep the raw county string.
-- =============================================================================
-- P3 says raw string and parsed structure are both kept, and the schema honours
-- that everywhere else: tanks.raw_text, pumpers.legacy_raw_cert,
-- service_events.cert_as_recorded, properties.legacy_memo. County was the one
-- exception, and it is the worst place to make it, because county is the field
-- with 34 spellings for 7 real counties.
--
-- Normalising into county_id without keeping the input would make DRV-11
-- ("county is stored and shown normalised, with the original spelling
-- retrievable") depend on the legacy landing zone staying in the database
-- forever. That zone is documented as scratch. A permanent requirement cannot
-- rest on it.
--
-- The 34 values are not all misspellings. Chilton, Plymouth, Empire, Byron,
-- Campbellsport, Marshfield, Springvale, Green Lake and Brothertown are
-- municipalities, not counties. Mapping those to a county means guessing where
-- the property sits, which is the inference LED-06 forbids, so they keep
-- county_id NULL and this column is what preserves them.

SET search_path TO septic_app, pg_catalog;

ALTER TABLE properties
    ADD COLUMN county_raw text;

COMMENT ON COLUMN properties.county_raw IS
    'County exactly as the legacy system recorded it. county_id is the derived '
    'value; this is the evidence it was derived from (P3). Populated by the ETL, '
    'never rewritten by the app.';
