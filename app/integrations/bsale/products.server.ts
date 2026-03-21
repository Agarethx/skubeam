import { supabaseAdmin } from "../../db.server";
import { get, paginate, resolveToken } from "./client.server";
import { refreshSkuAnalytics } from "../../models/sync.server";

// ── Admin client type (mirrors authenticate.admin return) ─────────────────────
type AdminClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

// ── Bsale types ───────────────────────────────────────────────────────────────

interface BsaleInlineCostItem {
  /** Sale price with IVA */
  cost?: number;
  /** Net sale price before IVA */
  netCost?: number;
  /** Purchase / average cost (used as cost_price in Supabase) */
  averageCost?: number;
}

/** Variant with inline product + costs (expand=[product,costs]) */
interface BsaleVariantFull {
  id:          number;
  code:        string;
  barCode:     string | null;
  description: string;
  state:       number;
  /** Direct price on the variant — sometimes populated even without a price list */
  price?:      number;
  /** Direct cost on the variant — used as last-resort fallback */
  cost?:       number;
  product: {
    id:   number;
    name: string;
  } | null;
  /** Inline costs — present when expand=[costs] */
  costs?: {
    href?:  string;
    items?: BsaleInlineCostItem[];
  };
}

interface BsalePriceList {
  id:     number;
  name:   string;
  state:  number;
}

// ── Price list probe ──────────────────────────────────────────────────────────

/**
 * Fetch active Bsale price lists and log their structure.
 * Returns the ID of the first active price list, or null if none.
 */
async function probePriceLists(token: string): Promise<number | null> {
  try {
    const data = await get<{ count: number; items?: BsalePriceList[] }>(
      "/price_lists.json",
      token,
    );
    console.log("[bsale-sync] GET /price_lists.json →", JSON.stringify(data, null, 2));
    const active = (data.items ?? []).find((pl) => pl.state === 0);
    return active?.id ?? data.items?.[0]?.id ?? null;
  } catch (err) {
    console.warn("[bsale-sync] price_lists.json not available:", String(err));
    return null;
  }
}

// ── Price resolver ────────────────────────────────────────────────────────────

/**
 * Resolve sale price and average cost from a variant's inline costs + direct fields.
 *
 * Fallback chain for salePrice:
 *   1. costs.items[0].cost         (sale price with IVA — most accurate)
 *   2. costs.items[0].netCost*1.19 (net price + IVA)
 *   3. variant.price               (direct field if populated)
 *   4. variant.cost * 1.19         (cost + IVA estimate)
 *   5. null                        (no price data in sandbox/unconfigured lists)
 */
function resolvePrices(v: BsaleVariantFull): { averageCost: number | null; salePrice: number | null } {
  const item = v.costs?.items?.[0];

  const averageCost = item?.averageCost != null ? Number(item.averageCost) : null;

  let salePrice: number | null = null;
  let source = "none";

  if (item?.cost != null && Number(item.cost) > 0) {
    salePrice = Number(item.cost);
    source = "costs.cost";
  } else if (item?.netCost != null && Number(item.netCost) > 0) {
    salePrice = Math.round(Number(item.netCost) * 1.19 * 100) / 100;
    source = "costs.netCost*1.19";
  } else if (v.price != null && Number(v.price) > 0) {
    salePrice = Number(v.price);
    source = "variant.price";
  } else if (v.cost != null && Number(v.cost) > 0) {
    salePrice = Math.round(Number(v.cost) * 1.19 * 100) / 100;
    source = "variant.cost*1.19";
  }

  console.log(
    `[bsale-sync] salePrice resolved: ${salePrice} (source: ${source}) for variant: ${v.id} code: ${v.code}`,
  );

  return { averageCost, salePrice };
}

// ── Sync ──────────────────────────────────────────────────────────────────────

export async function syncBsaleToSkuBeam(
  shopId:     string,
  bsaleToken: string | null | undefined,
): Promise<{ synced: number; errors: number }> {
  const token = resolveToken(bsaleToken);

  // Probe price lists once to understand sandbox config (non-blocking)
  await probePriceLists(token);

  console.log("[bsale-sync] Fetching variants with expand=[product,costs]...");
  const variants = await paginate<BsaleVariantFull>("/variants.json", token, {
    expand: "[product,costs]",
    state:  "0",
  });
  console.log(`[bsale-sync] Got ${variants.length} variants`);

  // Log first raw variant to verify API structure (product + inline costs)
  if (variants.length > 0) {
    console.log("[bsale-sync] raw variant[0]:", JSON.stringify(variants[0], null, 2));
  }

  const valid = variants.filter((v) => v.code?.trim());
  console.log(`[bsale-sync] Valid variants with code: ${valid.length}`);
  console.log(`[bsale-sync] shopId: "${shopId}"`);

  const now    = new Date().toISOString();
  let synced   = 0;
  let errors   = 0;

  const rows = valid.map((v) => {
    const variantLabel =
      v.description && v.description !== v.product?.name
        ? ` - ${v.description}`
        : "";
    const { averageCost, salePrice } = resolvePrices(v);

    return {
      shop_id:          shopId,
      sku_code:         v.code.trim(),
      barcode:          v.barCode?.trim() || null,
      title:            v.product?.name
        ? `${v.product.name}${variantLabel}`
        : v.description || v.code,
      cost_price:       averageCost,
      sale_price:       salePrice,
      status:           "active" as const,
      updated_at:       now,
      bsale_variant_id: String(v.id),
    };
  });

  // Upsert in batches of 200
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200);
    console.log(`[bsale-sync] Upserting SKU batch ${i}–${i + batch.length - 1}...`);

    const { error } = await supabaseAdmin
      .from("skus")
      .upsert(batch, { onConflict: "shop_id,sku_code" });

    if (error) {
      console.error(`[bsale-sync] Upsert error batch ${i}:`, JSON.stringify(error));
      errors += batch.length;
    } else {
      synced += batch.length;
    }
  }

  console.log(`[bsale-sync] Done. synced=${synced} errors=${errors}`);
  await refreshSkuAnalytics();
  return { synced, errors };
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
    const res  = await admin.graphql(
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

  // Map shopify variants by sku_code (non-empty)
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
