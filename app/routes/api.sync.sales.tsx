import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../db.server";
import { refreshSkuAnalytics } from "../models/sync.server";

interface ShopifyLineItem {
  id:         number;
  quantity:   number;
  variant_id: number | null;
}

interface ShopifyOrder {
  id:         number;
  created_at: string;
  line_items: ShopifyLineItem[];
}

/**
 * POST /api/sync/sales
 *
 * Paginates GET /orders.json via Shopify REST API (last 1 year), inserts every
 * line item into sales_history, and tracks progress in sync_jobs so the
 * existing /api/sync/status?jobId= polling works unchanged.
 *
 * Fire-and-forget: returns {job} immediately; processing continues in the
 * background Node.js event loop.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session }   = await authenticate.admin(request);
  const shopId        = session.shop;
  const accessToken   = session.accessToken as string;

  // Check for active job (avoid duplicates)
  const { data: existing } = await supabaseAdmin
    .from("sync_jobs")
    .select("id, status")
    .eq("shop_id", shopId)
    .in("status", ["pending", "running"])
    .limit(1)
    .maybeSingle();

  if (existing) return { job: existing };

  const { data: job, error } = await supabaseAdmin
    .from("sync_jobs")
    .insert({
      shop_id:  shopId,
      type:     "orders_sync",
      status:   "running",
    })
    .select()
    .single();

  if (error || !job) return { error: "No se pudo crear el job de sync" };

  // Fire-and-forget
  syncSalesFromShopify(shopId, accessToken, job.id).catch((err) =>
    console.error("[api.sync.sales] background error:", err),
  );

  return { job };
};

async function syncSalesFromShopify(
  shopId:      string,
  accessToken: string,
  jobId:       string,
) {
  const since = new Date();
  since.setFullYear(since.getFullYear() - 1);
  const sinceIso = since.toISOString();

  let nextUrl: string | null =
    `https://${shopId}/admin/api/2026-04/orders.json` +
    `?limit=250&status=any&created_at_min=${sinceIso}&fields=id,created_at,line_items`;

  let totalProcessed = 0;

  try {
    while (nextUrl) {
      const res: Response = await fetch(nextUrl, {
        headers: { "X-Shopify-Access-Token": accessToken },
      });

      if (!res.ok) throw new Error(`Shopify REST orders: HTTP ${res.status}`);

      const json = await res.json() as { orders?: ShopifyOrder[] };
      const orders = json.orders ?? [];

      if (orders.length > 0) {
        // Collect unique variant IDs from this page
        const variantIds = [
          ...new Set(
            orders.flatMap((o) =>
              o.line_items
                .map((li) => li.variant_id)
                .filter((id): id is number => id != null),
            ),
          ),
        ];

        // Resolve variant_id → sku UUID
        const { data: skus } = await supabaseAdmin
          .from("skus")
          .select("id, shopify_variant_id")
          .eq("shop_id", shopId)
          .in("shopify_variant_id", variantIds);

        const skuMap = new Map<number, string>();
        for (const s of skus ?? []) {
          if (s.shopify_variant_id != null) skuMap.set(s.shopify_variant_id, s.id);
        }

        // Build upsert rows
        const rows: object[] = [];
        for (const order of orders) {
          for (const li of order.line_items) {
            if (!li.variant_id || (li.quantity ?? 0) <= 0) continue;
            const skuId = skuMap.get(li.variant_id);
            if (!skuId) continue;
            rows.push({
              shop_id:              shopId,
              sku_id:               skuId,
              shopify_order_id:     order.id,
              shopify_line_item_id: li.id,
              quantity_sold:        li.quantity,
              sold_at:              order.created_at,
            });
          }
        }

        for (let i = 0; i < rows.length; i += 500) {
          const { error } = await supabaseAdmin
            .from("sales_history")
            .upsert(rows.slice(i, i + 500), {
              onConflict: "sku_id,shopify_line_item_id",
            });
          if (!error) totalProcessed += Math.min(500, rows.length - i);
        }

        // Update progress
        await supabaseAdmin
          .from("sync_jobs")
          .update({ records_processed: totalProcessed })
          .eq("id", jobId);
      }

      // Cursor-based pagination via Link header
      const link: string = res.headers.get("Link") ?? "";
      const match: RegExpMatchArray | null = link.match(/<([^>]+)>;\s*rel="next"/);
      nextUrl = match ? match[1] : null;
    }

    await supabaseAdmin
      .from("sync_jobs")
      .update({
        status:            "completed",
        records_processed: totalProcessed,
        completed_at:      new Date().toISOString(),
      })
      .eq("id", jobId);

    await refreshSkuAnalytics();
    console.log(`[api.sync.sales] done. processed=${totalProcessed}`);
  } catch (err) {
    console.error("[api.sync.sales] failed:", err);
    await supabaseAdmin
      .from("sync_jobs")
      .update({
        status:        "failed",
        error_message: String(err),
        completed_at:  new Date().toISOString(),
      })
      .eq("id", jobId);
  }
}
