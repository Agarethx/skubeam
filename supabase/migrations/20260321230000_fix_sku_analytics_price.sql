-- Recreate sku_analytics to expose sale_price and use it for value calculations.
-- The previous definition only exposed cost_price; Bsale-synced SKUs set sale_price
-- instead, so inventory value was always 0 for those SKUs.

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
  -- Stock total sumando todas las locations
  COALESCE(
    (SELECT SUM(quantity) FROM inventory_levels il WHERE il.sku_id = s.id),
    0
  ) AS total_stock,
  -- Ventas últimos 30 días
  COALESCE(
    (SELECT SUM(quantity_sold) FROM sales_history sh
     WHERE sh.sku_id = s.id AND sh.sold_at > NOW() - INTERVAL '30 days'),
    0
  ) AS sold_30d,
  -- Ventas últimos 90 días
  COALESCE(
    (SELECT SUM(quantity_sold) FROM sales_history sh
     WHERE sh.sku_id = s.id AND sh.sold_at > NOW() - INTERVAL '90 days'),
    0
  ) AS sold_90d,
  -- Última venta
  (SELECT MAX(sold_at) FROM sales_history sh WHERE sh.sku_id = s.id) AS last_sold_at
FROM skus s;

CREATE UNIQUE INDEX ON sku_analytics(id);
CREATE INDEX sku_analytics_shop_idx ON sku_analytics(shop_id);
