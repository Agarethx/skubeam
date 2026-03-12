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

interface BsaleCostItem {
  averageCost: number;
}

interface BsaleCostsResponse {
  count: number;
  items: BsaleCostItem[];
}

/** Slim variant — no expand, fast to paginate */
interface BsaleVariantSlim {
  id:          number;
  code:        string;
  barCode:     string | null;
  description: string;
  state:       number;
  product: {
    id:   number;
    name: string;
  } | null;
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

export async function getBsaleVariants(
  bsaleToken: string | null | undefined,
): Promise<BsaleVariantSlim[]> {
  const token = resolveToken(bsaleToken);
  return paginate<BsaleVariantSlim>("/variants.json", token, {
    expand: "[product]",   // product only — no costs (too slow at scale)
    state:  "0",           // active only
  });
}

/**
 * Fetch average costs for a batch of variant IDs.
 * Returns a map of variantId → averageCost (or null if unavailable).
 */
async function fetchCostsBatch(
  ids:   number[],
  token: string,
): Promise<Map<number, number | null>> {
  const results = new Map<number, number | null>();

  await Promise.all(
    ids.map(async (id) => {
      try {
        const data = await get<BsaleCostsResponse>(`/variants/${id}/costs.json`, token);
        const avg = data.items?.[0]?.averageCost ?? null;
        results.set(id, avg != null ? Number(avg) : null);
      } catch {
        results.set(id, null);
      }
    }),
  );

  return results;
}

// ── Sync ──────────────────────────────────────────────────────────────────────

export async function syncBsaleToSkuBeam(
  shopId:     string,
  bsaleToken: string | null | undefined,
): Promise<{ synced: number; errors: number }> {
  const token = resolveToken(bsaleToken);

  console.log("[bsale-sync] Fetching variants (no expand costs)...");
  const variants = await paginate<BsaleVariantSlim>("/variants.json", token, {
    expand: "[product]",
    state:  "0",
  });
  console.log(`[bsale-sync] Got ${variants.length} variants`);

  const valid = variants.filter((v) => v.code?.trim());
  console.log(`[bsale-sync] Valid variants with code: ${valid.length}`);
  console.log(`[bsale-sync] shopId: "${shopId}"`);

  // Fetch costs in batches of 10 to avoid hammering the API
  const COST_BATCH = 10;
  const costMap = new Map<number, number | null>();

  for (let i = 0; i < valid.length; i += COST_BATCH) {
    const batch = valid.slice(i, i + COST_BATCH);
    const batchNum  = Math.floor(i / COST_BATCH) + 1;
    const totalBatches = Math.ceil(valid.length / COST_BATCH);
    console.log(`[bsale-sync] Fetching costs batch ${batchNum}/${totalBatches}`);

    const batchMap = await fetchCostsBatch(batch.map((v) => v.id), token);
    batchMap.forEach((cost, id) => costMap.set(id, cost));
  }

  const now    = new Date().toISOString();
  let synced   = 0;
  let errors   = 0;

  const rows = valid.map((v) => {
    const variantLabel =
      v.description && v.description !== v.product?.name
        ? ` - ${v.description}`
        : "";
    const avgCost = costMap.get(v.id) ?? null;

    return {
      shop_id:    shopId,
      sku_code:   v.code.trim(),
      barcode:    v.barCode?.trim() || null,
      title:      v.product?.name
        ? `${v.product.name}${variantLabel}`
        : v.description || v.code,
      cost_price: avgCost,
      status:     "active" as const,
      updated_at: now,
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
