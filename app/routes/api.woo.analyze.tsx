import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../db.server";
import { getWooCounts } from "../integrations/woo/client.server";

/**
 * POST /api/woo/analyze
 *
 * Connects to the merchant's WooCommerce store, counts products and orders,
 * saves (or updates) the woo_connections record, and returns the counts.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  const formData      = await request.formData();
  const storeUrl      = ((formData.get("store_url")       as string) ?? "").trim().replace(/\/$/, "");
  const consumerKey   = ((formData.get("consumer_key")    as string) ?? "").trim();
  const consumerSecret= ((formData.get("consumer_secret") as string) ?? "").trim();

  if (!storeUrl || !consumerKey || !consumerSecret) {
    return { error: "Completa todos los campos antes de analizar." };
  }

  const creds = { url: storeUrl, consumerKey, consumerSecret };

  let productCount: number;
  let orderCount: number;

  try {
    const counts = await getWooCounts(creds);
    productCount = counts.productCount;
    orderCount   = counts.orderCount;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("401") || msg.includes("403")) {
      return { error: "Credenciales incorrectas. Verifica el Consumer Key y Consumer Secret." };
    }
    return { error: "No se pudo alcanzar la tienda. Verifica la URL y que la REST API esté habilitada." };
  }

  // Save / update the connection record (one per shop)
  await supabaseAdmin
    .from("woo_connections")
    .upsert(
      {
        shop_id:         shopId,
        url:             storeUrl,
        consumer_key:    consumerKey,
        consumer_secret: consumerSecret,
        product_count:   productCount,
        order_count:     orderCount,
        analyzed_at:     new Date().toISOString(),
      },
      { onConflict: "shop_id" },
    );

  return { productCount, orderCount };
};
