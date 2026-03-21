import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import type { ShopifyOrderPayload } from "../integrations/bsale/realtime.server";
import type { ShopifyOrderForBoleta } from "../integrations/bsale/documents.server";
import { supabaseAdmin } from "../db.server";

/**
 * ORDERS_PAID webhook — enqueue jobs and respond 200 immediately.
 *
 * Two jobs are enqueued when applicable:
 *   - shopify_order: adjust Bsale stock for each line item
 *   - emit_boleta:   emit electronic boleta in Bsale (only if addon active)
 *
 * A worker processes jobs asynchronously to avoid Shopify's 5s timeout.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);

  const order = payload as ShopifyOrderPayload & ShopifyOrderForBoleta;

  const jobs: Array<{ shop_id: string; type: string; payload: Record<string, unknown>; status: string }> = [
    {
      shop_id: shop,
      type:    "shopify_order",
      payload: { order },
      status:  "pending",
    },
  ];

  // Check if the shop has the bsale_documents addon active — one lightweight DB read
  try {
    const { data: shopRow } = await supabaseAdmin
      .from("shops")
      .select("bsale_token, active_addons, bsale_default_office_id")
      .eq("shop_id", shop)
      .maybeSingle();

    if (shopRow?.bsale_token && shopRow.active_addons?.includes("bsale_documents")) {
      jobs.push({
        shop_id: shop,
        type:    "emit_boleta",
        payload: { order, officeId: shopRow.bsale_default_office_id ?? 1 },
        status:  "pending",
      });
    }
  } catch (e) {
    console.error("[webhooks.orders.paid] Error checking shop addons:", e);
  }

  await supabaseAdmin.from("sync_jobs").insert(jobs);

  console.log(`[webhooks.orders.paid] Enqueued ${jobs.map((j) => j.type).join(", ")} for order ${order.id}`);

  // Fire-and-forget worker trigger (non-blocking)
  const appUrl       = process.env.APP_URL;
  const workerSecret = process.env.WORKER_SECRET;
  if (appUrl && workerSecret) {
    fetch(`${appUrl}/api/worker`, {
      method:  "POST",
      headers: { "x-worker-secret": workerSecret },
    }).catch(() => {});
  }

  return new Response(null, { status: 200 });
};
