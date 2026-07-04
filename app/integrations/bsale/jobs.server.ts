import { supabaseAdmin } from "../../db.server";
import { syncBsalePricesToShopify } from "./products.server";
import { syncBsaleStockToSkuBeam } from "./stocks.server";

export type BsaleJobType = "bsale_prices" | "bsale_stock";

// ── Create ────────────────────────────────────────────────────────────────────

export async function createBsaleJob(shopId: string, type: BsaleJobType) {
  const { data, error } = await supabaseAdmin
    .from("sync_jobs")
    .insert({ shop_id: shopId, type, status: "running" })
    .select()
    .single();

  if (error) throw new Error(`createBsaleJob: ${error.message}`);
  return data;
}

// ── Get active Bsale job for a shop ──────────────────────────────────────────

export async function getActiveBsaleJob(shopId: string) {
  const { data } = await supabaseAdmin
    .from("sync_jobs")
    .select("id, type, status, records_processed, started_at")
    .eq("shop_id", shopId)
    .in("type", ["bsale_prices", "bsale_stock"])
    .in("status", ["pending", "running"])
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function completeJob(jobId: string, synced: number, payload?: object) {
  await supabaseAdmin
    .from("sync_jobs")
    .update({
      status:            "completed",
      records_processed: synced,
      completed_at:      new Date().toISOString(),
      ...(payload ? { payload } : {}),
    })
    .eq("id", jobId);
}

async function failJob(jobId: string, err: unknown) {
  await supabaseAdmin
    .from("sync_jobs")
    .update({
      status: "failed",
      error_message: err instanceof Error ? err.message : String(err),
      completed_at: new Date().toISOString(),
    })
    .eq("id", jobId);
}

async function resolveShopConfig(shopId: string): Promise<{ token: string; officeId: number | null; priceListId: number | null }> {
  const { data } = await supabaseAdmin
    .from("shops")
    .select("bsale_token, bsale_office_id, bsale_price_list_id")
    .eq("shop_id", shopId)
    .single();

  const token = data?.bsale_token ?? process.env.BSALE_ACCESS_TOKEN;
  if (!token) throw new Error("No Bsale token configured for this shop.");
  return {
    token,
    officeId:    data?.bsale_office_id ?? null,
    priceListId: data?.bsale_price_list_id ?? null,
  };
}

async function stampLastSync(shopId: string) {
  await supabaseAdmin
    .from("shops")
    .update({ bsale_last_sync: new Date().toISOString() })
    .eq("shop_id", shopId);
}

// ── Processors (called fire-and-forget from api.bsale.sync.tsx) ───────────────

export async function processBsalePricesJob(
  jobId:  string,
  shopId: string,
): Promise<void> {
  try {
    const { token, priceListId } = await resolveShopConfig(shopId);
    if (!priceListId) throw new Error("No hay lista de precios configurada. Ve a Integraciones → Bsale para configurarla.");
    const result = await syncBsalePricesToShopify(shopId, token, priceListId);
    await completeJob(jobId, result.synced, result);
    await stampLastSync(shopId);
  } catch (err) {
    console.error("[processBsalePricesJob]", err);
    await failJob(jobId, err);
  }
}

export async function processBsaleStockJob(
  jobId:  string,
  shopId: string,
): Promise<void> {
  console.log("[stock-sync] processBsaleStockJob start — jobId:", jobId, "shop:", shopId);
  try {
    const { token, officeId } = await resolveShopConfig(shopId);
    console.log("[stock-sync] officeId configured:", officeId);
    const result = await syncBsaleStockToSkuBeam(shopId, token, officeId);
    console.log("[stock-sync] done — shopify_matched:", result.shopify_matched, "skipped:", result.skipped, "synced:", result.synced, "errors:", result.errors);
    await completeJob(jobId, result.synced, result);
    await stampLastSync(shopId);
  } catch (err) {
    console.error("[stock-sync] processBsaleStockJob ERROR:", err);
    await failJob(jobId, err);
  }
}
