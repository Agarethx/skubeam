import { supabaseAdmin } from "../db.server";
import type { Tables, TablesUpdate } from "../types/supabase";
import { refreshSkuAnalytics } from "./sync.server";

export type SkuRow = Tables<"sku_analytics">;
export type SkuDetail = Tables<"skus">;
export type InventoryLevelRow = Tables<"inventory_levels">;

export type SkuStatus = "active" | "archived" | "draft";

const PAGE_SIZE = 50;

// ── List ────────────────────────────────────────────────────────────────────

interface ListSkusOptions {
  search?: string;
  status?: SkuStatus | "";
  page?: number;
}

export async function listSkus(
  shopId: string,
  { search = "", status = "", page = 1 }: ListSkusOptions = {},
) {
  const offset = (page - 1) * PAGE_SIZE;

  let query = supabaseAdmin
    .from("sku_analytics")
    .select("*", { count: "exact" })
    .eq("shop_id", shopId)
    .order("sku_code", { ascending: true })
    .range(offset, offset + PAGE_SIZE - 1);

  if (search) query = query.ilike("sku_code", `%${search}%`);
  if (status) query = query.eq("status", status);

  const { data, error, count } = await query;
  if (error) throw new Error(`listSkus: ${error.message}`);

  return {
    skus: data ?? [],
    total: count ?? 0,
    page,
    pageSize: PAGE_SIZE,
    totalPages: Math.ceil((count ?? 0) / PAGE_SIZE),
  };
}

// ── Detail ───────────────────────────────────────────────────────────────────

export async function getSkuById(shopId: string, id: string) {
  const { data, error } = await supabaseAdmin
    .from("skus")
    .select("*")
    .eq("shop_id", shopId)
    .eq("id", id)
    .single();

  if (error) throw new Error(`getSkuById: ${error.message}`);
  return data;
}

export async function getSkuAnalytics(shopId: string, skuId: string) {
  const { data, error } = await supabaseAdmin
    .from("sku_analytics")
    .select("total_stock, sold_30d, sold_90d, last_sold_at")
    .eq("shop_id", shopId)
    .eq("id", skuId)
    .single();

  if (error) return { total_stock: 0, sold_30d: 0, sold_90d: 0, last_sold_at: null };
  return data;
}

export async function getInventoryLevels(shopId: string, skuId: string) {
  const { data, error } = await supabaseAdmin
    .from("inventory_levels")
    .select("shopify_location_id, location_name, quantity, updated_at")
    .eq("shop_id", shopId)
    .eq("sku_id", skuId)
    .order("quantity", { ascending: false });

  if (error) throw new Error(`getInventoryLevels: ${error.message}`);
  return data ?? [];
}

// ── Mutations ────────────────────────────────────────────────────────────────

export type SkuEditableFields = Pick<
  TablesUpdate<"skus">,
  "sku_code" | "barcode" | "barcode_type" | "vendor" | "cost_price"
>;

export async function updateSku(
  shopId: string,
  id: string,
  fields: SkuEditableFields,
) {
  const { error } = await supabaseAdmin
    .from("skus")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("shop_id", shopId)
    .eq("id", id);

  if (error) throw new Error(`updateSku: ${error.message}`);
}

export async function archiveSku(shopId: string, id: string) {
  const { error } = await supabaseAdmin
    .from("skus")
    .update({ status: "archived", updated_at: new Date().toISOString() })
    .eq("shop_id", shopId)
    .eq("id", id);

  if (error) throw new Error(`archiveSku: ${error.message}`);
}

export async function unarchiveSku(shopId: string, id: string) {
  const { error } = await supabaseAdmin
    .from("skus")
    .update({ status: "active", updated_at: new Date().toISOString() })
    .eq("shop_id", shopId)
    .eq("id", id);

  if (error) throw new Error(`unarchiveSku: ${error.message}`);
}

// Upsert the SKU record and its inventory levels after a Shopify sync
export async function syncSkuFromShopify(
  shopId: string,
  id: string,
  fields: Partial<SkuEditableFields> & { title?: string; product_type?: string; tags?: string[] },
  inventoryLevels: Array<{
    shopify_location_id: number;
    location_name: string;
    quantity: number;
  }>,
) {
  const { error: skuError } = await supabaseAdmin
    .from("skus")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("shop_id", shopId)
    .eq("id", id);

  if (skuError) throw new Error(`syncSkuFromShopify (sku): ${skuError.message}`);

  for (const level of inventoryLevels) {
    const { error } = await supabaseAdmin.from("inventory_levels").upsert(
      {
        shop_id: shopId,
        sku_id: id,
        shopify_location_id: level.shopify_location_id,
        location_name: level.location_name,
        quantity: level.quantity,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "sku_id,shopify_location_id" },
    );
    if (error) throw new Error(`syncSkuFromShopify (inventory): ${error.message}`);
  }

  await refreshSkuAnalytics();
}

// ── Health Score ─────────────────────────────────────────────────────────────

export interface HealthCriterion {
  label: string;
  points: number;
  earned: boolean;
}

export function computeHealthScore(
  sku: SkuDetail,
  analytics: { total_stock: number | null; sold_30d: number | null },
): { score: number; criteria: HealthCriterion[] } {
  const criteria: HealthCriterion[] = [
    { label: "Tiene título",      points: 20, earned: Boolean(sku.title?.trim()) },
    { label: "Tiene barcode",     points: 25, earned: Boolean(sku.barcode?.trim()) },
    { label: "Tiene vendor",      points: 15, earned: Boolean(sku.vendor?.trim()) },
    { label: "Tiene costo",       points: 15, earned: sku.cost_price != null },
    { label: "Stock disponible",  points: 15, earned: (analytics.total_stock ?? 0) > 0 },
    { label: "Ventas últimos 30d", points: 10, earned: (analytics.sold_30d ?? 0) > 0 },
  ];

  const score = criteria.reduce((sum, c) => sum + (c.earned ? c.points : 0), 0);
  return { score, criteria };
}
