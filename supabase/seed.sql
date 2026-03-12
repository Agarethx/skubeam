-- ============================================================================
-- SEED: Datos de prueba para Forecast & Replenishment
-- Selecciona los primeros 10 SKUs del catálogo real y genera:
--   • dead      (SKUs 1-2): stock disponible, cero ventas en 90d
--   • critical  (SKUs 3-4): alta velocidad (~5 u/día), stock muy bajo
--   • low       (SKUs 5-6): velocidad media (~2 u/día), stock en zona de alerta
--   • ok        (SKUs 7-10): velocidad baja (~0.3 u/día), stock amplio
--
-- Idempotente: DELETE + INSERT en cada ejecución.
-- Llama a refresh_sku_analytics() al final.
-- ============================================================================

DO $seed$
DECLARE
  v_shop    text;
  v_skus    uuid[];
  v_loc     bigint := 1234567890;   -- location ficticia para el seed
BEGIN
  -- ── Buscar el shop instalado ─────────────────────────────────────────────
  SELECT shop_id INTO v_shop FROM shops ORDER BY installed_at LIMIT 1;
  IF v_shop IS NULL THEN
    RAISE NOTICE 'seed.sql: no hay shops registrados — instala la app primero';
    RETURN;
  END IF;

  -- ── Tomar los primeros 10 SKUs del catálogo ───────────────────────────────
  SELECT array_agg(id ORDER BY sku_code)
    INTO v_skus
    FROM (
      SELECT id, sku_code FROM skus
      WHERE shop_id = v_shop
      ORDER BY sku_code
      LIMIT 10
    ) t;

  IF v_skus IS NULL OR array_length(v_skus, 1) = 0 THEN
    RAISE NOTICE 'seed.sql: no hay SKUs — importa productos primero';
    RETURN;
  END IF;

  RAISE NOTICE 'seed.sql: usando % SKUs del shop %', array_length(v_skus, 1), v_shop;

  -- ── Limpiar datos previos del seed (idempotente) ──────────────────────────
  DELETE FROM sales_history
    WHERE shop_id = v_shop AND sku_id = ANY(v_skus);

  DELETE FROM inventory_levels
    WHERE shop_id = v_shop
      AND sku_id = ANY(v_skus)
      AND shopify_location_id = v_loc;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- INVENTORY LEVELS
  -- El stock determina si el status es critical/low/ok dado el reorder point.
  -- Reorder point = velocity × (lead_days=14 + safety_days=7) = velocity × 21
  --
  --   dead     (idx 1-2): 50 u  — has stock, no recent sales
  --   critical (idx 3-4): 20 u  — velocity≈5, reorder≈105 → stock ≤ 52 (critical)
  --   low      (idx 5-6): 40 u  — velocity≈2, reorder≈42  → stock ≤ 42 (low)
  --   ok       (idx 7-10):120 u — velocity≈0.3, reorder≈7  → stock >> reorder (ok)
  -- ═══════════════════════════════════════════════════════════════════════════

  INSERT INTO inventory_levels
    (shop_id, sku_id, shopify_location_id, location_name, quantity)
  SELECT
    v_shop,
    v_skus[idx],
    v_loc,
    'Almacén Seed',
    CASE
      WHEN idx <= 2 THEN 50
      WHEN idx <= 4 THEN 20
      WHEN idx <= 6 THEN 40
      ELSE 120
    END
  FROM unnest(ARRAY[1,2,3,4,5,6,7,8,9,10]) AS idx
  WHERE idx <= array_length(v_skus, 1)
  ON CONFLICT (sku_id, shopify_location_id)
    DO UPDATE SET quantity = EXCLUDED.quantity;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- SALES HISTORY
  -- Cada fila simula una orden con una línea de venta.
  -- shopify_line_item_id único por sección para no colisionar en re-runs.
  --
  -- dead (idx 1-2): sin inserts → sold_30d = 0, sold_90d = 0
  -- ═══════════════════════════════════════════════════════════════════════════

  -- ── Critical (idx 3-4): ~5 u/día × 30 días ───────────────────────────────
  -- sold_30d ≈ 150  →  velocity ≈ 5/día  →  reorder_point ≈ 105
  -- stock = 20 ≤ 52 (50% del reorder) → status = critical
  INSERT INTO sales_history
    (shop_id, sku_id, shopify_order_id, shopify_line_item_id, quantity_sold, sold_at)
  SELECT
    v_shop,
    v_skus[idx],
    900000 + (idx * 1000) + gs,   -- order_id ficticio único
    (idx * 100000) + gs,           -- line_item_id único por SKU
    5,
    now() - (gs || ' days')::interval
  FROM unnest(ARRAY[3,4]) AS idx,
       generate_series(1, 30) AS gs
  WHERE idx <= array_length(v_skus, 1)
  ON CONFLICT DO NOTHING;

  -- ── Low (idx 5-6): ~2 u/día × 60 días ────────────────────────────────────
  -- sold_30d ≈ 60  →  velocity ≈ 2/día  →  reorder_point ≈ 42
  -- stock = 40 ≤ 42 → status = low
  INSERT INTO sales_history
    (shop_id, sku_id, shopify_order_id, shopify_line_item_id, quantity_sold, sold_at)
  SELECT
    v_shop,
    v_skus[idx],
    800000 + (idx * 1000) + gs,
    (idx * 100000) + gs + 10000,
    2,
    now() - (gs || ' days')::interval
  FROM unnest(ARRAY[5,6]) AS idx,
       generate_series(1, 60) AS gs
  WHERE idx <= array_length(v_skus, 1)
  ON CONFLICT DO NOTHING;

  -- ── OK (idx 7-10): ~1 u/3 días × 90 días ────────────────────────────────
  -- sold_30d ≈ 10  →  velocity ≈ 0.33/día  →  reorder_point ≈ 7
  -- stock = 120 >> 7 → status = ok
  INSERT INTO sales_history
    (shop_id, sku_id, shopify_order_id, shopify_line_item_id, quantity_sold, sold_at)
  SELECT
    v_shop,
    v_skus[idx],
    700000 + (idx * 1000) + gs,
    (idx * 100000) + gs + 20000,
    1,
    now() - ((gs * 3) || ' days')::interval
  FROM unnest(ARRAY[7,8,9,10]) AS idx,
       generate_series(1, 30) AS gs
  WHERE idx <= array_length(v_skus, 1)
  ON CONFLICT DO NOTHING;

  -- ── Refresh materialized view ─────────────────────────────────────────────
  PERFORM refresh_sku_analytics();

  RAISE NOTICE 'seed.sql: completado — % SKUs con datos de forecast', array_length(v_skus, 1);
END
$seed$;
