-- 0028  Bids: the half of the business that has been living on paper (BIL-09..16).
-- =============================================================================
-- The company has always installed systems (mounds among them) and a licensed
-- plumber has always done general work, but the legacy corpus contains no
-- estimate tables at all: bids lived on paper, and so did their prices — in
-- somebody's memory. Three tables fix that, under one rule repeated from three
-- directions already in this schema: the list is a reference, the bid is a
-- record, the signature is a border.
--
--   1. bid_items — the master price list (BIL-09). Reference data the office
--      owns the way it owns disposal_sites; prices move freely here, because
--      what is history lives on the bid, whose lines keep COPIES (BIL-10).
--      Retired behind is_active, never deleted: a price that once existed is
--      evidence of what the company charged.
--
--   2. bids / bid_lines — a document addressed to a payer. line_total is
--      GENERATED ALWAYS (BIL-11: arithmetic the keyboard may not type), and
--      the bid total is not a column at all — derived per request, the BIL-07
--      rule, because a bid accumulates exactly the line edits that make stored
--      sums lie. tax_rate is stamped at APPROVAL (BIL-16): prices and the tax
--      on them are mutable references until the signature makes them a record.
--
--   3. invoice_lines.bid_line_id — the third lawful line reference. BIL-01's
--      chk_line_reference said a line points at a service event or a product
--      code; that was true the day a pump-out was the only thing sold. The
--      check gets wider, not weaker: the third arm is a line a signature
--      approved, and an invoice line that names nothing is still refused —
--      the surviving refusal is what the pre-check below counts, exactly as
--      0021 counted before it.
--
-- company_settings gains its second and last column (BIL-16): one rate, in one
-- row, for one question. 0027's argument against a key-value junk drawer holds
-- — "what is sales tax?" is a second question, not a second drawer. The CHECK
-- is the requirement itself: a rate is not an amount, and the clerk who types
-- 5.5 meaning "5.5%" into a decimal field would otherwise bill 550% of every
-- job in the county.

CREATE TYPE septic_app.bid_status AS ENUM ('draft','approved','declined','invoiced');

ALTER TABLE septic_app.company_settings
  ADD COLUMN sales_tax_rate numeric(5,4) NOT NULL DEFAULT 0
    CHECK (sales_tax_rate >= 0 AND sales_tax_rate < 1);

COMMENT ON COLUMN septic_app.company_settings.sales_tax_rate IS
  'BIL-16: the system-wide sales tax as a decimal rate (0.055 = 5.5%), set by '
  'the office at PATCH /api/settings/sales-tax. 0 is the measured legacy truth '
  '(tax on 0 of 3,283 invoices), not a placeholder. Read as an estimate by bid '
  'screens; stamped onto a bid at approval; conversion obeys the stamp, never '
  'this column.';

