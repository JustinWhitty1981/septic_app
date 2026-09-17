-- 0005  Who receives the bill, and who owns the site.
-- =============================================================================
-- These are genuinely different things and legacy conflated them: the person at the
-- address (Cust*) and the person who gets the invoice (Billing*) are often different
-- people, and 2,771 inspection rows record a *previous* owner.

SET search_path TO septic_app, pg_catalog;

-- Source: tblBilling (7,572) + tblInspectionDate.PrevOwner* (2,771).
--
-- READ THIS BEFORE BUILDING A CONTACT UI: only 118 of 7,572 payers have a phone
-- number (1.6%), and ZERO email addresses exist anywhere in the nine source files.
-- This is a MAILING ADDRESS, not a contact record. The phones live on `properties`.
CREATE TABLE payers (
    id               serial PRIMARY KEY,
    legacy_billing_no int UNIQUE,
    org_name         varchar(200),
    first_name       varchar(100),
    last_name        varchar(100),
    email            varchar(255),             -- nullable: no legacy source for it
    mailing_address  varchar(255),
    mailing_city     varchar(100),
    mailing_state    char(2),
    mailing_zip      varchar(10),
    phone            varchar(20),
    phone_ext        varchar(10),
    alt_phone        varchar(20),
    fax              varchar(20),              -- legacy held '946-6049 cell' -- not a fax
    tax_exempt       boolean NOT NULL DEFAULT false,
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_payers_name ON payers (last_name, first_name);

-- Justified but NOT the common case: 7,233 payers own exactly one property, 118 own
-- multiple (one owns 24), 221 own zero. Build the UI for the 1:1 case.
CREATE TABLE property_ownerships (
    id              serial PRIMARY KEY,
    payer_id        int NOT NULL REFERENCES payers(id) ON DELETE CASCADE,
    property_id     int NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    is_primary      boolean NOT NULL DEFAULT true,
    ownership_start date,
    ownership_end   date,                      -- NULL = current
    source          varchar(20) NOT NULL DEFAULT 'legacy'
);

-- Exactly one current owner per property. Partial unique index: the constraint the
-- legacy data implies but never enforced.
CREATE UNIQUE INDEX uq_one_current_owner
    ON property_ownerships (property_id)
    WHERE ownership_end IS NULL;

CREATE INDEX idx_ownerships_payer ON property_ownerships (payer_id)
    WHERE ownership_end IS NULL;
