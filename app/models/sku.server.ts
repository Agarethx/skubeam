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

// ── Unpublished (no shopify_variant_id) ──────────────────────────────────────

export async function listUnpublishedSkus(shopId: string) {
  const { data, error, count } = await supabaseAdmin
    .from("skus")
    .select("*", { count: "exact" })
    .eq("shop_id", shopId)
    .is("shopify_variant_id", null)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`listUnpublishedSkus: ${error.message}`);
  return { skus: data ?? [], total: count ?? 0 };
}

export async function getUnpublishedCount(shopId: string): Promise<number> {
  const { count } = await supabaseAdmin
    .from("skus")
    .select("*", { count: "exact", head: true })
    .eq("shop_id", shopId)
    .is("shopify_variant_id", null);
  return count ?? 0;
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

// ── Webhook upsert ───────────────────────────────────────────────────────────

export interface ShopifyVariantPayload {
  shopify_variant_id: number;
  shopify_product_id: number;
  sku_code: string;
  barcode: string | null;
  title: string | null;
  vendor: string | null;
  product_type: string | null;
  tags: string[];
  status: string;
}

/**
 * Idempotent upsert driven by PRODUCTS_UPDATE webhook data.
 *
 * Rules:
 * - Existing SKU → UPDATE only webhook-controlled fields.
 *   barcode is updated only when Shopify sends a non-empty value,
 *   preserving any barcode the merchant generated locally.
 *   cost_price and barcode_type are never touched (merchant-managed).
 * - New variant → INSERT with all available fields.
 * - Variants without a sku_code are silently skipped (not trackable).
 * - Running twice with the same payload is safe (idempotent by design).
 */
export async function upsertSkuFromShopify(
  shopId: string,
  variants: ShopifyVariantPayload[],
): Promise<void> {
  const trackable = variants.filter((v) => v.sku_code.trim());
  if (trackable.length === 0) return;

  const now = new Date().toISOString();

  // One SELECT to find all existing rows for these variant IDs
  const { data: existing } = await supabaseAdmin
    .from("skus")
    .select("id, shopify_variant_id, barcode")
    .eq("shop_id", shopId)
    .in(
      "shopify_variant_id",
      trackable.map((v) => v.shopify_variant_id),
    );

  const existingMap = new Map(
    (existing ?? []).map((s) => [s.shopify_variant_id, s]),
  );

  const toInsert: object[] = [];

  for (const v of trackable) {
    const shopifyBarcode = v.barcode?.trim() || null;
    const found = existingMap.get(v.shopify_variant_id);

    if (found) {
      await supabaseAdmin
        .from("skus")
        .update({
          sku_code:     v.sku_code,
          title:        v.title,
          vendor:       v.vendor,
          product_type: v.product_type,
          tags:         v.tags,
          status:       v.status,
          // Only overwrite barcode if Shopify provides one;
          // otherwise keep whatever the merchant set locally.
          ...(shopifyBarcode !== null ? { barcode: shopifyBarcode } : {}),
          updated_at: now,
        })
        .eq("id", found.id);
    } else {
      toInsert.push({
        shop_id:           shopId,
        shopify_variant_id: v.shopify_variant_id,
        shopify_product_id: v.shopify_product_id,
        sku_code:          v.sku_code,
        barcode:           shopifyBarcode,
        title:             v.title,
        vendor:            v.vendor,
        product_type:      v.product_type,
        tags:              v.tags,
        status:            v.status,
        updated_at:        now,
      });
    }
  }

  if (toInsert.length > 0) {
    const { error } = await supabaseAdmin.from("skus").insert(toInsert);
    if (error) console.error("[upsertSkuFromShopify] insert:", error.message);
  }

  await refreshSkuAnalytics();
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

// ── Dashboard: lowest health score SKUs ──────────────────────────────────────

export interface DashboardAttentionSku {
  id: string;
  sku_code: string;
  title: string | null;
  total_stock: number;
  health_score: number;
}

/**
 * Returns the `limit` active SKUs with the lowest health score.
 * Queries both sku_analytics (stock/sales) and skus (barcode) to compute
 * the full 6-criterion score, then sorts ascending and slices.
 */
export async function getLowestHealthScoreSkus(
  shopId: string,
  limit: number,
): Promise<DashboardAttentionSku[]> {
  const [analyticsResult, skusResult] = await Promise.all([
    supabaseAdmin
      .from("sku_analytics")
      .select("id, sku_code, title, vendor, cost_price, total_stock, sold_30d")
      .eq("shop_id", shopId)
      .eq("status", "active"),
    supabaseAdmin
      .from("skus")
      .select("id, barcode")
      .eq("shop_id", shopId),
  ]);

  if (analyticsResult.error) {
    throw new Error(`getLowestHealthScoreSkus: ${analyticsResult.error.message}`);
  }

  const barcodeMap = new Map(
    (skusResult.data ?? []).map((s) => [s.id, s.barcode]),
  );

  const scored = (analyticsResult.data ?? []).map((a) => {
    const skuForScore = {
      title:      a.title,
      barcode:    barcodeMap.get(a.id ?? "") ?? null,
      vendor:     a.vendor,
      cost_price: a.cost_price,
    } as SkuDetail;

    const { score } = computeHealthScore(skuForScore, {
      total_stock: a.total_stock,
      sold_30d:    a.sold_30d,
    });

    return {
      id:           a.id as string,
      sku_code:     a.sku_code as string,
      title:        a.title,
      total_stock:  Number(a.total_stock ?? 0),
      health_score: score,
    };
  });

  return scored
    .sort((a, b) => a.health_score - b.health_score)
    .slice(0, limit);
}
