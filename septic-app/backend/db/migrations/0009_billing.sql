-- 0009  Billing.
-- =============================================================================
-- Legacy AR is small and clean: $996,843.95 billed, $982,994.95 paid, $13,849.00
-- outstanding across 50 unbalanced invoices (1.5% of 3,283). Migratable in an afternoon.

SET search_path TO septic_app, pg_catalog;

CREATE TABLE invoices (
    id                serial PRIMARY KEY,
    legacy_invoice_no int UNIQUE,
    payer_id          int    NOT NULL REFERENCES payers(id)     ON DELETE RESTRICT,
    property_id       int    REFERENCES properties(id)         ON DELETE SET NULL,
    service_event_id  bigint REFERENCES service_events(id)     ON DELETE SET NULL,
    invoice_date      date   NOT NULL,
    subtotal          numeric(10,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
    tax_rate          numeric(5,4)  NOT NULL DEFAULT 0 CHECK (tax_rate >= 0),
    -- Disposal Fee / Tax Amount / DNR Service Fee are literally 0 in ALL 3,283 legacy
    -- rows. The columns stay; expect no history in them.
    tax_amount        numeric(10,2) NOT NULL DEFAULT 0,
    total             numeric(10,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
    amount_paid       numeric(10,2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
    status            invoice_status NOT NULL DEFAULT 'open',
    created_at        timestamptz NOT NULL DEFAULT now(),
    CHECK (amount_paid <= total + 0.01)   -- tolerate rounding on a fully-paid invoice
);

CREATE INDEX idx_invoices_status ON invoices (status) WHERE status <> 'paid';
CREATE INDEX idx_invoices_payer  ON invoices (payer_id, invoice_date DESC);

CREATE TABLE invoice_lines (
    id                  serial PRIMARY KEY,
    invoice_id          int NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    service_type_id     int REFERENCES service_types(id) ON DELETE SET NULL,
    legacy_product_code varchar(20),
    description         varchar(255),
    quantity            numeric(8,2) NOT NULL DEFAULT 1,
    unit_price          numeric(10,2) NOT NULL DEFAULT 0,
    amount              numeric(10,2) NOT NULL DEFAULT 0
);

CREATE INDEX idx_lines_invoice ON invoice_lines (invoice_id);

-- Fixes a legacy conflation: `Check #` held the literal value 'c.c.' (cashier's
-- cheque) mixed in with real check numbers. Method and reference are now separate.
CREATE TABLE payments (
    id         serial PRIMARY KEY,
    invoice_id int NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    amount     numeric(10,2) NOT NULL CHECK (amount >= 0),
    method     payment_method NOT NULL,
    reference  varchar(50),        -- the actual check number, when there is one
    paid_at    date,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_payments_invoice ON payments (invoice_id);

CREATE TABLE inspections (
    id                serial PRIMARY KEY,
    property_id       int  NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    inspection_date   date NOT NULL,
    -- 2,771 legacy rows record who owned the site at the time of inspection.
    prev_owner_first  varchar(100),
    prev_owner_last   varchar(100),
    notes             text,
    legacy_inspect_id int UNIQUE
);

CREATE INDEX idx_inspections_property ON inspections (property_id, inspection_date DESC);
