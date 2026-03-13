import { supabaseAdmin } from "../db.server";
import { SKU_LIMITS } from "../lib/plans";

// ── Upsert ────────────────────────────────────────────────────────────────────

/**
 * Called from afterAuth (install / reinstall) and the app layout loader.
 * - First install  → INSERT with defaults (plan=trial, sku_limit=500, is_active=true)
 * - Reinstall      → UPDATE is_active=true, uninstalled_at=null
 * - Every request  → no-op (upsert is idempotent, installed_at is never overwritten)
 */
export async function upsertShop(shopId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("shops")
    .upsert(
      { shop_id: shopId, is_active: true, uninstalled_at: null },
      { onConflict: "shop_id" },
    );
  if (error) console.error("[upsertShop]", shopId, error.message);
}

// ── Get ───────────────────────────────────────────────────────────────────────

export async function getShop(shopId: string) {
  const { data, error } = await supabaseAdmin
    .from("shops")
    .select("*")
    .eq("shop_id", shopId)
    .single();
  if (error) throw new Error(`getShop: ${error.message}`);
  return data;
}

// ── SKU limit ─────────────────────────────────────────────────────────────────

interface SkuLimitResult {
  allowed: boolean;
  current: number;
  /** -1 = unlimited */
  limit: number;
  plan: string;
}

/**
 * Returns whether the shop can add more SKUs.
 * Only counts non-archived SKUs against the limit.
 */
export async function checkSkuLimit(shopId: string): Promise<SkuLimitResult> {
  const [shopResult, countResult] = await Promise.all([
    supabaseAdmin
      .from("shops")
      .select("plan, sku_limit")
      .eq("shop_id", shopId)
      .single(),
    supabaseAdmin
      .from("skus")
      .select("id", { count: "exact", head: true })
      .eq("shop_id", shopId)
      .neq("status", "archived"),
  ]);

  const plan: string = shopResult.data?.plan ?? "trial";
  // SKU_LIMITS is the source of truth; fall back to sku_limit column for legacy rows
  const limit: number = SKU_LIMITS[plan] ?? shopResult.data?.sku_limit ?? 500;
  const current: number = countResult.count ?? 0;

  return {
    allowed: limit === -1 || current < limit,
    current,
    limit,
    plan,
  };
}
