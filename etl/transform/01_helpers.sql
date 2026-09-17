-- 000  Parse helpers.
-- =============================================================================
-- Defined in pg_temp so they disappear when the session ends: they are part of the
-- transform, not part of the schema the application sees. ETL-06 asks for transforms
-- in SQL, and a parse rule repeated forty times across five files is not reviewable —
-- one definition each, referenced everywhere, is.
--
-- Every one of these returns NULL rather than raising. A single bad cell must land in
-- import_quarantine with its reason (LED-05), not abort a 48,216-row load.

CREATE FUNCTION pg_temp.clean(t text) RETURNS text AS $$
    -- Collapse the whitespace an Access memo carries, and turn '' into nothing.
    SELECT nullif(btrim(regexp_replace(t, '\s+', ' ', 'g')), '');
$$ LANGUAGE sql IMMUTABLE STRICT;

CREATE FUNCTION pg_temp.num(t text) RETURNS numeric AS $$
BEGIN
    -- 2,291 hose counts are written with the fraction glyph: '2½' means 2.5.
    -- Money is written with a currency mark and thousands separators — '$250.00'
    -- and '$1,234.56' — because tblInvoiceAmount.price was formatted for a printed
    -- invoice, not for a database. All 6,590 line prices carry the '$'.
    IF t IS NULL OR btrim(t) = '' THEN
        RETURN NULL;
    END IF;
    BEGIN
        RETURN ('0' || replace(replace(replace(btrim(t), '½', '.5'), '$', ''), ',', ''))::numeric;
    EXCEPTION WHEN others THEN
        RETURN NULL;
    END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE FUNCTION pg_temp.wb_date(t text) RETURNS date AS $$
DECLARE
    m text[];
BEGIN
    -- Legacy dates are m/d/yyyy. to_date() is forgiving to the point of being
    -- dishonest — it turns 13/45/2020 into a real date — so the parts are checked
    -- and the result is built by casting an ISO string, which does raise on 2/30.
    m := regexp_match(btrim(coalesce(t, '')), '^([0-9]{1,2})/([0-9]{1,2})/([0-9]{4})$');
    IF m IS NULL
       OR m[3]::int NOT BETWEEN 1900 AND 2100
       OR m[1]::int NOT BETWEEN 1 AND 12
       OR m[2]::int NOT BETWEEN 1 AND 31 THEN
        RETURN NULL;
    END IF;
    RETURN (m[3] || '-' || lpad(m[1], 2, '0') || '-' || lpad(m[2], 2, '0'))::date;
EXCEPTION WHEN others THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE FUNCTION pg_temp.wb_date_paid(t text) RETURNS date AS $$
DECLARE
    d date;
BEGIN
    -- tblInvoices.Date Paid is '18-Dec-18': day, three-letter month, 2-digit year.
    -- 80 rows are blank, which means unpaid rather than a missing value.
    --
    -- The format mask is 'DD-Mon-YY' and nothing else. An earlier revision of this
    -- function used 'FMMM/Mon/YY', which expects month-first with slash separators,
    -- and it parsed 0 of 3,203 populated dates — a silent total failure that looked
    -- like clean data, because a function that returns NULL for everything is
    -- indistinguishable from a column that is empty unless someone counts.
    --
    -- Postgres resolves the 2-digit year on a sliding window (69-99 -> 19xx,
    -- 00-68 -> 20xx), which suits this corpus: every invoice falls in 2015-2026.
    -- The round trip is the guard. to_date() is forgiving enough to accept
    -- '31-Dec-185' and invent a year, so the value is only trusted when
    -- re-rendering it produces the string that came in.
    IF t IS NULL OR btrim(t) = '' THEN
        RETURN NULL;
    END IF;
    d := to_date(btrim(t), 'DD-Mon-YY');
    IF to_char(d, 'DD-Mon-YY') = btrim(t) THEN
        RETURN d;
    END IF;
    RETURN NULL;
EXCEPTION WHEN others THEN
    -- '32-Dec-18' raises here rather than returning a date that never was.
    RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE FUNCTION pg_temp.wb_time(t text) RETURNS time AS $$
DECLARE
    x text := lower(btrim(coalesce(t, '')));
BEGIN
    IF x = '' THEN
        RETURN NULL;
    END IF;
    x := replace(x, 'am', '');
    x := replace(x, 'pm', '');
    x := btrim(x);
    IF x !~ '^[0-9]{1,2}(:[0-9]{1,2}(:[0-9]{1,2})?)?$' THEN
        RETURN NULL;
    END IF;
    RETURN x::time;
EXCEPTION WHEN others THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE FUNCTION pg_temp.baffle_canonical(t text) RETURNS text AS $$
    -- The design doc names six materials; these are the only collapses made.
    -- Anything else keeps its own spelling rather than being forced into a bucket.
    -- Order matters: 'cast iron' before a bare 'iron', ABS before letters that
    -- appear inside 'fibreglass'.
    SELECT CASE
        WHEN t ~* 'cast\s*iron'                               THEN 'Cast iron'
        WHEN t ~* 'fibreglass|fiberglass|fibre\s*glass|fiber' THEN 'Fibreglass'
        WHEN t ~* '\bpvc\b'                                   THEN 'PVC'
        WHEN t ~* 'concrete'                                  THEN 'Concrete'
        WHEN t ~* '\bclay\b'                                  THEN 'Clay'
        WHEN t ~* '\babs\b|acrylonitrile'                     THEN 'ABS'
        ELSE t
    END;
$$ LANGUAGE sql IMMUTABLE STRICT;
