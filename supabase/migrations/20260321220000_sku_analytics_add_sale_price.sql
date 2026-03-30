-- Recreate sku_analytics with sale_price included.
-- Uses correlated subqueries (not JOINs) to avoid cross-product inflation
-- when a SKU has multiple inventory_levels × multiple sales_history rows.

DROP MATERIALIZED VIEW IF EXISTS sku_analytics;

CREATE MATERIALIZED VIEW sku_analytics AS
SELECT
  s.id,
  s.shop_id,
  s.sku_code,
  s.title,
  s.vendor,
  s.status,
  s.cost_price,
  s.sale_price,
  COALESCE(
    (SELECT SUM(il.quantity) FROM inventory_levels il WHERE il.sku_id = s.id),
    0
  )::bigint AS total_stock,
  COALESCE(
    (SELECT SUM(sh.quantity_sold) FROM sales_history sh
     WHERE sh.sku_id = s.id AND sh.sold_at >= NOW() - INTERVAL '30 days'),
    0
  )::bigint AS sold_30d,
  COALESCE(
    (SELECT SUM(sh.quantity_sold) FROM sales_history sh
     WHERE sh.sku_id = s.id AND sh.sold_at >= NOW() - INTERVAL '90 days'),
    0
  )::bigint AS sold_90d,
  (SELECT MAX(sh.sold_at) FROM sales_history sh WHERE sh.sku_id = s.id) AS last_sold_at
FROM skus s;

CREATE UNIQUE INDEX sku_analytics_id_idx ON sku_analytics (id);
CREATE INDEX sku_analytics_shop_idx ON sku_analytics (shop_id);
