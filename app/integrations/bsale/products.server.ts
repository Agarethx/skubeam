import { supabaseAdmin } from "../../db.server";
import { get } from "./client.server";
import { getShop } from "../../models/shop.server";
import { refreshSkuAnalytics } from "../../models/sync.server";

// ── Admin client type ─────────────────────────────────────────────────────────
type AdminClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

// ── Bsale price-list detail (with expand=[variant]) ───────────────────────────

interface BsalePriceDetail {
  variantValueWithTaxes: number;
  variant?: {
    id:           number;
    code?:        string;
    description?: string;
    barCode?:     string | null;
    product?: {
      name?: string;
    };
  };
}

interface BsalePage<T> {
  count:  number;
  limit:  number;
  offset: number;
  items?: T[];
}

// ── Sync ──────────────────────────────────────────────────────────────────────

/**
 * Sync Bsale catalogue → Supabase SKUs using the merchant's configured price list
 * as the source of truth.
 *
 * Strategy:
 *   1. Paginate /price_lists/{id}/details.json?expand=[variant]
 *   2. Each item carries the sale price + variant metadata (code, title, id)
 *   3. Upsert into skus in batches of 200
 *   4. Refresh materialized view
 *
 * The token is resolved by jobs.server.ts before calling this function.
 */
export async function syncBsaleToSkuBeam(
  shopId: string,
  token:  string,
): Promise<{ synced: number }> {
  const shop = await getShop(shopId);
  const priceListId = shop?.bsale_price_list_id;

  if (!priceListId) {
    throw new Error(
      "No hay lista de precios configurada. Ve a Integraciones → Bsale para configurarla.",
    );
  }

  console.log(`[bsale-sync] Usando lista de precios ${priceListId}`);

  // ── 1. Paginate the price list ────────────────────────────────────────────
  const skuRows: Array<{
    shop_id:          string;
    sku_code:         string;
    title:            string;
    sale_price:       number | null;
    barcode:          string | null;
    bsale_variant_id: string;
  }> = [];

  let offset = 0;
  const limit = 50;

  while (true) {
    const data = await get<BsalePage<BsalePriceDetail>>(
      `/price_lists/${priceListId}/details.json?expand=[variant,product]&limit=${limit}&offset=${offset}`,
      token,
    );

    const items = data?.items ?? [];
    if (items.length === 0) break;

    // Log full structure of first item on first page for diagnostics
    if (offset === 0 && skuRows.length < 2 && items[0]) {
      console.log("[bsale-debug] first item with product expand:", JSON.stringify(items[0], null, 2));
    }

    for (const item of items) {
      const v = item.variant;
      if (!v?.id || !v.code?.trim()) continue; // skip items without a SKU code

      // product.name is the primary title — cleaner than description which is often a variant label
      const title =
        v.product?.name?.trim() ||
        v.description?.trim()   ||
        v.code.trim();

      skuRows.push({
        shop_id:          shopId,
        sku_code:         v.code.trim(),
        title,
        sale_price:       item.variantValueWithTaxes > 0 ? item.variantValueWithTaxes : null,
        barcode:          v.barCode ?? null,
        bsale_variant_id: String(v.id),
      });
    }

    console.log(
      `[bsale-sync] Lista de precios: ${skuRows.length} SKUs cargados (offset ${offset})`,
    );

    if (items.length < limit) break;
    offset += limit;
  }

  console.log(`[bsale-sync] Total SKUs desde lista de precios: ${skuRows.length}`);

  if (skuRows.length === 0) {
    console.warn("[bsale-sync] La lista de precios no devolvió variantes con código. Verifica la configuración.");
    return { synced: 0 };
  }

  // ── 2. Upsert in batches of 200 ───────────────────────────────────────────
  for (let i = 0; i < skuRows.length; i += 200) {
    const batch = skuRows.slice(i, i + 200);

    const { error } = await supabaseAdmin
      .from("skus")
      .upsert(batch, { onConflict: "shop_id,sku_code" });

    if (error) {
      console.error(`[bsale-sync] Upsert error batch ${i}:`, error.message);
    } else {
      console.log(`[bsale-sync] Upserted batch ${i}–${i + batch.length - 1}`);
    }
  }

  // ── 3. Refresh analytics ──────────────────────────────────────────────────
  await refreshSkuAnalytics();

  console.log(`[bsale-sync] Done. synced=${skuRows.length}`);
  return { synced: skuRows.length };
}

// ── Diff: Bsale (Supabase) ↔ Shopify ─────────────────────────────────────────

export type DiffCategory = "new" | "changed" | "synced";

export interface DiffItem {
  supabase_id:         string;
  sku_code:            string;
  title_bsale:         string | null;
  cost_price:          number | null;
  title_shopify:       string | null;
  price_shopify:       string | null;
  shopify_variant_gid: string | null;
  shopify_product_gid: string | null;
  category:            DiffCategory;
}

interface ShopifyVariantNode {
  id:    string;
  sku:   string;
  price: string;
  product: { id: string; title: string };
}

async function fetchAllShopifyVariants(admin: AdminClient): Promise<ShopifyVariantNode[]> {
  const all: ShopifyVariantNode[] = [];
  let cursor: string | null = null;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await admin.graphql(
      `#graphql
      query AllVariants($cursor: String) {
        productVariants(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges { node { id sku price product { id title } } }
        }
      }`,
      { variables: { cursor } },
    );
    const json = await res.json() as {
      data?: {
        productVariants?: {
          pageInfo: { hasNextPage: boolean; endCursor: string };
          edges: Array<{ node: ShopifyVariantNode }>;
        };
      };
    };
    const conn  = json.data?.productVariants;
    const edges = conn?.edges ?? [];
    all.push(...edges.map((e) => e.node));
    if (!conn?.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }

  return all;
}

export async function getBsaleShopifyDiff(
  shopId: string,
  admin:  AdminClient,
): Promise<{ items: DiffItem[]; counts: Record<DiffCategory, number> }> {
  const [{ data: supabaseSkus }, shopifyVariants] = await Promise.all([
    supabaseAdmin
      .from("skus")
      .select("id, sku_code, title, cost_price")
      .eq("shop_id", shopId)
      .eq("status", "active"),
    fetchAllShopifyVariants(admin),
  ]);

  const shopifyMap = new Map<string, ShopifyVariantNode>();
  for (const v of shopifyVariants) {
    if (v.sku?.trim()) shopifyMap.set(v.sku.trim(), v);
  }

  const counts: Record<DiffCategory, number> = { new: 0, changed: 0, synced: 0 };

  const items: DiffItem[] = (supabaseSkus ?? []).map((row) => {
    const shopifyVariant = shopifyMap.get(row.sku_code);

    let category: DiffCategory;
    if (!shopifyVariant) {
      category = "new";
    } else if (
      (row.title ?? "").trim().toLowerCase() !==
      (shopifyVariant.product.title ?? "").trim().toLowerCase()
    ) {
      category = "changed";
    } else {
      category = "synced";
    }

    counts[category]++;

    return {
      supabase_id:         row.id,
      sku_code:            row.sku_code,
      title_bsale:         row.title,
      cost_price:          row.cost_price,
      title_shopify:       shopifyVariant?.product.title ?? null,
      price_shopify:       shopifyVariant?.price ?? null,
      shopify_variant_gid: shopifyVariant?.id ?? null,
      shopify_product_gid: shopifyVariant?.product.id ?? null,
      category,
    };
  });

  return { items, counts };
}
