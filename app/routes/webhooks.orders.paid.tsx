import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  handleShopifyOrderPaid,
  type ShopifyOrderPayload,
} from "../integrations/bsale/realtime.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);

  const order = payload as ShopifyOrderPayload;

  // Await the handler — if Bsale is slow and Shopify times out (5s),
  // Shopify will retry and the idempotency guard in processed_webhooks
  // prevents double-adjustments.
  await handleShopifyOrderPaid(shop, order).catch((err) =>
    console.error("[webhooks.orders.paid]", err),
  );

  return new Response(null, { status: 200 });
};
