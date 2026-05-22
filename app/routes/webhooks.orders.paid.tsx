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
  console.log("[orders.paid] ── WEBHOOK RECIBIDO ──────────────────────────────");

  const { shop, payload } = await authenticate.webhook(request);
  const order = payload as ShopifyOrderPayload & ShopifyOrderForBoleta;

  console.log("[orders.paid] Autenticado OK", {
    shop,
    orderId:    order.id,
    lineItems:  order.line_items?.length ?? 0,
    totalPrice: order.total_price,
  });

  const jobs: Array<{ shop_id: string; type: string; payload: Record<string, unknown>; status: string }> = [
    {
      shop_id: shop,
      type:    "shopify_order",
      payload: { order },
      status:  "pending",
    },
  ];

  console.log("[orders.paid] Job shopify_order encolado (ajuste stock Bsale)");

  try {
    const { data: shopRow, error: shopErr } = await supabaseAdmin
      .from("shops")
      .select("bsale_token, active_addons, bsale_office_id")
      .eq("shop_id", shop)
      .maybeSingle();

    console.log("[orders.paid] Shop DB lookup", {
      found:         !!shopRow,
      hasToken:      !!shopRow?.bsale_token,
      activeAddons:  shopRow?.active_addons ?? [],
      officeId:      shopRow?.bsale_office_id ?? null,
      dbError:       shopErr?.message ?? null,
    });

    if (shopRow?.bsale_token && shopRow.active_addons?.includes("bsale_documents")) {
      const officeId = shopRow.bsale_office_id ?? 1;
      jobs.push({
        shop_id: shop,
        type:    "emit_boleta",
        payload: { order, officeId },
        status:  "pending",
      });
      console.log("[orders.paid] Job emit_boleta encolado", { officeId });
    } else {
      const reason = !shopRow?.bsale_token
        ? "sin token Bsale"
        : "addon bsale_documents inactivo";
      console.log(`[orders.paid] emit_boleta NO encolado — ${reason}`);
    }
  } catch (e) {
    console.error("[orders.paid] Error consultando shop addons:", e);
  }

  const { error: insertErr } = await supabaseAdmin.from("sync_jobs").insert(jobs);
  if (insertErr) {
    console.error("[orders.paid] Error insertando jobs en sync_jobs:", insertErr.message);
  } else {
    console.log(`[orders.paid] Jobs insertados en sync_jobs: [${jobs.map((j) => j.type).join(", ")}]`);
  }

  // Fire-and-forget worker trigger
  const appUrl       = process.env.APP_URL ?? process.env.SHOPIFY_APP_URL;
  const workerSecret = process.env.WORKER_SECRET;

  console.log("[orders.paid] Disparando worker", {
    appUrl:        appUrl ?? "(no configurado)",
    hasSecret:     !!workerSecret,
    workerUrl:     appUrl ? `${appUrl}/api/worker` : "(no se dispara)",
  });

  if (appUrl && workerSecret) {
    fetch(`${appUrl}/api/worker`, {
      method:  "POST",
      headers: { "x-worker-secret": workerSecret },
    }).catch((err) => {
      console.error("[orders.paid] Error disparando worker:", err);
    });
  } else {
    console.warn("[orders.paid] Worker NO disparado — falta APP_URL o WORKER_SECRET en .env");
  }

  console.log("[orders.paid] Respondiendo 200 a Shopify");
  return new Response(null, { status: 200 });
};
