import type { ActionFunctionArgs } from "react-router";
import {
  handleBsaleDocumentAdd,
  type BsaleNotification,
} from "../integrations/bsale/realtime.server";

/**
 * POST /webhooks/bsale/document?shop=<myshopify-domain>
 *
 * Public endpoint — Bsale calls this when a sale document (boleta/factura)
 * is created. The merchant registers this URL manually in the Bsale panel
 * (Configuración → Webhooks), including the ?shop= query param.
 *
 * Verification: optional header `x-bsale-secret` checked against
 * env var BSALE_WEBHOOK_SECRET. If the env var is not set, verification
 * is skipped (useful for local dev).
 *
 * Always returns 200 so Bsale does not retry.
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
    console.log("[bsale-webhook] notification:", JSON.stringify(notification, null, 2));

    const { resourceId } = notification;
    if (!resourceId) {
      console.error("[webhooks.bsale.document] Missing resourceId in notification");
      return new Response(null, { status: 200 });
    }

    // 4. Fetch full Bsale document and adjust Shopify inventory
    // (handler loads its own GraphQL client from the stored offline session)
    await handleBsaleDocumentAdd(shopDomain, resourceId);
  } catch (err) {
    console.error("[webhooks.bsale.document]", err);
  }

  return new Response(null, { status: 200 });
};
