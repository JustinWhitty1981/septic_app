-- 0037  Company identity: the letterhead every printed invoice and bid carries.
-- =============================================================================
-- Both papers left the building saying the company's name and nothing else —
-- and not even the same name: the statement printed "Ziegelbauer Septic", the
-- bid "Ziegelbauer Septic System Service", each a string hardcoded in a
-- component. A customer holding a signed bid and a later invoice could not tell
-- they came from the same company, and a paper demanding money with no way to
-- call about it invites exactly the argument BIL-08 exists to prevent.
--
-- So identity joins the one row that already answers "what does the office
-- decide once" (0027's rule): the name, the logo (a pointer into `media` — the
-- bytes live in object storage, never in a column, NF-04 intact), and the
-- contact block the papers must carry: address, email, phone. `updated_by` says
-- who last changed what the customers read, same as it says for the tax rate.
--
-- The name seeds to the string the invoices have been printing all along — the
-- measured truth, not an invention — so every document looks the same the
-- morning after this runs until the office decides otherwise. The contact
-- fields seed NULL and print nothing until set: a placeholder phone number on
-- legal paper is worse than none. Lengths are capped so a paste of a whole
-- page into the address field cannot ride on every document the company owns.
ALTER TABLE septic_app.company_settings
  ADD COLUMN company_name text NOT NULL DEFAULT 'Ziegelbauer Septic'
    CHECK (char_length(company_name) BETWEEN 1 AND 200),
  ADD COLUMN logo_media_id bigint REFERENCES septic_app.media(id),
  ADD COLUMN address text CHECK (address IS NULL OR char_length(address) <= 300),
  ADD COLUMN email text CHECK (email IS NULL OR char_length(email) <= 200),
  ADD COLUMN phone text CHECK (phone IS NULL OR char_length(phone) <= 50);

COMMENT ON COLUMN septic_app.company_settings.company_name IS
  'The name printed on every invoice and bid. Replaces two hardcoded variants '
  'that disagreed with each other (BIL-08/BIL-15).';
COMMENT ON COLUMN septic_app.company_settings.logo_media_id IS
  'The letterhead image, by reference into media (bytes live in object storage, '
  'NF-04); NULL prints no logo.';
COMMENT ON COLUMN septic_app.company_settings.address IS
  'Mailing/physical address printed in the letterhead contact block.';
COMMENT ON COLUMN septic_app.company_settings.email IS
  'Company email printed in the letterhead contact block.';
COMMENT ON COLUMN septic_app.company_settings.phone IS
  'Company phone printed in the letterhead contact block — the number the '
  'statement footer already invites the customer to call.';
