import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { publishSkuToShopify } from "../models/publish.server";

/**
 * POST /api/publish-sku
 *
 * Creates a Shopify product for a SkuBeam SKU that has no shopify_variant_id yet
 * (e.g. imported from WooCommerce migration or created manually).
 *
 * Body: sku_id (UUID)
 * Returns: { success: true, shopifyProductId } | { error: string }
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const skuId    = (formData.get("sku_id") as string | null)?.trim();

  if (!skuId) return { error: "sku_id requerido" };

  const result = await publishSkuToShopify(admin, session.shop, session.accessToken as string, skuId);
  return result.success ? { success: true, shopifyProductId: result.shopifyProductId } : { error: result.error };
};
