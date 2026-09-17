-- 006  Billing: invoices, their lines, and the payments recorded against them.
-- =============================================================================
-- Sources: tblInvoices (3,283), tblInvoiceAmount (6,590 lines), tblInvoiceDetails
-- (99 product descriptions), tblInspectionDate.
--
-- Measured before writing this file:
--   invoices   3,283 | 32 blank invoice_date | 1 impossible (5/18/2393)
--                    | 0 orphan cust_number | 0 duplicate invoice numbers
--                    | 1 where amount_paid > invoice_total (19208: 1256 vs 125)
--   lines      6,590 | 3,120 orphaned | every price carries a leading '$'
--                    | 6 negative invoice numbers | 17 of 105 codes unknown
--
-- Two helper bugs were found getting these numbers and are fixed in 01_helpers.sql:
-- num() could not read '$250.00' so it returned NULL for all 6,590 prices, and
-- wb_date_paid() used the wrong format mask and parsed 0 of 3,203 populated dates.
-- Both failed silently, because a function that returns NULL for everything is
-- indistinguishable from a column that is empty unless somebody counts.

SET search_path TO septic_app, pg_catalog;

-- ---------------------------------------------------------------------------
-- Invoices.
--
-- A legacy invoice row carries the customer, so the property comes from
-- legacy_cust_number and the payer through the ownership link. payer_id is NOT
-- NULL, so an invoice that cannot be attributed to a payer is quarantined rather
-- than attached to a plausible one.
--
-- status is derived from the money, not copied: 'paid' when the amount paid covers
-- the total, otherwise 'open'. The legacy app had no status column to be wrong.
-- ---------------------------------------------------------------------------
CREATE TABLE pg_temp.invoice_rows AS
SELECT
    row_number() OVER (ORDER BY i.ctid)                        AS row_no,
    i.ctid                                                     AS src_ctid,
    nullif(btrim(i.invoice_number), '')::int                   AS legacy_no,
    pr.id                                                      AS property_id,
    py.id                                                      AS payer_id,
    pg_temp.wb_date(i.invoice_date)                            AS invoice_date,
    i.invoice_date                                             AS invoice_date_raw,
    pg_temp.num(i.sub_total)                                   AS subtotal,
    pg_temp.num(i.invoice_total)                               AS total,
    coalesce(pg_temp.num(i.invoice_amount_paid), 0)            AS amount_paid,
    pg_temp.wb_date_paid(i.date_paid)                          AS paid_at,
    i."check"                                                  AS check_raw,
    se.id                                                      AS service_event_id
FROM legacy.tblinvoices i
LEFT JOIN properties pr           ON pr.legacy_cust_number = nullif(btrim(i.cust_number), '')::int
LEFT JOIN property_ownerships po  ON po.property_id = pr.id AND po.source = 'legacy'
LEFT JOIN payers py               ON py.id = po.payer_id
LEFT JOIN service_events se       ON se.property_id = pr.id
                                AND se.service_date = pg_temp.wb_date(i.service_pumped_date);

-- Quarantine: no date, no payer, or money that contradicts itself.
INSERT INTO import_quarantine (source_file, row_no, raw, reason)
SELECT 'tblInvoices', e.row_no, to_jsonb(i),
       CASE WHEN e.invoice_date IS NULL
                 THEN 'invoice_date_missing_or_impossible: '
                      || coalesce(nullif(btrim(e.invoice_date_raw), ''), '<blank>')
            WHEN e.payer_id IS NULL
                 THEN 'invoice_has_no_payer: cust_number '
                      || coalesce(nullif(btrim(i.cust_number), ''), '<blank>')
            WHEN e.amount_paid > coalesce(e.total, 0) + 0.01
                 THEN 'amount_paid_exceeds_total: paid ' || e.amount_paid
                      || ' of ' || coalesce(e.total, 0)::text
       END