CREATE TABLE septic_app.bid_items (
  id          serial PRIMARY KEY,
  name        varchar(120)  NOT NULL,
  unit        varchar(20)   NOT NULL,
  unit_price  numeric(10,2) NOT NULL CHECK (unit_price >= 0),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE septic_app.bid_items IS
  'BIL-09: the master price list for installation and plumbing work. Reference '
  'data, not history — prices edit in place because every historical value was '
  'copied onto the bid line that used it. Retired via is_active, never deleted: '
  'retirement hides a row from the picker; deletion would erase what was charged.';

CREATE TABLE septic_app.bids (
  id            serial PRIMARY KEY,
  payer_id      int NOT NULL REFERENCES septic_app.payers(id),
  property_id   int REFERENCES septic_app.properties(id),
  bid_date      date NOT NULL DEFAULT septic_app.business_today(),
  status        septic_app.bid_status NOT NULL DEFAULT 'draft',
  notes         text,
  tax_rate      numeric(5,4) NOT NULL DEFAULT 0,
  approved_by   int REFERENCES septic_app.users(id),
  approved_at   timestamptz,
  declined_at   timestamptz,
  decline_note  text,
  invoice_id    int REFERENCES septic_app.invoices(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_bid_approval CHECK (
    -- A signature has a signer: approval without who-and-when is a stamp from
    -- nowhere, and the reverse (fields set on a draft) is the same lie in the
    -- other direction. Read as one OR per state — AND-ing state-shaped clauses
    -- would refuse every row, which is how a guard dies looking strongest.
    (status = 'draft'     AND approved_by IS NULL AND approved_at IS NULL
                           AND declined_at IS NULL AND invoice_id IS NULL)
    OR (status IN ('approved','invoiced')
         AND approved_by IS NOT NULL AND approved_at IS NOT NULL
         AND declined_at IS NULL)
    OR (status = 'declined' AND approved_by IS NULL AND approved_at IS NULL
                           AND declined_at IS NOT NULL AND invoice_id IS NULL)
    OR (status = 'invoiced' AND invoice_id IS NOT NULL)
  )
);

COMMENT ON TABLE septic_app.bids IS
  'BIL-10..16: one document the office sends a payer. approved_by/approved_at '
  'are stamped by the server (BIL-12: approval is a signature); tax_rate is the '
  'system rate frozen at that same instant (BIL-16); invoice_id is set exactly '
  'once, by the conversion that moved the status to invoiced (BIL-13). An '
  'approved bid is immutable because the endpoint guards it, not because a '
  'trigger does — bids have no 61 years of hand-edited history to survive, and '
  'that asymmetry with invoices is recorded in DATA_MODEL §9, not forgotten.';

CREATE TABLE septic_app.bid_lines (
  id           serial PRIMARY KEY,
  bid_id       int NOT NULL REFERENCES septic_app.bids(id) ON DELETE CASCADE,
  bid_item_id  int REFERENCES septic_app.bid_items(id),
  description  varchar(255) NOT NULL,
  unit         varchar(20)  NOT NULL,
  unit_price   numeric(10,2) NOT NULL CHECK (unit_price >= 0),
  quantity     numeric(8,2)  NOT NULL CHECK (quantity > 0),
  line_total   numeric(12,2) GENERATED ALWAYS AS (unit_price * quantity) STORED,
  sequence_no  int NOT NULL,
  -- Without the bound, `unit_price * quantity` can overflow numeric(12,2)
  -- inside the INSERT and the client hears "internal error" for what is really
  -- a typo in a number; with it, the endpoint pre-validates the same product
  -- rule and answers 400 naming the field.
  CONSTRAINT chk_bid_line_size CHECK (unit_price * quantity < 10000000),
  CONSTRAINT uq_bid_line_sequence UNIQUE (bid_id, sequence_no)
);

COMMENT ON COLUMN septic_app.bid_lines.bid_item_id IS
  'BIL-10: provenance, not a join. NULL is a one-off line the customer talked '
  'the plumber into. description/unit/unit_price above are COPIES taken at the '
  'moment of adding — the price list changing Tuesday must never reach into a '
  'document that was already sent.';

-- The constraint swap, with 0021's manners: count the would-be violations of
-- the OLD rule before dropping it (they are the 3,120 lines BIL-03 quarantined
-- and never loaded — zero in the live table; assert, then proceed), and refuse
-- the migration rather than fail on an arbitrary row.
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM septic_app.invoice_lines
   WHERE service_event_id IS NULL AND legacy_product_code IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION
      '0028: % live invoice lines name neither a service event nor a product '
      '(BIL-01 violated before the swap); refusing to proceed.', n;
  END IF;
END $$;

ALTER TABLE septic_app.invoice_lines
  ADD COLUMN bid_line_id int REFERENCES septic_app.bid_lines(id);

ALTER TABLE septic_app.invoice_lines DROP CONSTRAINT chk_line_reference;
ALTER TABLE septic_app.invoice_lines
  ADD CONSTRAINT chk_line_reference CHECK (
    service_event_id    IS NOT NULL
    OR legacy_product_code IS NOT NULL
    OR bid_line_id      IS NOT NULL
  );

COMMENT ON COLUMN septic_app.invoice_lines.bid_line_id IS
  'BIL-13: the third lawful origin of an invoice line — a line on an APPROVED '
  'bid, which is a line a signature approved. The check that used to choose '
  'between two origins now chooses between three; "free text floating on its '
  'own" is still not one of them.';
