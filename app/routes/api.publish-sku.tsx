import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../db.server";
import { refreshSkuAnalytics } from "../models/sync.server";

const PRODUCT_CREATE_MUTATION = `
  mutation productCreate($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product {
        id
        variants(first: 1) { nodes { id inventoryItem { id } } }
      }
      userErrors { field message }
    }
  }
`;

const VARIANT_UPDATE_MUTATION = `
  mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      userErrors { field message }
    }
  }
`;

const INVENTORY_ITEM_UPDATE_MUTATION = `
  mutation inventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
    inventoryItemUpdate(id: $id, input: $input) {
      inventoryItem { id }
      userErrors { field message }
    }
  }
`;

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
  const shopId   = session.shop;
  const formData = await request.formData();
  const skuId    = (formData.get("sku_id") as string | null)?.trim();

  if (!skuId) return { error: "sku_id requerido" };

  // ── Load SKU ──────────────────────────────────────────────────────────────
  const { data: sku } = await supabaseAdmin
    .from("skus")
    .select("id, sku_code, title, vendor, cost_price")
    .eq("shop_id", shopId)
    .eq("id", skuId)
    .is("shopify_variant_id", null)
    .single();

  if (!sku) return { error: "SKU no encontrado o ya publicado en Shopify" };

  // ── Resolve first Shopify location ────────────────────────────────────────
  const locRes  = await admin.graphql(`#graphql
    query GetFirstLocation {
      locations(first: 1, includeLegacy: false) {
        edges { node { id } }
      }
    }
  `);
  const locJson = await locRes.json() as {
    data?: { locations?: { edges: Array<{ node: { id: string } }> } };
  };
  const locationGid = locJson.data?.locations?.edges[0]?.node.id;
  if (!locationGid) return { error: "No se encontró ninguna ubicación en Shopify" };

  // ── Step 1: productCreate ─────────────────────────────────────────────────
  const createRes  = await admin.graphql(PRODUCT_CREATE_MUTATION, {
    variables: {
      product: {
        title:  sku.title || sku.sku_code,
        status: "ACTIVE",
        ...(sku.vendor ? { vendor: sku.vendor } : {}),
      },
    },
  });
  const createJson = await createRes.json() as {
    data?: {
      productCreate?: {
        product?:   { id: string; variants: { nodes: Array<{ id: string; inventoryItem: { id: string } }> } };
        userErrors: Array<{ field: string; message: string }>;
      };
    };
  };

  const productCreate = createJson.data?.productCreate;
  if (productCreate?.userErrors?.length) {
    return { error: `Error creando producto: ${productCreate.userErrors.map((e) => e.message).join(", ")}` };
  }
  const product = productCreate?.product;
  if (!product) return { error: "productCreate no devolvió producto" };

  const productGid       = product.id;
  const variantNode      = product.variants.nodes[0];
  if (!variantNode) return { error: "No se creó el variant por defecto" };
  const variantGid       = variantNode.id;
  const inventoryItemGid = variantNode.inventoryItem.id;

  // ── Step 2: set variant price (SKU goes on inventoryItem, not variant) ───
  const variantInput: Record<string, unknown> = { id: variantGid };
  if (sku.cost_price) variantInput.price = String(sku.cost_price);

  await admin.graphql(VARIANT_UPDATE_MUTATION, {
    variables: { productId: productGid, variants: [variantInput] },
  });

  // ── Step 3: enable inventory tracking ────────────────────────────────────
  await admin.graphql(INVENTORY_ITEM_UPDATE_MUTATION, {
    variables: { id: inventoryItemGid, input: { tracked: true, sku: sku.sku_code } },
  });

  const productNumericId      = productGid.split("/").pop()!;
  const inventoryItemNumericId = parseInt(inventoryItemGid.split("/").pop()!, 10);
  const locationNumericId      = parseInt(locationGid.split("/").pop()!, 10);
  const accessToken            = session.accessToken as string;

  // ── Step 4: publish to online store via REST ──────────────────────────────
  await fetch(`https://${shopId}/admin/api/2026-04/products/${productNumericId}.json`, {
    method:  "PUT",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
    body:    JSON.stringify({ product: { id: Number(productNumericId), published: true } }),
  });

  // ── Step 5: set stock if we have an inventory level ───────────────────────
  const { data: invLevel } = await supabaseAdmin
    .from("inventory_levels")
    .select("quantity")
    .eq("shop_id", shopId)
    .eq("sku_id", skuId)
    .order("quantity", { ascending: false })
    .limit(1)
    .maybeSingle();

  const stockQty = invLevel?.quantity ?? 0;
  if (stockQty > 0) {
    await fetch(`https://${shopId}/admin/api/2026-04/inventory_levels/set.json`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
      body:    JSON.stringify({
        location_id:       locationNumericId,
        inventory_item_id: inventoryItemNumericId,
        available:         stockQty,
      }),
    });
  }

  // ── Step 6: update Supabase ───────────────────────────────────────────────
  await supabaseAdmin
    .from("skus")
    .update({
      shopify_product_id: parseInt(productNumericId, 10),
      shopify_variant_id: parseInt(variantGid.split("/").pop()!, 10),
      updated_at:         new Date().toISOString(),
    })
    .eq("shop_id", shopId)
    .eq("id", skuId);

  await refreshSkuAnalytics();

  console.log("[publish-sku] done", { skuId, productGid });
  return { success: true, shopifyProductId: parseInt(productNumericId, 10) };
};
