import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { upsertSkuFromShopify } from "../models/sku.server";
import type { ShopifyVariantPayload } from "../models/sku.server";

// ── Shopify webhook payload types ─────────────────────────────────────────────

interface ShopifyVariant {
  id: number;
  product_id: number;
  title: string;
  sku: string;
  barcode: string | null;
}

interface ShopifyProductPayload {
  id: number;
  title: string;
  vendor: string;
  product_type: string;
  status: string;      // "active" | "archived" | "draft"
  tags: string;        // comma-separated in webhook payload
  variants: ShopifyVariant[];
}

// ── Handler ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);

  const product = payload as ShopifyProductPayload;

  // tags arrives as "tag1, tag2, tag3" — normalise to string[]
  const tags = product.tags
    ? product.tags.split(",").map((t) => t.trim()).filter(Boolean)
    : [];

  // Build variant title: "Product Title" or "Product Title - Variant Title"
  // when variant title is "Default Title" it adds no information.
  const variantPayloads: ShopifyVariantPayload[] = product.variants.map((v) => {
    const variantLabel =
      v.title && v.title !== "Default Title" ? ` - ${v.title}` : "";

    return {
      shopify_variant_id: v.id,
      shopify_product_id: v.product_id ?? product.id,
      sku_code:           v.sku ?? "",
      barcode:            v.barcode ?? null,
      title:              `${product.title}${variantLabel}`,
      vendor:             product.vendor ?? null,
      product_type:       product.product_type ?? null,
      tags,
      status:             product.status ?? "active",
    };
  });

  // upsertSkuFromShopify skips variants without sku_code and is fully idempotent
  await upsertSkuFromShopify(shop, variantPayloads);

  return new Response(null, { status: 200 });
};
