-- Office ID selected by the merchant during the Bsale setup wizard
ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS bsale_office_id integer DEFAULT 1;
