import { supabaseAdmin } from "../db.server";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ShopKpis {
  active_skus: number;
  units_sold_30d: number;
  total_stock: number;
  /** SUM(sold_30d × cost_price) — lower-bound revenue proxy for SKUs with cost set */
  estimated_cogs_30d: number;
  /** SUM(total_stock × cost_price) — inventory value at cost */
  estimated_stock_value: number;
  /** How many active SKUs have cost_price populated */
  skus_with_cost: number;
  /** Units sold / total stock — 30-day turnover ratio */
  turnover_ratio: number;
}

export interface AbcRow {
  id: string;
  sku_code: string;
  title: string | null;
  sold_30d: number;
  pct_of_total: number;
  cumulative_pct: number;
  abc_class: "A" | "B" | "C";
}

export interface VelocityRow {
  id: string;
  sku_code: string;
  title: string | null;
  sold_30d: number;
  daily_velocity: number;
  total_stock: number;
}

// ── getShopKpis ───────────────────────────────────────────────────────────────

export async function getShopKpis(shopId: string): Promise<ShopKpis> {
  const { data, error } = await supabaseAdmin
    .from("sku_analytics")
    .select("total_stock, sold_30d, cost_price")
    .eq("shop_id", shopId)
    .eq("status", "active");

  if (error) throw new Error(`getShopKpis: ${error.message}`);

  const rows = data ?? [];

  let unitsSold30d    = 0;
  let totalStock      = 0;
  let estCogs30d      = 0;
  let estStockValue   = 0;
  let skusWithCost    = 0;

  for (const r of rows) {
    const sold  = Number(r.sold_30d   ?? 0);
    const stock = Number(r.total_stock ?? 0);
    const cost  = r.cost_price != null ? Number(r.cost_price) : null;

    unitsSold30d += sold;
    totalStock   += stock;

    if (cost != null) {
      skusWithCost++;
      estCogs30d    += sold  * cost;
      estStockValue += stock * cost;
    }
  }

  const turnoverRatio =
    totalStock > 0 ? Math.round((unitsSold30d / totalStock) * 100) / 100 : 0;

  return {
    active_skus:           rows.length,
    units_sold_30d:        unitsSold30d,
    total_stock:           totalStock,
    estimated_cogs_30d:    estCogs30d,
    estimated_stock_value: estStockValue,
    skus_with_cost:        skusWithCost,
    turnover_ratio:        turnoverRatio,
  };
}

// ── getAbcAnalysis ────────────────────────────────────────────────────────────

/**
 * Classifies active SKUs into A / B / C using sold_30d as revenue proxy.
 *   A = top SKUs that together account for the first 80 % of units sold
 *   B = next 15 % (cumulative 80–95 %)
 *   C = remaining 5 %
 */
export async function getAbcAnalysis(shopId: string): Promise<AbcRow[]> {
  const { data, error } = await supabaseAdmin
    .from("sku_analytics")
    .select("id, sku_code, title, sold_30d")
    .eq("shop_id", shopId)
    .eq("status", "active")
    .order("sold_30d", { ascending: false });

  if (error) throw new Error(`getAbcAnalysis: ${error.message}`);

  const rows = (data ?? []).map((r) => ({
    id:       r.id,
    sku_code: r.sku_code,
    title:    r.title,
    sold_30d: Number(r.sold_30d ?? 0),
  }));

  const total = rows.reduce((s, r) => s + r.sold_30d, 0);

  let cumulative = 0;

  return rows.map((r) => {
    const pct          = total > 0 ? (r.sold_30d / total) * 100 : 0;
    const prevCumul    = cumulative;
    cumulative        += pct;

    let abc_class: AbcRow["abc_class"];
    if (prevCumul < 80)      abc_class = "A";
    else if (prevCumul < 95) abc_class = "B";
    else                     abc_class = "C";

    return {
      id:             r.id,
      sku_code:       r.sku_code,
      title:          r.title,
      sold_30d:       r.sold_30d,
      pct_of_total:   pct,
      cumulative_pct: cumulative,
      abc_class,
    };
  });
}

// ── getSalesByChannel ─────────────────────────────────────────────────────────

export interface SalesByChannel {
  shopify:   number;
  bsale_pos: number;
  total:     number;
}

export async function getSalesByChannel(
  shopId: string,
  days = 30,
): Promise<SalesByChannel> {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data } = await supabaseAdmin
    .from("sales_history")
    .select("channel, quantity_sold")
    .eq("shop_id", shopId)
    .gte("sold_at", since.toISOString());

  if (!data?.length) return { shopify: 0, bsale_pos: 0, total: 0 };

  const shopify = data
    .filter((s) => s.channel === "shopify" || !s.channel)
    .reduce((sum, s) => sum + (s.quantity_sold ?? 0), 0);

  const bsale_pos = data
    .filter((s) => s.channel === "bsale_pos")
    .reduce((sum, s) => sum + (s.quantity_sold ?? 0), 0);

  return { shopify, bsale_pos, total: shopify + bsale_pos };
}

// ── getTopSkusByVelocity ──────────────────────────────────────────────────────

export async function getTopSkusByVelocity(
  shopId: string,
  limit = 20,
): Promise<VelocityRow[]> {
  const { data, error } = await supabaseAdmin
    .from("sku_analytics")
    .select("id, sku_code, title, sold_30d, total_stock")
    .eq("shop_id", shopId)
    .eq("status", "active")
    .gt("sold_30d", 0)
    .order("sold_30d", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`getTopSkusByVelocity: ${error.message}`);

  return (data ?? []).map((r) => ({
    id:             r.id,
    sku_code:       r.sku_code,
    title:          r.title,
    sold_30d:       Number(r.sold_30d   ?? 0),
    daily_velocity: Number(r.sold_30d   ?? 0) / 30,
    total_stock:    Number(r.total_stock ?? 0),
  }));
}