FROM pg_temp.invoice_rows e
JOIN legacy.tblinvoices i ON i.ctid = e.src_ctid
WHERE e.invoice_date IS NULL OR e.payer_id IS NULL
   OR e.amount_paid > coalesce(e.total, 0) + 0.01;

INSERT INTO invoices (
    legacy_invoice_no, payer_id, property_id, service_event_id, invoice_date,
    subtotal, tax_amount, total, amount_paid, status
)
SELECT
    e.legacy_no, e.payer_id, e.property_id, e.service_event_id, e.invoice_date,
    -- Disposal Fee, Tax Amount and DNR Service Fee are literally 0 in every legacy
    -- row, so tax_amount stays 0 rather than being back-calculated from the total.
    coalesce(e.subtotal, e.total, 0), 0,
    coalesce(e.total, 0), e.amount_paid,
    CASE WHEN e.amount_paid >= coalesce(e.total, 0) - 0.01 THEN 'paid'::invoice_status
         ELSE 'open'::invoice_status END
FROM pg_temp.invoice_rows e
WHERE e.invoice_date IS NOT NULL AND e.payer_id IS NOT NULL
  AND e.amount_paid <= coalesce(e.total, 0) + 0.01
ON CONFLICT (legacy_invoice_no) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Lines, and the 3,120 that belong to no invoice (BIL-03).
--
-- Every orphan is quarantined with a reason naming WHERE its number sits, because
-- that is what tells a human whether it is recoverable:
--
--   negative_invoice_number     6   Access subform drafts, never committed
--   below_window            1,709   before the first surviving invoice
--   in_gap                  1,404   inside a hole in the surviving sequence
--   past_max                    1   after the last one
--
-- None is attached to a nearest invoice. A line placed on the wrong invoice is a
-- fabricated billing record, and 2,933 distinct missing invoice numbers is not a
-- rounding error — it is most of the invoice history, exported separately from the
-- table holding its headers.
--
-- quantity is 1 everywhere: the source stores one price per line and no count, so
-- inventing a quantity would change the total. unit_price and amount are therefore
-- the same number, which is what the source actually says.
-- ---------------------------------------------------------------------------
CREATE TABLE pg_temp.line_rows AS
SELECT
    row_number() OVER (ORDER BY a.ctid)                        AS row_no,
    a.ctid                                                     AS src_ctid,
    nullif(btrim(a.invoice_number), '')::int                   AS legacy_no,
    inv.id                                                     AS invoice_id,
    st.id                                                      AS service_type_id,
    btrim(a.invoiceproductcode)                                AS code,
    pg_temp.num(a.price)                                       AS price,
    -- Whether the header exists in the source at all. 34 invoices are quarantined
    -- for their own reasons, which strands 4 of their lines; calling those lines
    -- 'below_window' would tell a human the invoice was never exported when it was,
    -- and was merely rejected. Different fix, different conversation.
    EXISTS (SELECT 1 FROM legacy.tblinvoices li
             WHERE li.invoice_number = a.invoice_number)        AS header_in_source
FROM legacy.tblinvoiceamount a
LEFT JOIN invoices inv ON inv.legacy_invoice_no = nullif(btrim(a.invoice_number), '')::int
LEFT JOIN service_types st ON st.code = btrim(a.invoiceproductcode);

INSERT INTO import_quarantine (source_file, row_no, raw, reason)
SELECT
    'tblInvoiceAmount', e.row_no, to_jsonb(a),
    'orphan_line_' || CASE
        WHEN e.legacy_no IS NULL   THEN 'unparseable_invoice_number'
        WHEN e.legacy_no < 0       THEN 'negative_invoice_number'
        WHEN e.header_in_source    THEN 'header_quarantined'
        WHEN e.legacy_no < w.lo    THEN 'below_window'
        WHEN e.legacy_no > w.hi    THEN 'past_max'
        ELSE 'in_gap'
    END || ': invoice ' || coalesce(e.legacy_no::text, a.invoice_number)
