-- 001  Lookups. docs/REQUIREMENTS.md ETL-04, ETL-06.
-- =============================================================================
-- Every statement here is a set-based INSERT…SELECT, reviewable in one screen and
-- transactional with the rest of the load. Nothing is normalised by a heuristic that
-- is not written down: if a value is a guess, it is not in this file.

SET search_path TO septic_app, pg_catalog;

-- ---------------------------------------------------------------------------
-- pumpers: 7 rows from tblOwner. The certification number is printed on every
-- service record and every state filing, so it is the real key.
--
-- Cert '0' is the legacy placeholder for "we did not record who pumped it". The
-- migration that created this table already ruled on it: imported INACTIVE so the
-- 2,173 events carrying it still resolve by foreign key, without a phantom employee
-- appearing in a driver-facing picker as if he were real.
-- ---------------------------------------------------------------------------
INSERT INTO pumpers AS p (
    certification_number, license_number, first_name, last_name,
    company, phone, is_active, legacy_raw_cert, notes
)
SELECT
    o.certification_number,
    nullif(o.license_number, ''),
    coalesce(nullif(o.first_name, ''), 'Unknown'),
    coalesce(nullif(o.last_name,  ''), 'Unknown'),
    nullif(o.company, ''),
    nullif(o.phone_number, ''),
    o.certification_number <> '0',
    o.certification_number,
    CASE WHEN o.certification_number = '0' THEN
        'Legacy placeholder for an unattributed service. Not a person. '
        || 'Kept so historical rows resolve; never selectable for new work.'
    END
FROM legacy.tblowner o
WHERE coalesce(o.certification_number, '') <> ''
ON CONFLICT (certification_number) DO UPDATE SET
    license_number  = EXCLUDED.license_number,
    first_name      = EXCLUDED.first_name,
    last_name       = EXCLUDED.last_name,
    company         = EXCLUDED.company,
    phone           = EXCLUDED.phone,
    is_active       = EXCLUDED.is_active,
    legacy_raw_cert = EXCLUDED.legacy_raw_cert;

-- ---------------------------------------------------------------------------
-- waste_types: the 9 values the legacy app offered as a dropdown. The 65 values
-- actually typed into service records are NOT loaded here — P4 puts a controlled
-- vocabulary and a free-text note side by side, so anything outside this spine goes
-- to service_events.waste_note instead of polluting the vocabulary.
--
-- is_dnr_permitted is left false on purpose. These are the values the legacy app
-- called DNR-ish, but the permit status of a disposal medium is a regulatory claim
-- and the source cannot support it. The business has to tick them.
-- ---------------------------------------------------------------------------
INSERT INTO waste_types (name, is_dnr_permitted, is_legacy_lookup)
SELECT DISTINCT trim(w.types_of_waste), false, true
FROM legacy.tblwastetypes w
WHERE coalesce(trim(w.types_of_waste), '') <> ''
ON CONFLICT (name) DO UPDATE SET is_legacy_lookup = true;

-- ---------------------------------------------------------------------------
-- service_types: the 99-code legacy catalog. 17 codes are referenced by invoice
-- lines but defined nowhere; those are left to be created by whoever bills for them
-- rather than invented from a code with no description.
-- ---------------------------------------------------------------------------
INSERT INTO service_types (code, description, is_active, is_legacy_catalog)
SELECT DISTINCT trim(d.invoiceproductcode), nullif(trim(d.details), ''), true, true
FROM legacy.tblinvoicedetails d
WHERE coalesce(trim(d.invoiceproductcode), '') <> ''
ON CONFLICT (code) DO UPDATE SET
    description = COALESCE(EXCLUDED.description, service_types.description),
    is_legacy_catalog = true;

