import type { ActionFunctionArgs } from "react-router";
import { data } from "react-router";
import { supabaseAdmin } from "../db.server";
import {
  handleBsaleDocumentAdd,
  handleShopifyOrderPaid,
  type ShopifyOrderPayload,
} from "../integrations/bsale/realtime.server";
import { emitBoleta, type ShopifyOrderForBoleta } from "../integrations/bsale/documents.server";
import { resolveToken } from "../integrations/bsale/client.server";
import { refreshSkuAnalytics } from "../models/sync.server";

const BATCH_SIZE    = 5;   // jobs processed per invocation
const RATE_LIMIT_MS = 500; // ms between jobs to avoid Bsale rate limits

/**
 * POST /api/worker
 *
 * Processes pending sync_jobs in batches. Secured via x-worker-secret header.
 * Called as fire-and-forget after each webhook enqueue, or via an external cron
 * (e.g. Railway cron, Fly.io scheduled machine) for reliability.
 */
export async function action({ request }: ActionFunctionArgs) {
  // Auth check — shared secret
  const authHeader = request.headers.get("x-worker-secret");
  if (authHeader !== process.env.WORKER_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Fetch pending jobs oldest-first
  const { data: jobs } = await supabaseAdmin
    .from("sync_jobs")
    .select("*")
    .eq("status", "pending")
    .in("type", ["bsale_document", "shopify_order", "emit_boleta", "shopify_sales_history", "bulk_publish"])
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (!jobs?.length) {
    return data({ processed: 0, errors: 0 });
  }

  let processed = 0;
  let errors    = 0;

  for (const job of jobs) {
    // Optimistic lock — claim the job only if it is still pending
    const { data: claimed } = await supabaseAdmin
      .from("sync_jobs")
      .update({ status: "processing", started_at: new Date().toISOString() })
      .eq("id", job.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();

    if (!claimed) continue; // another worker instance claimed it first

    try {
      await processJob(job.id, job.shop_id, job.type, job.payload as Record<string, unknown> ?? {});

      await supabaseAdmin
        .from("sync_jobs")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .eq("id", job.id);

      processed++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[worker] Error procesando job ${job.id} (${job.type}):`, message);

      await supabaseAdmin
        .from("sync_jobs")
        .update({
          status:        "error",
          error_message: message,
          completed_at:  new Date().toISOString(),
        })
        .eq("id", job.id);

      errors++;
    }

    // Rate limiting between jobs
    if (processed + errors < jobs.length) {
      await new Promise<void>((resolve) => setTimeout(resolve, RATE_LIMIT_MS));
    }
  }

  console.log(`[worker] Procesados: ${processed}, Errores: ${errors}`);
  return data({ processed, errors });
}

// ── Job handlers ──────────────────────────────────────────────────────────────

async function processJob(
  jobId:   string,
  shopId:  string,
  type:    string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (type === "bsale_document") {
    const resourceId = payload.resourceId as string;
    if (!resourceId) throw new Error("bsale_document job missing resourceId in payload");
    await handleBsaleDocumentAdd(shopId, resourceId);

  } else if (type === "shopify_order") {
    const order = payload.order as ShopifyOrderPayload;
    if (!order) throw new Error("shopify_order job missing order in payload");
    await handleShopifyOrderPaid(shopId, order);

  } else if (type === "emit_boleta") {
    const order    = payload.order as ShopifyOrderForBoleta;
    const officeId = (payload.officeId as number | undefined) ?? 1;
    if (!order) throw new Error("emit_boleta job missing order in payload");

    const { data: shopRow } = await supabaseAdmin
      .from("shops")
      .select("bsale_token")
      .eq("shop_id", shopId)
      .maybeSingle();

    if (!shopRow?.bsale_token) {
      console.log(`[worker] emit_boleta: shop ${shopId} has no Bsale token — skip`);
      return;
    }

    const token = resolveToken(shopRow.bsale_token);
    await emitBoleta(shopId, token, officeId, order);

  } else if (type === "shopify_sales_history") {
    await importShopifySalesHistory(shopId);

  } else if (type === "bulk_publish") {
    const skuIds = payload.sku_ids as string[] | undefined;
    if (!skuIds?.length) throw new Error("bulk_publish job missing sku_ids in payload");
    await handleBulkPublish(jobId, shopId, skuIds);

  } else {
    console.warn(`[worker] Unknown job type: ${type} — skipping`);
  }
}

// ── Shopify sales history import ───────────────────────────────────────────────

interface ShopifyRestLineItem {
  id:         number;
  quantity:   number;
  variant_id: number | null;
}

interface ShopifyRestOrder {
  id:         number;
  created_at: string;
  line_items: ShopifyRestLineItem[];
}

async function importShopifySalesHistory(shopId: string): Promise<void> {
  // Resolve offline access token from shopify_sessions
  const { data: session } = await supabaseAdmin
    .from("shopify_sessions")
    .select("access_token")
    .eq("shop", shopId)
    .eq("is_online", false)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const accessToken = session?.access_token;
  if (!accessToken) {
    throw new Error(`importShopifySalesHistory: no offline token found for ${shopId}`);
  }

  const since = new Date();
  since.setDate(since.getDate() - 365); // last 12 months

  let nextUrl: string | null =
    `https://${shopId}/admin/api/2026-04/orders.json` +
    `?limit=250&status=any&created_at_min=${since.toISOString()}&fields=id,created_at,line_items`;

  let totalProcessed = 0;

  while (nextUrl) {
    const res: Response = await fetch(nextUrl, {
      headers: { "X-Shopify-Access-Token": accessToken },
    });

    if (!res.ok) throw new Error(`Shopify orders REST: HTTP ${res.status}`);

    const json = await res.json() as { orders?: ShopifyRestOrder[] };
    const orders = json.orders ?? [];

    if (orders.length > 0) {
      const variantIds = [
        ...new Set(
          orders.flatMap((o) =>
            o.line_items.map((li) => li.variant_id).filter((id): id is number => id != null),
          ),
        ),
      ];

      const { data: skus } = await supabaseAdmin
        .from("skus")
        .select("id, shopify_variant_id")
        .eq("shop_id", shopId)
        .in("shopify_variant_id", variantIds);

      const skuMap = new Map<number, string>();
      for (const s of skus ?? []) {
        if (s.shopify_variant_id != null) skuMap.set(s.shopify_variant_id, s.id);
      }

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
            channel:              "shopify",
          });
        }
      }

      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await supabaseAdmin
          .from("sales_history")
          .upsert(rows.slice(i, i + 500), { onConflict: "sku_id,shopify_line_item_id" });
        if (!error) totalProcessed += Math.min(500, rows.length - i);
      }
    }

    // Cursor-based pagination via Link header
    const link: string = res.headers.get("Link") ?? "";
    const match: RegExpMatchArray | null = link.match(/<([^>]+)>;\s*rel="next"/);
    nextUrl = match ? match[1] : null;
  }

  await refreshSkuAnalytics();
  console.log(`[worker] importShopifySalesHistory done. processed=${totalProcessed}`);
}

