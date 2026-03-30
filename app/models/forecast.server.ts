import { supabaseAdmin } from "../db.server";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ForecastConfig {
  reorder_lead_days: number;
  safety_stock_days: number;
  forecast_window_days: number;
  dead_stock_days: number;
}

export interface ForecastRow {
  id: string;
  sku_code: string;
  title: string | null;
  total_stock: number;
  daily_velocity: number;
  reorder_point: number;
  days_left: number | null;
  status: "critical" | "low" | "ok" | "dead";
  sale_price: number | null;
  cost_price: number | null;
}

const DEFAULT_CONFIG: ForecastConfig = {
  reorder_lead_days: 14,
  safety_stock_days: 7,
  forecast_window_days: 30,
  dead_stock_days: 90,
};

// ── Config ────────────────────────────────────────────────────────────────────

export async function getForecastConfig(shopId: string): Promise<ForecastConfig> {
  const { data } = await supabaseAdmin
    .from("forecast_configs")
    .select("reorder_lead_days, safety_stock_days, forecast_window_days, dead_stock_days")
    .eq("shop_id", shopId)
    .maybeSingle();

  return data ?? DEFAULT_CONFIG;
}

export async function saveForecastConfig(
  shopId: string,
  fields: Pick<ForecastConfig, "reorder_lead_days" | "safety_stock_days" | "forecast_window_days">,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("forecast_configs")
    .upsert({ shop_id: shopId, ...fields }, { onConflict: "shop_id" });
  if (error) throw new Error(`saveForecastConfig: ${error.message}`);
}

// ── Forecast table ────────────────────────────────────────────────────────────

export async function getForecastForShop(shopId: string) {
  const config = await getForecastConfig(shopId);

  const { data: analytics, error } = await supabaseAdmin
    .from("sku_analytics")
    .select("id, sku_code, title, total_stock, sold_30d, sold_90d, sale_price, cost_price")
    .eq("shop_id", shopId)
    .eq("status", "active")
    .order("sku_code");

  if (error) throw new Error(`getForecastForShop: ${error.message}`);

  const rows: ForecastRow[] = (analytics ?? []).map((sku) => {
    const sold30 = Number(sku.sold_30d ?? 0);
    const stock  = Number(sku.total_stock ?? 0);
    const sold90 = Number(sku.sold_90d ?? 0);

    const dailyVelocity  = sold30 / config.forecast_window_days;
    const reorderPoint   = Math.ceil(
      dailyVelocity * (config.reorder_lead_days + config.safety_stock_days),
    );
    const daysLeft = dailyVelocity > 0 ? Math.floor(stock / dailyVelocity) : null;

    let status: ForecastRow["status"];
    if (sold90 === 0 && stock > 0) {
      status = "dead";
    } else if (dailyVelocity === 0) {
      status = "ok";
    } else if (stock <= reorderPoint * 0.5) {
      status = "critical";
    } else if (stock <= reorderPoint) {
      status = "low";
    } else {
      status = "ok";
    }

    return {
      id:             sku.id,
      sku_code:       sku.sku_code,
      title:          sku.title,
      total_stock:    stock,
      daily_velocity: dailyVelocity,
      reorder_point:  reorderPoint,
      days_left:      daysLeft,
      sale_price:     sku.sale_price != null ? Number(sku.sale_price) : null,
      cost_price:     sku.cost_price != null ? Number(sku.cost_price) : null,
      status,
    };
  });

  return { rows, config };
}

// ── Dead stock ────────────────────────────────────────────────────────────────

export async function getDeadStockSkus(shopId: string) {
  const { data, error } = await supabaseAdmin
    .from("sku_analytics")
    .select("id, sku_code, title, total_stock, last_sold_at")
    .eq("shop_id", shopId)
    .eq("status", "active")
    .eq("sold_90d", 0)
    .gt("total_stock", 0)
    .order("total_stock", { ascending: false });

  if (error) throw new Error(`getDeadStockSkus: ${error.message}`);
  return data ?? [];
}

// ── Sales history check ────────────────────────────────────────────────────────

export async function getSalesCount(shopId: string): Promise<number> {
  const { count } = await supabaseAdmin
    .from("sales_history")
    .select("id", { count: "exact", head: true })
    .eq("shop_id", shopId);
  return count ?? 0;
}
