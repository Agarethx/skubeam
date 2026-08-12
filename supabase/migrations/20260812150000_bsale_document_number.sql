-- Número correlativo de la Nota de Venta / documento tal como sale impreso en el PDF
-- (Bsale lo expone como `number`). Es distinto de `bsale_document_id`, que es el ID
-- interno de la API: el merchant busca y referencia por el número impreso.
ALTER TABLE bsale_documents
  ADD COLUMN IF NOT EXISTS bsale_document_number integer;

CREATE INDEX IF NOT EXISTS idx_bsale_docs_number
  ON bsale_documents(shop_id, bsale_document_number);
