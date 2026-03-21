-- Bsale Documentos add-on: boleta electrónica automática por venta en Shopify

CREATE TABLE IF NOT EXISTS bsale_documents (
  id                uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  shop_id           text        REFERENCES shops(shop_id),
  shopify_order_id  text        NOT NULL,
  bsale_document_id integer,
  document_type     text        NOT NULL DEFAULT 'boleta',
  status            text        DEFAULT 'pending',
  url_pdf           text,
  total_amount      numeric,
  error_message     text,
  created_at        timestamptz DEFAULT now()
);

-- Prevent duplicate boletas per order
CREATE UNIQUE INDEX IF NOT EXISTS idx_bsale_docs_order
  ON bsale_documents(shop_id, shopify_order_id);

ALTER TABLE bsale_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "shop_isolation_bsale_docs" ON bsale_documents;
CREATE POLICY "shop_isolation_bsale_docs" ON bsale_documents
  FOR ALL USING (shop_id = current_setting('app.shop_id', true));

-- Office ID used when emitting documents (default Bsale office)
ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS bsale_default_office_id integer DEFAULT 1;

-- Add-ons activated per merchant (e.g. 'bsale_documents')
ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS active_addons text[] DEFAULT '{}';