FROM pg_temp.line_rows e
JOIN legacy.tblinvoiceamount a ON a.ctid = e.src_ctid
CROSS JOIN (SELECT coalesce(min(legacy_invoice_no), 0) AS lo,
                     coalesce(max(legacy_invoice_no), 0) AS hi FROM invoices) w
WHERE e.invoice_id IS NULL;

INSERT INTO invoice_lines (
    invoice_id, service_type_id, legacy_product_code, description,
    quantity, unit_price, amount
)
SELECT
    e.invoice_id, e.service_type_id, left(e.code, 20),
    -- Prefer the catalog description; 17 of the 105 codes are not in service_types,
    -- and for those the legacy description is the only thing that says what was sold.
    left(coalesce(dg.details, 'Invoice item ' || e.code), 255),
    1, coalesce(e.price, 0), coalesce(e.price, 0)
FROM pg_temp.line_rows e
LEFT JOIN legacy.tblinvoicedetails dg ON dg.invoiceproductcode = e.code
WHERE e.invoice_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Payments.
--
-- The legacy `Check #` column conflates the method with the reference: it holds real
-- check numbers alongside 'cc', 'cash', 'MO', 'cas' and one '79-694/759'. Those are
-- now separate facts — method is an enum, and reference is what is left of the cell
-- once the method has been read out of it.
-- ---------------------------------------------------------------------------
INSERT INTO payments (invoice_id, amount, method, reference, paid_at)
SELECT
    inv.id, e.amount_paid,
    CASE WHEN lower(btrim(e.check_raw)) IN ('cc','c.c.','credit','visa','mc')  THEN 'card'::payment_method
         WHEN lower(btrim(e.check_raw)) IN ('cash','cas')                       THEN 'cash'::payment_method
         WHEN lower(btrim(e.check_raw)) IN ('mo','m.o.','money order')         THEN 'other'::payment_method
         WHEN btrim(coalesce(e.check_raw, '')) ~ '^[0-9]+$'                     THEN 'check'::payment_method
         ELSE 'other'::payment_method END,
    -- The number, when the cell held one. A method word is not a reference.
    CASE WHEN btrim(coalesce(e.check_raw, '')) ~ '^[0-9]+$' THEN left(btrim(e.check_raw), 50)
         WHEN lower(btrim(coalesce(e.check_raw, '')))
                  IN ('cc','c.c.','credit','visa','mc','cash','cas','mo','m.o.','money order','')
              THEN NULL
         ELSE left(btrim(e.check_raw), 50) END,
    e.paid_at
FROM pg_temp.invoice_rows e
JOIN invoices inv ON inv.legacy_invoice_no = e.legacy_no
WHERE e.amount_paid > 0;

-- ---------------------------------------------------------------------------
-- Inspections. 2,771 rows recording who owned the site at the time.
-- ---------------------------------------------------------------------------
INSERT INTO inspections (property_id, inspection_date, prev_owner_first,
                         prev_owner_last, legacy_inspect_id)
SELECT
    pr.id, pg_temp.wb_date(x.inspection_date),
    pg_temp.clean(x.prev_owner_first_name), pg_temp.clean(x.prev_owner_last_name),
    nullif(btrim(x.inspect_id), '')::int
FROM legacy.tblinspectiondate x
JOIN properties pr ON pr.legacy_cust_number = nullif(btrim(x.cust_number), '')::int
WHERE pg_temp.wb_date(x.inspection_date) IS NOT NULL
  AND nullif(btrim(x.inspect_id), '') IS NOT NULL
ON CONFLICT (legacy_inspect_id) DO NOTHING;

INSERT INTO import_quarantine (source_file, row_no, raw, reason)
SELECT 'tblInspectionDate', row_number() OVER (ORDER BY x.ctid), to_jsonb(x),
       'inspection_date_unparseable: '
         || coalesce(nullif(btrim(x.inspection_date), ''), '<blank>')
FROM legacy.tblinspectiondate x
WHERE pg_temp.wb_date(x.inspection_date) IS NULL;