-- ---------------------------------------------------------------------------
-- counties and county_alias — ETL-04.
--
-- 34 distinct strings, 7 real Wisconsin counties. This mapping is deliberately
-- conservative: it covers case, spacing and typographic variants of a county name
-- and nothing else.
--
-- It does NOT resolve Chilton, Plymouth, Empire, Byron, Campbellsport, Marshfield,
-- Springvale, Green Lake or Brothertown. Those are municipalities, not counties.
-- Resolving them means deciding where each property sits, which is a geographic
-- claim the source does not make — LED-06 says flag, never guess. They keep
-- county_id NULL and properties.county_raw keeps what was typed.
-- ---------------------------------------------------------------------------
WITH map (raw, canonical) AS (
    VALUES
    -- Fond du Lac: 5,729 correct, plus 13 corruptions of the same two words.
    ('Fond du Lac',     'Fond du Lac'), ('FOND DU LAC',    'Fond du Lac'),
    ('fond du lac',     'Fond du Lac'), ('Fond du lac',    'Fond du Lac'),
    ('Fond du  Lac',    'Fond du Lac'), ('Fond duLac',     'Fond du Lac'),
    ('Fond d u Lac',    'Fond du Lac'), ('Fond d Lac',     'Fond du Lac'),
    ('Fond du Lad',     'Fond du Lac'), ('Fondd du Lac',   'Fond du Lac'),
    ('Fonf du Lac',     'Fond du Lac'), ('Foind du Lac',   'Fond du Lac'),
    ('Fond du L41276ac','Fond du Lac'), ('FDL',            'Fond du Lac'),
    -- One typo each.
    ('Calmet',          'Calumet'),   ('Calumet',   'Calumet'),
    ('SheboygaN',       'Sheboygan'), ('Sheboygan', 'Sheboygan'),
    ('Mantiowoc',       'Manitowoc'), ('Manitowoc', 'Manitowoc'),
    ('Winnegbago',      'Winnebago'), ('Winnebago', 'Winnebago'),
    ('Dodge',           'Dodge'),     ('Washington','Washington')
)
INSERT INTO counties (name)
SELECT DISTINCT canonical FROM map
ON CONFLICT (name) DO NOTHING;

-- source is varchar(20): it names the file, not the path. The directory is fixed.
INSERT INTO county_alias (alias, county_id, source)
SELECT m.raw, c.id, '02_lookups.sql'
FROM (VALUES
    ('Fond du Lac','Fond du Lac'),('FOND DU LAC','Fond du Lac'),('fond du lac','Fond du Lac'),
    ('Fond du lac','Fond du Lac'),('Fond du  Lac','Fond du Lac'),('Fond duLac','Fond du Lac'),
    ('Fond d u Lac','Fond du Lac'),('Fond d Lac','Fond du Lac'),('Fond du Lad','Fond du Lac'),
    ('Fondd du Lac','Fond du Lac'),('Fonf du Lac','Fond du Lac'),('Foind du Lac','Fond du Lac'),
    ('Fond du L41276ac','Fond du Lac'),('FDL','Fond du Lac'),
    ('Calmet','Calumet'),('Calumet','Calumet'),
    ('SheboygaN','Sheboygan'),('Sheboygan','Sheboygan'),
    ('Mantiowoc','Manitowoc'),('Manitowoc','Manitowoc'),
    ('Winnegbago','Winnebago'),('Winnebago','Winnebago'),
    ('Dodge','Dodge'),('Washington','Washington')
) AS m (raw, canonical)
JOIN counties c ON c.name = m.canonical
ON CONFLICT (alias) DO UPDATE SET
    county_id = EXCLUDED.county_id,
    source    = EXCLUDED.source;

-- ---------------------------------------------------------------------------
-- The remaining vocabularies are loaded verbatim rather than curated.
--
-- 100 septic system types, 105 disposal sites, 282 baffle strings. The design doc
-- says each "needs curation" but names no target list, and inventing one would be a
-- decision dressed up as a transform. Loading them as-is loses nothing and leaves
-- curation as a visible act for the people who know what a "2000 triple" is.
-- Baffles are the exception: the doc does name six, so the confident keyword
-- collapses are made and everything else keeps its own row.
-- ---------------------------------------------------------------------------
INSERT INTO septic_system_types (name, is_standard)
SELECT DISTINCT trim(septic_system_type), false
FROM legacy.tblcustomers
WHERE coalesce(trim(septic_system_type), '') <> ''
ON CONFLICT (name) DO NOTHING;

INSERT INTO disposal_sites (name, accepts_slurry)
SELECT DISTINCT trim(disposal_site), false
FROM legacy.tblcustdumplog
WHERE coalesce(trim(disposal_site), '') <> ''
ON CONFLICT (name) DO NOTHING;

-- Keyword collapse for baffles. Order matters: 'cast iron' before a bare 'iron',
-- and ABS before anything that could read letters out of 'fibreglass'.
WITH raw_materials (value) AS (
    SELECT DISTINCT trim(v) FROM (
        SELECT baffles_inlet_material  AS v FROM legacy.tblcustomers
        UNION
        SELECT baffles_outlet_material AS v FROM legacy.tblcustomers
    ) s WHERE coalesce(trim(v), '') <> ''
),
resolved AS (
    SELECT value, pg_temp.baffle_canonical(value) AS canonical
    FROM raw_materials
)
INSERT INTO baffle_materials (name)
SELECT DISTINCT canonical FROM resolved
ON CONFLICT (name) DO NOTHING;
