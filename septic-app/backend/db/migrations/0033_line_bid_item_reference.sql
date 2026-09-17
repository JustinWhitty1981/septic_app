-- 0033: a hand-built invoice line may name a price-list item (BIL-20).
--
-- 0021 gave a line two lawful references (a service event, a legacy product
-- code); 0028 added the third for the bid path (bid_line_id). The manual
-- invoice desk needs a fourth: a line copied straight from the price list
-- names the *item*, not a bid line that never existed. The BIL-01 doctrine
-- — every line names the thing it charges for — is extended, not relaxed:
-- "description only" remains illegal, because a description is what a
-- invented charge wears.
--
-- Same shape as 0028: add the column, rebuild the CHECK to admit it, index
-- the not-null half.

ALTER TABLE septic_app.invoice_lines
  ADD COLUMN bid_item_id int REFERENCES septic_app.bid_items(id);

ALTER TABLE septic_app.invoice_lines
  DROP CONSTRAINT chk_line_reference;

ALTER TABLE septic_app.invoice_lines
  ADD CONSTRAINT chk_line_reference CHECK (
    service_event_id    IS NOT NULL
    OR legacy_product_code IS NOT NULL
    OR bid_line_id      IS NOT NULL
    OR bid_item_id      IS NOT NULL
  );

CREATE INDEX idx_lines_bid_item ON septic_app.invoice_lines (bid_item_id)
    WHERE bid_item_id IS NOT NULL;

COMMENT ON COLUMN septic_app.invoice_lines.bid_item_id IS
  'The price-list a hand-built line was charged from (BIL-20). The item id, '
  'not a copy of the price — the line carries the price it charged.';
