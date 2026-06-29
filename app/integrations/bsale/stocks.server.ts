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
): Promise<BsaleStockIndex & { pagesTotal: number; recordsTotal: number; bsaleCountField: number }> {
  const byVariantId = new Map<string, number>();
  const byCode      = new Map<string, { variantId: string; quantity: number }>();
  const LIMIT       = 50;
  const PARALLEL    = 5;
  const t0          = Date.now();

  const buildQs = (offset: number) => {
    const qs = new URLSearchParams({ expand: "[variant]", limit: String(LIMIT), offset: String(offset) });
    if (officeId) qs.set("officeid", String(officeId));
    return qs.toString();
  };

  let bsaleCountField = 0;

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

  // Paginate until we receive fewer items than LIMIT (= last page reached).
  // Do NOT rely on page.count — Bsale caps it at 1,000 even for larger catalogs.
  let offset    = 0;
  let pageIndex = 0;

  const MAX_RECORDS = 500_000; // safety cap — avoids infinite loop if Bsale never returns empty page
  while (offset < MAX_RECORDS) {
    const offsets = Array.from({ length: PARALLEL }, (_, i) => offset + i * LIMIT);
    const results = await Promise.all(
      offsets.map((off) =>
        get<BsalePage<BsaleStockRecord>>(`/stocks.json?${buildQs(off)}`, token)
          .then((p) => {
            if (pageIndex === 0 && off === 0) bsaleCountField = p.count ?? 0;
            return p.items ?? [];
          })
          .catch(() => [] as BsaleStockRecord[]),
      ),
    );

    let done = false;
    for (const items of results) {
      if (items.length === 0) { done = true; break; }
      addItems(items);
      offset += items.length;
      pageIndex++;
      if (items.length < LIMIT) { done = true; break; }
    }

    // Progress every 10 batches (every 500 records)
    if (pageIndex > 0 && pageIndex % (PARALLEL * 2) === 0) {
      console.log(`[stock-sync] bsale-fetch  pages=${pageIndex}  records=${offset}  variants=${byVariantId.size}  elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }

    if (done) break;
  }

  const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);
  const capped   = bsaleCountField > 0 && offset > bsaleCountField;
  console.log(
    `[stock-sync] bsale-fetch DONE  pages=${pageIndex}  records=${offset}  variants=${byVariantId.size}  with_code=${byCode.size}  bsale_count_field=${bsaleCountField}${capped ? " ⚠ COUNT_CAPPED" : ""}  elapsed=${elapsedS}s`,
  );

  return { byVariantId, byCode, pagesTotal: pageIndex, recordsTotal: offset, bsaleCountField };
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
  const token   = resolveToken(bsaleToken);
  const now     = new Date().toISOString();
  const syncT0  = Date.now();

  console.log(`[stock-sync] ▶ START  shop=${shopId}  officeId=${officeId ?? "none"}  at=${new Date().toLocaleTimeString("es-CL")}`);

  const empty: StockSyncResult = {
    total_bsale_sku_codes: 0, shopify_matched: 0, skipped: 0,
    synced: 0, shopify_updated: 0, errors: 0, error_details: [], items: [], synced_at: now,
  };

  // 1. All Shopify-published SKUs — paginated because Supabase server max_rows=1000
  //    cannot be overridden with .limit(); must use .range() to read past that cap.
  const t1         = Date.now();
  const PAGE_SIZE  = 1000;
  const shopifySkus: Array<{
    id: string; sku_code: string; title: string | null;
    bsale_variant_id: string | null; shopify_variant_id: number | null;
  }> = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from("skus")
      .select("id, sku_code, title, bsale_variant_id, shopify_variant_id")
      .eq("shop_id", shopId)
      .not("shopify_variant_id", "is", null)
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw new Error(`[syncBsaleStockToSkuBeam] lookup: ${error.message}`);
    if (!data || data.length === 0) break;
    shopifySkus.push(...(data as typeof shopifySkus));
    if (data.length < PAGE_SIZE) break;
  }

  console.log(`[stock-sync] supabase-skus  count=${shopifySkus.length}  elapsed=${Date.now() - t1}ms`);
  if (shopifySkus.length === 0) return empty;

  // 2. Bulk fetch ALL stocks for the configured office — one paginated pass
  const t2         = Date.now();
  const bsaleIndex = await fetchAllStocksForOffice(token, officeId);
  console.log(`[stock-sync] bsale-phase  elapsed=${((Date.now() - t2) / 1000).toFixed(1)}s`);

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

  console.log(`[stock-sync] match  matched=${matched.length}  skipped=${skippedCodes.length}  new_variant_ids=${toSaveVariantId.length}`);

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

  // 5. Upsert to inventory_levels in batches of 200
  const t5 = Date.now();
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

  console.log(`[stock-sync] supabase-upsert  rows=${rows.length}  synced=${synced}  errors=${errors}  elapsed=${Date.now() - t5}ms`);

  await refreshSkuAnalytics();

  // 6. Push to Shopify (beforeMap = Shopify current stock, adjust deltas)
  const beforeMap    = new Map<string, number>();
  let shopifyUpdated = 0;
  const NODES_BATCH  = 250;
  const t6           = Date.now();

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

    console.log(`[stock-sync] shopify-push  location=${locationGid}  adjusted=${changes.length}  already_ok=${matched.length - changes.length}  shopify_updated=${shopifyUpdated}  elapsed=${((Date.now() - t6) / 1000).toFixed(1)}s`);
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

  const totalS = ((Date.now() - syncT0) / 1000).toFixed(1);
  console.log(
    `[stock-sync] ✓ DONE  shop=${shopId}  officeId=${officeId ?? "none"}` +
    `  bsale_pages=${bsaleIndex.pagesTotal}  bsale_records=${bsaleIndex.recordsTotal}` +
    `  bsale_count_field=${bsaleIndex.bsaleCountField}${bsaleIndex.recordsTotal > bsaleIndex.bsaleCountField && bsaleIndex.bsaleCountField > 0 ? " ⚠COUNT_CAPPED" : ""}` +
    `  shopify_skus=${shopifySkus.length}  matched=${matched.length}  skipped=${skippedCodes.length}` +
    `  supabase_synced=${synced}  shopify_updated=${shopifyUpdated}  errors=${errors}` +
    `  total=${totalS}s`,
  );

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
