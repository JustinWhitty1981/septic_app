-- 004  Tanks: one property, often several tanks, described in one free-text field.
-- =============================================================================
-- Source: tblCustomers.tank_size. 7,440 populated of 7,541, 1,164 distinct strings,
-- only 3,342 of them a bare number. Multi-tank is the normal case, not the edge case.
--
-- The grammar, read off the 60 most common non-numeric values:
--
--   1000                      one primary tank
--   2000 triple               capacity plus a style word (876 say 'triple', 223 'combo')
--   1500w.fltr+800 PC         two tanks: 1500 with a filter, then an 800 pre-cleanout
--   1000septic+500PC          same, no spaces
--   2-2000                    TWO tanks of 2000 — a quantity prefix (94 rows)
--   2-2000+2-1500combos       two quantities in one string
--   2200-2600 total           a RANGE, not a quantity. Two of these exist.
--   2-500 + 75 D              a distribution box trailing the real tanks
--
-- The quantity prefix and the range are separated by one clean fact: a quantity is a
-- single digit followed by a dash ('2-2000'), while a range has several digits before
-- the dash ('2200-2600'). '^([1-6])\s*-\s*([0-9]{2,})' matches the first and not the
-- second, which is the whole difference and is why this parser can be a rule rather
-- than a lookup table of 1,164 special cases.
--
-- Nothing is rejected here. ETL-03 asks for the string to be parsed AND preserved, so
-- every non-blank value yields at least one row carrying raw_text, and a string with
-- no digits at all (there are 11) still gets a row with capacity left null. Dropping
-- the awkward ones would make the count look clean and the data wrong.

SET search_path TO septic_app, pg_catalog;

-- ---------------------------------------------------------------------------
-- Split on '+', one part per tank, keeping the position so sequence_no survives.
--
-- The temp tables here are named tank_parts / tank_rows, never tanks. Postgres
-- searches the session's temporary schema before anything else regardless of
-- search_path, so a temp table called `tanks` shadows septic_app.tanks: the
-- INSERT below would silently target the six-column temp table and fail with
-- 'column capacity_gallons does not exist' while information_schema cheerfully
-- reports that the real column is there. Cost me a wrong conclusion that the
-- migration contained a typo, which it did not.
-- ---------------------------------------------------------------------------
CREATE TABLE pg_temp.tank_parts AS
SELECT
    pr.id                                   AS property_id,
    p.ord                                   AS part_ord,
    btrim(p.part)                           AS part,
    -- Quantity prefix: single digit, dash, then the real capacity.
    (regexp_match(btrim(p.part), '^([1-6])\s*-\s*([0-9]{2,})'))  AS qty
FROM legacy.tblcustomers c
JOIN properties pr ON pr.legacy_cust_number = c.cust_number::int
CROSS JOIN LATERAL regexp_split_to_table(btrim(c.tank_size), '\+')
                     WITH ORDINALITY p(part, ord)
WHERE btrim(coalesce(c.tank_size, '')) <> ''
  AND btrim(p.part) <> '';

-- ---------------------------------------------------------------------------
-- Decide capacity, role and filter per part, then expand the quantity prefixes.
--
-- Capacity is the first integer in the part. That is correct for every value in the
-- corpus: '1500w.fltr' is 1500, '75 D' is 75, and for a quantity part the digits
-- after the dash are the capacity, not the ones before it.
--
-- Role is positional except for a pre-cleanout, which is named. The first tank that
-- is not a pre-cleanout is the primary; later ones are secondary. 'sand_filter' is in
-- the enum and the corpus never uses it (0 rows), so it is not inferred from anything.
--
-- The primary is found by taking the minimum (part_ord, copy) among the parts that
-- are not pre-cleanouts. Postgres has no min() over an anonymous record, so the pair
-- is folded into one sortable integer: part_ord dominates and copy is bounded by the
-- quantity prefix, which tops out at 6 in this corpus. A window function inside a
-- CASE inside another window function is the alternative, and that reads plausibly
-- and fails to parse.
-- ---------------------------------------------------------------------------
CREATE TABLE pg_temp.tank_rows AS
WITH expanded AS (
    SELECT
        t.property_id, t.part_ord, g.copy, t.part,
        -- NULL rather than 0: CHECK (capacity_gallons > 0) rejects 0, and a string
        -- with no number in it does not mean a tank of zero size.
        CASE WHEN t.capacity <= 0 THEN NULL ELSE t.capacity END AS capacity,
        t.has_filter, t.is_pre_cleanout
    FROM (
        SELECT
            property_id, part_ord, part,
            coalesce((qty[2])::int,
                     (regexp_match(part, '[0-9]+'))[1]::int)  AS capacity,
            (qty[1])::int                                      AS copies,
            lower(part) ~ 'fltr|filter'                        AS has_filter,
            -- 'PC' as a token, not inside a word. Two traps here:
            --   * Postgres regex has no \b. It uses \y for a word boundary, and \b
            --     silently means something else, so '\bPC\b' matches nothing at all
            --     and every pre-cleanout became 'secondary' without any error.
            --   * \y is no good either: '800PC' has no boundary between '0' and 'P',
            --     because digits and letters are both word characters.
            -- Requiring a non-letter before the PC covers '800 PC', '800PC' and
            -- '1000septic+500PC' while still refusing to match inside a real word.
            upper(part) ~ '(^|[^A-Z])PC($|[^A-Z])|PRE\s*-?\s*CLEAN' AS is_pre_cleanout,
            qty
        FROM pg_temp.tank_parts
    ) t
    CROSS JOIN LATERAL generate_series(1, coalesce(t.copies, 1)) AS g(copy)
),
ranked AS (
    SELECT e.*,
           row_number() OVER (PARTITION BY property_id
                              ORDER BY part_ord, copy)          AS sequence_no,
           min(CASE WHEN NOT is_pre_cleanout
                    THEN e.part_ord * 1000 + e.copy END)
               OVER (PARTITION BY property_id)                  AS first_normal
    FROM expanded e
)
SELECT
    property_id, sequence_no, capacity, has_filter, part AS raw_text,
    CASE WHEN is_pre_cleanout                                THEN 'pre_cleanout'::tank_role
         WHEN first_normal IS NOT NULL
              AND part_ord * 1000 + copy = first_normal       THEN 'primary'::tank_role
         ELSE 'secondary'::tank_role
    END AS role
FROM ranked
WHERE sequence_no <= 20;   -- a sane ceiling; the widest real string makes 6

INSERT INTO tanks (property_id, sequence_no, role, capacity_gallons, has_filter, raw_text)
SELECT property_id, sequence_no, role, capacity, has_filter, left(raw_text, 100)
FROM pg_temp.tank_rows
ON CONFLICT (property_id, sequence_no) DO NOTHING;
