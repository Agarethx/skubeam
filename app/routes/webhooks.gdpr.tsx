import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  const p = payload as {
    customer?: { id: number };
    orders_to_redact?: number[];
  };

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
      await supabaseAdmin.from("gdpr_requests").insert({
        shop_id: shop,
        type: "data_request",
        customer_id: p.customer?.id ?? null,
      });
      break;

    case "CUSTOMERS_REDACT":
      if (p.orders_to_redact && p.orders_to_redact.length > 0) {
        await supabaseAdmin
          .from("sales_history")
          .update({ shopify_order_id: null })
          .eq("shop_id", shop)
          .in("shopify_order_id", p.orders_to_redact);
      }
      await supabaseAdmin.from("gdpr_requests").insert({
        shop_id: shop,
        type: "customer_redact",
        customer_id: p.customer?.id ?? null,
      });
      break;

    case "SHOP_REDACT":
      // Cascade deletes all shop data via FK ON DELETE CASCADE
      await supabaseAdmin.from("shops").delete().eq("shop_id", shop);
      break;
  }

  return new Response(null, { status: 200 });
};
