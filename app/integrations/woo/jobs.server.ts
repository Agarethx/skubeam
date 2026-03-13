import { supabaseAdmin } from "../../db.server";
import { refreshSkuAnalytics } from "../../models/sync.server";
import {
  paginateProducts,
  paginateOrders,
  getVariations,
  type WooCredentials,
  type WooProduct,
  type WooVariation,
} from "./client.server";

export type WooJobType = "woo_migration";

// ── Create ────────────────────────────────────────────────────────────────────

export async function createWooJob(shopId: string) {
  const { data, error } = await supabaseAdmin
    .from("sync_jobs")
    .insert({ shop_id: shopId, type: "woo_migration" as WooJobType, status: "running" })
    .select()
    .single();

  if (error) throw new Error(`createWooJob: ${error.message}`);
  return data;
}

export async function getActiveWooJob(shopId: string) {
  const { data } = await supabaseAdmin
    .from("sync_jobs")
    .select("id, type, status, records_processed, started_at")
    .eq("shop_id", shopId)
    .eq("type", "woo_migration")
    .in("status", ["pending", "running"])
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function updateJobProgress(jobId: string, records: number) {
  await supabaseAdmin
    .from("sync_jobs")
    .update({ records_processed: records })
    .eq("id", jobId);
}

async function completeJob(jobId: string, total: number) {
  await supabaseAdmin
    .from("sync_jobs")
    .update({
      status:            "completed",
      records_processed: total,
      completed_at:      new Date().toISOString(),
    })
    .eq("id", jobId);
}

async function failJob(jobId: string, err: unknown) {
  await supabaseAdmin
    .from("sync_jobs")
    .update({
      status:        "failed",
      error_message: err instanceof Error ? err.message : String(err),
      completed_at:  new Date().toISOString(),
    })
    .eq("id", jobId);
}

async function resolveWooCreds(shopId: string): Promise<WooCredentials> {
  const { data } = await supabaseAdmin
    .from("woo_connections")
    .select("url, consumer_key, consumer_secret")
    .eq("shop_id", shopId)
    .single();

  if (!data) throw new Error("No WooCommerce connection found for this shop.");
  return { url: data.url, consumerKey: data.consumer_key, consumerSecret: data.consumer_secret };
}

// ── SKU upsert helpers ────────────────────────────────────────────────────────

function wooStatusToSkuStatus(wooStatus: string): string {
  if (wooStatus === "publish") return "active";
  if (wooStatus === "draft")   return "draft";
  return "archived";
}

async function upsertSimpleProduct(
  shopId:  string,
  product: Extract<WooProduct, { type: "simple" }>,
): Promise<boolean> {
  const skuCode = product.sku || `woo-${product.id}`;
  const { error } = await supabaseAdmin
    .from("skus")
    .upsert(
      {
        shop_id:    shopId,
        sku_code:   skuCode,
        title:      product.name,
        status:     wooStatusToSkuStatus(product.status),
        cost_price: product.price ? parseFloat(product.price) || null : null,
      },
      { onConflict: "shop_id,sku_code", ignoreDuplicates: false },
    );

  if (error) {
    console.error("[upsertSimpleProduct]", error.message);
    return false;
  }
  return true;
}

async function upsertVariation(
  shopId:     string,
  product:    Extract<WooProduct, { type: "variable" }>,
  variation:  WooVariation,
): Promise<boolean> {
  // Build a meaningful SKU code: prefer variation.sku, fall back to woo-{productId}-{varId}
  const skuCode = variation.sku || `woo-${product.id}-${variation.id}`;

  // Build a descriptive title from variation attributes
  const attrLabel = variation.attributes.map((a) => `${a.name}: ${a.option}`).join(", ");
  const title = attrLabel ? `${product.name} (${attrLabel})` : product.name;

  const { error } = await supabaseAdmin
    .from("skus")
    .upsert(
      {
        shop_id:    shopId,
        sku_code:   skuCode,
        title,
        status:     "active",
        cost_price: variation.price ? parseFloat(variation.price) || null : null,
      },
      { onConflict: "shop_id,sku_code", ignoreDuplicates: false },
    );

  if (error) {
    console.error("[upsertVariation]", error.message);
    return false;
  }
  return true;
}

// ── Sales history import ──────────────────────────────────────────────────────

async function importOrdersForShop(
  shopId: string,
  creds:  WooCredentials,
  jobId:  string,
  baseCount: number,
): Promise<number> {
  let orderCount = 0;

  for await (const orders of paginateOrders(creds)) {
    for (const order of orders) {
      for (const item of order.line_items) {
        if (!item.sku) continue;

        // Find the sku_id by sku_code
        const { data: skuRow } = await supabaseAdmin
          .from("skus")
          .select("id")
          .eq("shop_id", shopId)
          .eq("sku_code", item.sku)
          .maybeSingle();

        if (!skuRow) continue;

        // Use negative WooCommerce line item ID to avoid collision with Shopify IDs
        const { error } = await supabaseAdmin
          .from("sales_history")
          .upsert(
            {
              shop_id:               shopId,
              sku_id:                skuRow.id,
              quantity_sold:         item.quantity,
              shopify_line_item_id:  -item.id,  // negative = WooCommerce source
              sold_at:               order.date_created,
            },
            {
              onConflict:       "sku_id,shopify_line_item_id",
              ignoreDuplicates: true,
            },
          );

        if (!error) orderCount++;
      }
    }

    await updateJobProgress(jobId, baseCount + orderCount);
  }

  return orderCount;
}

// ── Main processor ────────────────────────────────────────────────────────────

export async function processWooMigration(
  jobId:         string,
  shopId:        string,
  includeOrders: boolean,
): Promise<void> {
  try {
    const creds = await resolveWooCreds(shopId);
    let synced = 0;

    // ── Phase 1: Products ──────────────────────────────────────────────────
    for await (const products of paginateProducts(creds)) {
      for (const product of products) {
        if (product.type === "simple") {
          const ok = await upsertSimpleProduct(shopId, product as Extract<WooProduct, { type: "simple" }>);
          if (ok) synced++;
        } else if (product.type === "variable") {
          const varProduct = product as Extract<WooProduct, { type: "variable" }>;
          const variations = await getVariations(creds, varProduct.id);
          for (const v of variations) {
            const ok = await upsertVariation(shopId, varProduct, v);
            if (ok) synced++;
          }
        }
      }
      await updateJobProgress(jobId, synced);
    }

    // ── Phase 2: Orders (optional) ─────────────────────────────────────────
    if (includeOrders) {
      const orderRecords = await importOrdersForShop(shopId, creds, jobId, synced);
      synced += orderRecords;
    }

    // ── Finalize ──────────────────────────────────────────────────────────
    await refreshSkuAnalytics();

    // Stamp migrated_at on the woo_connections record
    await supabaseAdmin
      .from("woo_connections")
      .update({ migrated_at: new Date().toISOString() })
      .eq("shop_id", shopId);

    await completeJob(jobId, synced);
  } catch (err) {
    console.error("[processWooMigration]", err);
    await failJob(jobId, err);
  }
}
