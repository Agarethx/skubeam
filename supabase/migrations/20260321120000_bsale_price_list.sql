-- Store the merchant's chosen Bsale price list ID so we don't re-detect it on every sync
ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS bsale_price_list_id integer;
