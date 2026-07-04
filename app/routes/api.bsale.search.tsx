import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../db.server";
import { searchBsaleProducts, type BsaleSearchVariant } from "../integrations/bsale/products.server";
import { resolveToken } from "../integrations/bsale/client.server";

/**
 * GET /api/bsale/search?q=<query>
 *
 * On-demand search against Bsale (exact SKU code + partial product name) — never
 * imports the whole catalog. Used by the "Sin publicar" tab's search box.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();

  if (!q) return { results: [] as BsaleSearchVariant[] };

  const { data: shop } = await supabaseAdmin
    .from("shops")
    .select("bsale_token, bsale_price_list_id")
    .eq("shop_id", shopId)
    .single();

  if (!shop?.bsale_price_list_id) {
    return { results: [] as BsaleSearchVariant[], error: "No hay lista de precios configurada. Ve a Integraciones → Bsale." };
  }

  try {
    const token   = resolveToken(shop.bsale_token);
    const results = await searchBsaleProducts(token, shop.bsale_price_list_id, q);
    return { results };
  } catch (err) {
    return { results: [] as BsaleSearchVariant[], error: err instanceof Error ? err.message : String(err) };
  }
};
