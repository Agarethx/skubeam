import { supabaseAdmin } from "../../db.server";
import { get, resolveToken } from "./client.server";
import { refreshSkuAnalytics } from "../../models/sync.server";
import { apiVersion } from "../../shopify.server";
import type { BsalePage } from "./client.server";

// ── Bsale types ───────────────────────────────────────────────────────────────

interface BsaleStockRecord {
  quantity: number;
  variant?: { id: string; code?: string };
  office?:  { id: number; name?: string };
}

// ── Result types ──────────────────────────────────────────────────────────────

export interface StockSyncErrorDetail {
  sku_code: string;
  title:    string | null;
  error:    string;
}

export interface StockSyncItemDetail {
  sku_code:   string;
  title:      string | null;
  qty_before: number;   // Shopify stock before sync
  qty_after:  number;   // Bsale stock (pushed to Shopify)
  changed:    boolean;
}

export interface StockSyncResult {
  total_bsale_sku_codes: number;
  shopify_matched:       number;
  skipped:               number;
  synced:                number;
  shopify_updated:       number;
  errors:                number;
  error_details:         StockSyncErrorDetail[];
  items:                 StockSyncItemDetail[];
  synced_at:             string;
}

// ── Shopify GraphQL client (offline session) ──────────────────────────────────

