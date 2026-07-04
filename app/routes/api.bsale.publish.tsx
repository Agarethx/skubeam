import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../db.server";
import { publishSkuToShopify } from "../models/publish.server";

interface PublishItem {
  sku_code:            string;
  product_name:        string;
  variant_description: string | null;
  price:               number | null;
  barcode:             string | null;
  bsale_variant_id:    string;
}

interface ItemResult {
  sku_code: string;
  success:  boolean;
  error?:   string;
}

/**
 * POST /api/bsale/publish
 *
 * One-step publish: takes one or several Bsale search results (never pre-imported —
 * fetched live by api.bsale.search.tsx), stages each as a skus row, and immediately
 * publishes it to Shopify via the same logic as the per-row "Publicar" button.
 *
 * Body (JSON): { items: PublishItem[] }
 * Returns: { results: ItemResult[] }
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shopId      = session.shop;
  const accessToken = session.accessToken as string;

  const body = await request.json() as { items?: PublishItem[] };
  const items = body.items ?? [];
  if (items.length === 0) return { results: [] as ItemResult[] };

  const results: ItemResult[] = [];

  // Sequential — each publish is several Shopify round-trips, and this is a small,
  // user-initiated batch (not a bulk import), so there's no need to parallelize.
  for (const item of items) {
    const skuCode = item.sku_code.trim();
    if (!skuCode) { results.push({ sku_code: item.sku_code, success: false, error: "SKU vacío" }); continue; }

    const { data: existing } = await supabaseAdmin
      .from("skus")
      .select("id, shopify_variant_id")
      .eq("shop_id", shopId)
      .eq("sku_code", skuCode)
      .maybeSingle();

    if (existing?.shopify_variant_id) {
      results.push({ sku_code: skuCode, success: false, error: "Ya está publicado en Shopify" });
      continue;
    }

    let skuId: string;
    if (existing) {
      const { error } = await supabaseAdmin
        .from("skus")
        .update({
          title:            item.product_name + (item.variant_description ? ` - ${item.variant_description}` : ""),
          sale_price:       item.price,
          barcode:          item.barcode,
          bsale_variant_id: item.bsale_variant_id,
          status:           "active",
        })
        .eq("id", existing.id);
      if (error) { results.push({ sku_code: skuCode, success: false, error: error.message }); continue; }
      skuId = existing.id;
    } else {
      const { data: inserted, error } = await supabaseAdmin
        .from("skus")
        .insert({
          shop_id:          shopId,
          sku_code:         skuCode,
          title:            item.product_name + (item.variant_description ? ` - ${item.variant_description}` : ""),
          sale_price:       item.price,
          barcode:          item.barcode,
          bsale_variant_id: item.bsale_variant_id,
          status:           "active",
        })
        .select("id")
        .single();
      if (error || !inserted) { results.push({ sku_code: skuCode, success: false, error: error?.message ?? "insert failed" }); continue; }
      skuId = inserted.id;
    }

    const publishResult = await publishSkuToShopify(admin, shopId, accessToken, skuId);
    results.push(
      publishResult.success
        ? { sku_code: skuCode, success: true }
        : { sku_code: skuCode, success: false, error: publishResult.error },
    );
  }

  return { results };
};
