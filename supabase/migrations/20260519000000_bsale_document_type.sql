-- Add configurable Bsale document type for Nota de Venta.
-- NULL = not configured yet (merchant must select from the UI).
-- bsale_document_code_sii = SII code of the selected type (null for Nota de Venta drafts).
ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS bsale_document_type_id  integer DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS bsale_document_code_sii integer DEFAULT NULL;