// ── Bulk publish (Bsale SKUs → Shopify products) ───────────────────────────

interface ShopifyRestVariant {
  id:                number;
  inventory_item_id: number;
}

interface ShopifyRestProduct {
  id:       number;
  variants: ShopifyRestVariant[];
}

async function handleBulkPublish(
  jobId:   string,
  shopId:  string,
  skuIds:  string[],
): Promise<void> {
  // Resolve offline access token
  const { data: sessionRow } = await supabaseAdmin
    .from("shopify_sessions")
    .select("access_token")
    .eq("shop", shopId)
    .eq("is_online", false)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const accessToken = sessionRow?.access_token;
  if (!accessToken) throw new Error(`handleBulkPublish: no offline token for ${shopId}`);

  // Resolve first location
  const locRes: Response = await fetch(
    `https://${shopId}/admin/api/2026-04/locations.json?limit=1`,
    { headers: { "X-Shopify-Access-Token": accessToken } },
  );
  if (!locRes.ok) throw new Error(`handleBulkPublish: locations HTTP ${locRes.status}`);
  const locJson = await locRes.json() as { locations?: Array<{ id: number }> };
  const locationId = locJson.locations?.[0]?.id;
  if (!locationId) throw new Error("handleBulkPublish: no location found");

  let published = 0;

  for (const skuId of skuIds) {
    // Check if job was cancelled before each SKU
    const { data: jobRow } = await supabaseAdmin
      .from("sync_jobs")
      .select("status")
      .eq("id", jobId)
      .maybeSingle();
    if (jobRow?.status === "cancelled") {
      console.log(`[worker] bulk_publish job ${jobId} cancelled after ${published} SKUs`);
      return;
    }

    // Fetch the SKU
    const { data: sku } = await supabaseAdmin
      .from("skus")
      .select("id, sku_code, title, vendor, sale_price, cost_price, barcode")
      .eq("shop_id", shopId)
      .eq("id", skuId)
      .is("shopify_variant_id", null)
      .maybeSingle();

    if (!sku) continue; // already published or deleted

    try {
      // Step 1: create product
      const createRes: Response = await fetch(
        `https://${shopId}/admin/api/2026-04/products.json`,
        {
          method:  "POST",
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
          body: JSON.stringify({
            product: {
              title:    sku.title || sku.sku_code,
              status:   "active",
              ...(sku.vendor ? { vendor: sku.vendor } : {}),
              variants: [{
                sku:     sku.sku_code,
                price:   sku.sale_price != null ? String(sku.sale_price) : "0",
                barcode: sku.barcode ?? undefined,
              }],
            },
          }),
        },
      );

      if (!createRes.ok) {
        console.warn(`[worker] bulk_publish: productCreate failed for ${sku.sku_code} — HTTP ${createRes.status}`);
        continue;
      }

      const createJson = await createRes.json() as { product?: ShopifyRestProduct };
      const product = createJson.product;
      if (!product) continue;

      const productId       = product.id;
      const variant         = product.variants[0];
      if (!variant) continue;
      const variantId       = variant.id;
      const inventoryItemId = variant.inventory_item_id;

      // Step 2: enable inventory tracking
      await fetch(
        `https://${shopId}/admin/api/2026-04/inventory_items/${inventoryItemId}.json`,
        {
          method:  "PUT",
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
          body: JSON.stringify({ inventory_item: { tracked: true } }),
        },
      );

      // Step 3: set stock from Supabase inventory_levels
      const { data: invLevel } = await supabaseAdmin
        .from("inventory_levels")
        .select("quantity")
        .eq("shop_id", shopId)
        .eq("sku_id", skuId)
        .order("quantity", { ascending: false })
        .limit(1)
        .maybeSingle();

      const stockQty = invLevel?.quantity ?? 0;
      if (stockQty > 0) {
        await fetch(
          `https://${shopId}/admin/api/2026-04/inventory_levels/set.json`,
          {
            method:  "POST",
            headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
            body: JSON.stringify({ location_id: locationId, inventory_item_id: inventoryItemId, available: stockQty }),
          },
        );
      }

      // Step 4: update Supabase
      await supabaseAdmin
        .from("skus")
        .update({ shopify_product_id: productId, shopify_variant_id: variantId, updated_at: new Date().toISOString() })
        .eq("shop_id", shopId)
        .eq("id", skuId);

      published++;
    } catch (err) {
      console.warn(`[worker] bulk_publish: error for SKU ${skuId}:`, err);
    }

    // Update progress
    await supabaseAdmin
      .from("sync_jobs")
      .update({ records_processed: published })
      .eq("id", jobId);

    // Pace requests — 1 product per 500ms to avoid rate limits
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }

  await refreshSkuAnalytics();
  console.log(`[worker] bulk_publish done. published=${published}/${skuIds.length}`);
}
