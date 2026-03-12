-- Add shopify_line_item_id for idempotent order imports
alter table sales_history
  add column shopify_line_item_id bigint;

-- Partial unique index: only enforce uniqueness when line_item_id is set
create unique index sales_history_line_item_unique
  on sales_history(sku_id, shopify_line_item_id)
  where shopify_line_item_id is not null;