async function getShopifyGraphQLClient(shopDomain: string) {
  const { data } = await supabaseAdmin
    .from("shopify_sessions")
    .select("access_token")
    .eq("shop", shopDomain)
    .eq("is_online", false)
    .limit(1)
    .single();

  if (!data?.access_token) {
    throw new Error(`[stock-sync] No offline session for ${shopDomain}`);
  }

  const token    = data.access_token;
  const endpoint = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;

  return {
    graphql: (query: string, opts?: { variables?: Record<string, unknown> }) =>
      fetch(endpoint, {
        method:  "POST",
        headers: {
          "Content-Type":           "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({ query, variables: opts?.variables }),
      }),
  };
}

// ── Bulk stock fetch from Bsale ───────────────────────────────────────────────
// One paginated pass for the whole office catalog instead of N per-variant calls.
// Parallel pages (5 concurrent) so 3,500 SKUs → ~70 pages → ~7s instead of ~20min.

interface BsaleStockIndex {
  byVariantId: Map<string, number>;                               // variantId → qty
  byCode:      Map<string, { variantId: string; quantity: number }>; // sku_code → data
}

async function fetchAllStocksForOffice(
  token:    string,
  officeId: number | null,
): Promise<BsaleStockIndex> {
  const byVariantId = new Map<string, number>();
  const byCode      = new Map<string, { variantId: string; quantity: number }>();
  const LIMIT       = 50;
  const PARALLEL    = 5;

  const buildQs = (offset: number) => {
    const qs = new URLSearchParams({ expand: "[variant]", limit: String(LIMIT), offset: String(offset) });
    if (officeId) qs.set("officeid", String(officeId));
    return qs.toString();
  };

  const addItems = (items: BsaleStockRecord[]) => {
    for (const item of items) {
      const variantId = item.variant?.id;
      const code      = item.variant?.code?.trim().toUpperCase();
      const qty       = Math.max(0, Math.round(item.quantity));
      if (!variantId) continue;

      const prev = byVariantId.get(variantId);
      byVariantId.set(variantId, Math.max(prev ?? 0, qty));

      if (code) {
        const prevEntry = byCode.get(code);
        if (!prevEntry || qty > prevEntry.quantity) {
          byCode.set(code, { variantId, quantity: qty });
        }
      }
    }
  };

  // Page 0: get total count + first batch of items
  const firstPage = await get<BsalePage<BsaleStockRecord>>(`/stocks.json?${buildQs(0)}`, token);
  const total     = firstPage.count ?? 0;
  const totalPages = Math.ceil(total / LIMIT);

  console.log(`[stock-sync] Bsale stocks for office ${officeId ?? "all"}: ${total} records, ${totalPages} pages`);
  addItems(firstPage.items ?? []);

  // Remaining pages in parallel batches of PARALLEL
  for (let page = 1; page < totalPages; page += PARALLEL) {
    const offsets = Array.from(
      { length: Math.min(PARALLEL, totalPages - page) },
      (_, i) => (page + i) * LIMIT,
    );
    const pages = await Promise.all(
      offsets.map((offset) =>
        get<BsalePage<BsaleStockRecord>>(`/stocks.json?${buildQs(offset)}`, token)
          .then((p) => p.items ?? [])
          .catch(() => [] as BsaleStockRecord[]),
      ),
    );
    for (const items of pages) addItems(items);

    if (page % 50 === 1) {
      console.log(`[stock-sync] fetched up to page ${page + PARALLEL - 1}/${totalPages}`);
    }
  }

  console.log(`[stock-sync] Bsale index: ${byVariantId.size} variants, ${byCode.size} with code`);
  return { byVariantId, byCode };
}

// ── Sync ──────────────────────────────────────────────────────────────────────

type MatchedEntry = {
  skuId:            string;
  skuCode:          string;
  title:            string | null;
  shopifyVariantId: number | null;
  bsaleQty:         number;
};

export async function syncBsaleStockToSkuBeam(
  shopId:     string,
  bsaleToken: string | null | undefined,
  officeId:   number | null = null,
): Promise<StockSyncResult> {
  const token = resolveToken(bsaleToken);
  const now   = new Date().toISOString();

  const empty: StockSyncResult = {
    total_bsale_sku_codes: 0, shopify_matched: 0, skipped: 0,
    synced: 0, shopify_updated: 0, errors: 0, error_details: [], items: [], synced_at: now,
  };

  // 1. All Shopify-published SKUs (limit 10000 — Supabase default cap is 1000)
  const { data: skuRows, error: skuErr } = await supabaseAdmin
    .from("skus")
    .select("id, sku_code, title, bsale_variant_id, shopify_variant_id")
    .eq("shop_id", shopId)
    .not("shopify_variant_id", "is", null)
    .limit(10000);

  if (skuErr) throw new Error(`[syncBsaleStockToSkuBeam] lookup: ${skuErr.message}`);

  const shopifySkus = skuRows ?? [];
  console.log("[stock-sync] Shopify-published SKUs:", shopifySkus.length);
  if (shopifySkus.length === 0) return empty;

  // 2. Bulk fetch ALL stocks for the configured office — one paginated pass
  const bsaleIndex = await fetchAllStocksForOffice(token, officeId);

  // 3. Match each Shopify SKU to Bsale stock (in memory, no extra API calls)
  const matched:           MatchedEntry[] = [];
  const skippedCodes:      string[]       = [];
  const toSaveVariantId:   Array<{ id: string; bsale_variant_id: string }> = [];

  for (const sku of shopifySkus) {
    let qty:               number | null  = null;
    let resolvedVariantId: string | null  = (sku.bsale_variant_id as string | null) ?? null;

    // Fast path: already have bsale_variant_id
    if (resolvedVariantId) {
      const q = bsaleIndex.byVariantId.get(resolvedVariantId);
      if (q !== undefined) qty = q;
    }

    // Fallback: match by sku_code
    if (qty === null) {
      const codeMatch = bsaleIndex.byCode.get(sku.sku_code?.trim().toUpperCase() ?? "");
      if (codeMatch) {
        qty = codeMatch.quantity;
        if (!resolvedVariantId) {
          resolvedVariantId = codeMatch.variantId;
          toSaveVariantId.push({ id: sku.id, bsale_variant_id: codeMatch.variantId });
        }
      }
    }

    if (qty === null) {
      skippedCodes.push(sku.sku_code);
    } else {
      matched.push({
        skuId:            sku.id,
        skuCode:          sku.sku_code,
        title:            sku.title,
        shopifyVariantId: sku.shopify_variant_id as number | null,
        bsaleQty:         qty,
      });
    }
  }

  // Persist newly resolved bsale_variant_ids (sequential — rare on re-syncs)
  for (const u of toSaveVariantId) {
    await supabaseAdmin.from("skus").update({ bsale_variant_id: u.bsale_variant_id }).eq("id", u.id);
  }
  if (toSaveVariantId.length > 0) {
    console.log(`[stock-sync] saved bsale_variant_id for ${toSaveVariantId.length} SKUs`);
  }

  console.log(`[stock-sync] matched: ${matched.length} | not in Bsale: ${skippedCodes.length}`);

  if (matched.length === 0) {
    return { ...empty, total_bsale_sku_codes: shopifySkus.length, skipped: skippedCodes.length };
  }

  // 4. Build afterMap + inventory_levels rows
  const afterMap = new Map<string, number>();
  const rows: Array<{
    shop_id: string; sku_id: string; shopify_location_id: number;
    location_name: string; quantity: number; updated_at: string;
  }> = [];

  for (const entry of matched) {
    afterMap.set(entry.skuId, entry.bsaleQty);
    if (officeId != null) {
      rows.push({
        shop_id:             shopId,
        sku_id:              entry.skuId,
        shopify_location_id: officeId,
        location_name:       `Bsale Oficina ${officeId}`,
        quantity:            entry.bsaleQty,
        updated_at:          now,
      });
    }
  }

  console.log(`[stock-sync] upserting ${rows.length} inventory_level rows`);

  // 5. Upsert to inventory_levels in batches of 200
  let synced = 0;
  let errors = 0;
  const errorDetails: StockSyncErrorDetail[] = [];

  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200);
    const { error } = await supabaseAdmin
      .from("inventory_levels")
      .upsert(batch, { onConflict: "sku_id,shopify_location_id" });

    if (error) {
      console.error(`[stock-sync] upsert batch ${i}:`, error.message);
      errors += batch.length;
      for (const row of batch as Array<{ sku_id: string }>) {
        const entry = matched.find((m) => m.skuId === row.sku_id);
        errorDetails.push({
          sku_code: entry?.skuCode ?? row.sku_id,
          title:    entry?.title ?? null,
          error:    error.message,
        });
      }
    } else {
      synced += batch.length;
    }
  }

  await refreshSkuAnalytics();

  // 6. Push to Shopify (beforeMap = Shopify current stock, adjust deltas)
  const beforeMap    = new Map<string, number>();
  let shopifyUpdated = 0;
  const NODES_BATCH  = 250;

  try {
    const admin = await getShopifyGraphQLClient(shopId);

    const variantGids = matched
      .filter((e) => e.shopifyVariantId != null)
      .map((e) => `gid://shopify/ProductVariant/${e.shopifyVariantId}`);

    if (variantGids.length === 0) throw new Error("No Shopify variant IDs");

    // Get location GID
    const locRes  = await admin.graphql(`#graphql
      query GetFirstLocation {
        locations(first: 1, includeLegacy: false) {
          edges { node { id } }
        }
      }`);
    const locJson = await locRes.json() as {
      data?: { locations?: { edges: Array<{ node: { id: string } }> } };
    };
    const locationGid = locJson.data?.locations?.edges[0]?.node.id;
    if (!locationGid) throw new Error("No active Shopify location");

    // Get inventoryItemId per variant (batched in 250)
    const itemMap = new Map<number, string>(); // shopifyVariantId → inventoryItemId GID
    for (let i = 0; i < variantGids.length; i += NODES_BATCH) {
      const batch = variantGids.slice(i, i + NODES_BATCH);
      const res   = await admin.graphql(
        `#graphql
        query GetVariantInventoryItems($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on ProductVariant { id inventoryItem { id } }
          }
        }`,
        { variables: { ids: batch } },
      );
      const json = await res.json() as {
        data?: { nodes?: Array<{ id: string; inventoryItem?: { id: string } } | null> };
      };
      for (const node of json.data?.nodes ?? []) {
        if (!node?.inventoryItem?.id) continue;
        const varId = parseInt(node.id.split("/").pop()!, 10);
        itemMap.set(varId, node.inventoryItem.id);
      }
    }

    console.log(`[stock-sync] resolved inventoryItemId for ${itemMap.size} variants`);

    // Query current Shopify quantities for beforeMap (batched in 250)
    const inventoryItemGids = [...new Set(itemMap.values())];
    const allQtyNodes: Array<{
      id: string;
      inventoryLevel?: { quantities: Array<{ name: string; quantity: number }> };
    } | null> = [];

    for (let i = 0; i < inventoryItemGids.length; i += NODES_BATCH) {
      const batch  = inventoryItemGids.slice(i, i + NODES_BATCH);
      const qtyRes = await admin.graphql(
        `#graphql
        query GetInventoryQuantities($ids: [ID!]!, $locId: ID!) {
          nodes(ids: $ids) {
            ... on InventoryItem {
              id
              inventoryLevel(locationId: $locId) {
                quantities(names: ["available"]) { name quantity }
              }
            }
          }
        }`,
        { variables: { ids: batch, locId: locationGid } },
      );
      const qtyJson = await qtyRes.json() as {
        data?: {
          nodes?: Array<{
            id: string;
            inventoryLevel?: { quantities: Array<{ name: string; quantity: number }> };
          } | null>;
        };
      };
      allQtyNodes.push(...(qtyJson.data?.nodes ?? []));
    }

    // Build beforeMap (Shopify pre-sync quantities)
    const itemToSku = new Map<string, string>(); // inventoryItemGid → skuId
    for (const [varId, itemGid] of itemMap.entries()) {
      const entry = matched.find((e) => e.shopifyVariantId === varId);
      if (entry) itemToSku.set(itemGid, entry.skuId);
    }
    for (const node of allQtyNodes) {
      if (!node) continue;
      const skuId = itemToSku.get(node.id);
      if (!skuId) continue;
      const qty = node.inventoryLevel?.quantities?.find((q) => q.name === "available")?.quantity ?? 0;
      beforeMap.set(skuId, qty);
    }

    console.log(`[stock-sync] Shopify beforeMap built for ${beforeMap.size} SKUs`);

    // Compute deltas and adjust (inventoryAdjustQuantities — proven pattern)
    const changes: Array<{ inventoryItemId: string; locationId: string; delta: number }> = [];
    for (const entry of matched) {
      if (entry.shopifyVariantId == null) continue;
      const itemGid    = itemMap.get(entry.shopifyVariantId);
      if (!itemGid) continue;
      const shopifyQty = beforeMap.get(entry.skuId) ?? 0;
      const bsaleQty   = afterMap.get(entry.skuId) ?? 0;
      const delta      = bsaleQty - shopifyQty;
      if (delta === 0) { shopifyUpdated++; continue; }
      changes.push({ inventoryItemId: itemGid, locationId: locationGid, delta });
    }

    console.log(`[stock-sync] Shopify: ${changes.length} adjustments needed, ${matched.length - changes.length} already correct`);

    for (let i = 0; i < changes.length; i += 100) {
      const batch     = changes.slice(i, i + 100);
      const adjustRes = await admin.graphql(
        `#graphql
        mutation AdjustInventory($input: InventoryAdjustQuantitiesInput!) {
          inventoryAdjustQuantities(input: $input) {
            userErrors { field message }
            inventoryAdjustmentGroup { createdAt }
          }
        }`,
        { variables: { input: { reason: "correction", name: "available", changes: batch } } },
      );
      const adjustJson = await adjustRes.json() as {
        data?: { inventoryAdjustQuantities?: { userErrors: Array<{ field: string; message: string }> } };
      };
      const errs = adjustJson.data?.inventoryAdjustQuantities?.userErrors ?? [];
      if (errs.length > 0) {
        console.error("[stock-sync] inventoryAdjustQuantities errors:", JSON.stringify(errs));
      } else {
        shopifyUpdated += batch.length;
      }
    }

    console.log(`[stock-sync] Shopify updated: ${shopifyUpdated} / ${matched.length}`);
  } catch (err) {
    console.error("[stock-sync] Shopify push failed (sync saved to DB):", err);
  }

  // 7. Build per-SKU comparison (Shopify before vs Bsale after)
  const items: StockSyncItemDetail[] = matched
    .map((e) => {
      const before = beforeMap.get(e.skuId) ?? 0;
      const after  = afterMap.get(e.skuId)  ?? 0;
      return { sku_code: e.skuCode, title: e.title, qty_before: before, qty_after: after, changed: before !== after };
    })
    .sort((a, b) => {
      if (a.changed !== b.changed) return a.changed ? -1 : 1;
      return a.sku_code.localeCompare(b.sku_code);
    });

  return {
    total_bsale_sku_codes: shopifySkus.length,
    shopify_matched:       matched.length,
    skipped:               skippedCodes.length,
    synced,
    shopify_updated:       shopifyUpdated,
    errors,
    error_details:         errorDetails,
    items,
    synced_at:             now,
  };
}
