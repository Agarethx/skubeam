import type { ActionFunctionArgs } from "react-router";
import type { BsaleNotification } from "../integrations/bsale/realtime.server";
import { supabaseAdmin } from "../db.server";

/**
 * POST /webhooks/bsale/document?shop=<myshopify-domain>
 *
 * Public endpoint — Bsale calls this when a sale document (boleta/factura)
 * is created. The merchant registers this URL manually in the Bsale panel
 * (Configuración → Webhooks), including the ?shop= query param.
 *
 * Strategy: enqueue a sync_jobs row and respond 200 immediately.
 * A worker processes the job asynchronously to keep response time under 500ms.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    // 1. Verify secret token
    const secret = process.env.BSALE_WEBHOOK_SECRET;
    if (secret) {
      const incoming = request.headers.get("x-bsale-secret") ?? "";
      if (incoming !== secret) {
        console.warn("[webhooks.bsale.document] Invalid x-bsale-secret header");
        return new Response(null, { status: 200 });
      }
    }

    // 2. Resolve shop domain from query param
    const url        = new URL(request.url);
    const shopDomain = url.searchParams.get("shop");
    if (!shopDomain) {
      console.error("[webhooks.bsale.document] Missing ?shop= param");
      return new Response(null, { status: 200 });
    }

    // 3. Parse Bsale notification (lightweight — only carries resourceId + resource)
    const notification = await request.json() as BsaleNotification;
    console.log("[bsale-webhook] notification:", JSON.stringify(notification));

    const { resourceId } = notification;
    if (!resourceId) {
      console.error("[webhooks.bsale.document] Missing resourceId in notification");
      return new Response(null, { status: 200 });
    }

    // 4. Enqueue job — do NOT process here
    await supabaseAdmin
      .from("sync_jobs")
      .insert({
        shop_id: shopDomain,
        type:    "bsale_document",
        payload: { resourceId },
        status:  "pending",
      });

    console.log(`[bsale-webhook] Enqueued bsale_document job for shop ${shopDomain} resourceId ${resourceId}`);

    // 5. Fire-and-forget worker trigger (non-blocking)
    const appUrl      = process.env.APP_URL;
    const workerSecret = process.env.WORKER_SECRET;
    if (appUrl && workerSecret) {
      fetch(`${appUrl}/api/worker`, {
        method:  "POST",
        headers: { "x-worker-secret": workerSecret },
      }).catch(() => {});
    }
  } catch (err) {
    console.error("[webhooks.bsale.document]", err);
  }

  return new Response(null, { status: 200 });
};
