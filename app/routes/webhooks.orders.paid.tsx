import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  handleShopifyOrderPaid,
  type ShopifyOrderPayload,
} from "../integrations/bsale/realtime.server";
import { emitBoleta, type ShopifyOrderForBoleta } from "../integrations/bsale/documents.server";
import { resolveToken } from "../integrations/bsale/client.server";
import { supabaseAdmin } from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);

  const order = payload as ShopifyOrderPayload & ShopifyOrderForBoleta;

  // Await the handler — if Bsale is slow and Shopify times out (5s),
  // Shopify will retry and the idempotency guard in processed_webhooks
  // prevents double-adjustments.
  await handleShopifyOrderPaid(shop, order).catch((err) =>
    console.error("[webhooks.orders.paid]", err),
  );

  // Emit boleta if the shop has Bsale connected and the add-on active
  try {
    const { data: shopRow } = await supabaseAdmin
      .from("shops")
      .select("bsale_token, active_addons, bsale_default_office_id")
      .eq("shop_id", shop)
      .maybeSingle();

    console.log("[orders-webhook] shop:", shop);
    console.log("[orders-webhook] active_addons:", shopRow?.active_addons);
    console.log("[orders-webhook] bsale_token exists:", !!shopRow?.bsale_token);
    console.log("[orders-webhook] bsale_documents addon:", shopRow?.active_addons?.includes("bsale_documents"));

    if (shopRow?.bsale_token && shopRow.active_addons?.includes("bsale_documents")) {
      const token    = resolveToken(shopRow.bsale_token);
      const officeId = shopRow.bsale_default_office_id ?? 1;
      await emitBoleta(shop, token, officeId, order);
    }
  } catch (e) {
    // Non-fatal — boleta emission must never break stock sync
    console.error("[orders] Error en emitBoleta:", e);
  }

  return new Response(null, { status: 200 });
};
