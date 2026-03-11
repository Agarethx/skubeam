import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Webhook ${topic} for ${shop}`);

  // Mark shop inactive — data deleted 48h later via SHOP_REDACT
  await supabaseAdmin
    .from("shops")
    .update({
      is_active: false,
      uninstalled_at: new Date().toISOString(),
    })
    .eq("shop_id", shop);

  // Delete sessions so the merchant must re-auth on reinstall
  await supabaseAdmin.from("shopify_sessions").delete().eq("shop", shop);

  return new Response(null, { status: 200 });
};
