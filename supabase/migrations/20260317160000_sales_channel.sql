-- Add channel tracking and Bsale document idempotency to sales_history

ALTER TABLE sales_history
  ADD COLUMN IF NOT EXISTS channel text DEFAULT 'shopify';

ALTER TABLE sales_history
  ADD COLUMN IF NOT EXISTS bsale_document_id text;

-- sku_code is needed for the Bsale-specific unique index
ALTER TABLE sales_history
  ADD COLUMN IF NOT EXISTS sku_code text;

-- revenue field for Bsale document line items
ALTER TABLE sales_history
  ADD COLUMN IF NOT EXISTS revenue numeric DEFAULT 0;

-- Unique index for Bsale document deduplication
-- Uses sku_code (not sku_id) so it works before variant mapping is resolved
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_bsale_doc
  ON sales_history(shop_id, bsale_document_id, sku_code)
  WHERE bsale_document_id IS NOT NULL;
