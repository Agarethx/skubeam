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
  skipped_items:         Array<{ sku_code: string; title: string | null }>;
  items:                 StockSyncItemDetail[];
  shopify_push_errors:   StockSyncErrorDetail[];
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

  // A transient failure on any single page (timeout, rate limit, 5xx) must NOT
  // be treated as "reached the end of the list" — that used to silently truncate
  // the whole fetch mid-catalog, so every SKU after the failing page fell into
  // "skipped in Bsale" with zero indication anything went wrong. Retry with
  // backoff; if a page still fails after retries, throw and fail the whole sync
  // loudly instead of returning a quietly incomplete stock index.
  async function getPageWithRetry(off: number, retries = 3): Promise<BsaleStockRecord[]> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const p = await get<BsalePage<BsaleStockRecord>>(`/stocks.json?${buildQs(off)}`, token);
        if (off === 0 && bsaleCountField === 0) bsaleCountField = p.count ?? 0;
        return p.items ?? [];
      } catch (err) {
        lastErr = err;
        console.warn(`[stock-sync] bsale-fetch page offset=${off} attempt ${attempt}/${retries} failed:`, String(err));
        if (attempt < retries) await new Promise((r) => setTimeout(r, attempt * 500));
      }
    }
    throw new Error(`[stock-sync] bsale-fetch page offset=${off} failed after ${retries} attempts: ${String(lastErr)}`);
  }

  // Paginate until we receive fewer items than LIMIT (= last page reached).
  // Do NOT rely on page.count — Bsale caps it at 1,000 even for larger catalogs.
  let offset    = 0;
  let pageIndex = 0;

  const MAX_RECORDS = 500_000; // safety cap — avoids infinite loop if Bsale never returns empty page
  while (offset < MAX_RECORDS) {
    const offsets = Array.from({ length: PARALLEL }, (_, i) => offset + i * LIMIT);
    const results = await Promise.all(offsets.map((off) => getPageWithRetry(off)));

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

  const elapsedS   = ((Date.now() - t0) / 1000).toFixed(1);
  const capped     = bsaleCountField > 0 && offset > bsaleCountField;
  // Bsale's own `count` field said there should be more records than we actually
  // received before hitting a natural end-of-list (short page) — a handful off is
  // normal (catalog changing mid-fetch), but a big gap means data was dropped.
  const undercount = bsaleCountField > 0 && offset < bsaleCountField * 0.98;
  console.log(
    `[stock-sync] bsale-fetch DONE  pages=${pageIndex}  records=${offset}  variants=${byVariantId.size}  with_code=${byCode.size}  bsale_count_field=${bsaleCountField}` +
    `${capped ? " ⚠ COUNT_CAPPED" : ""}${undercount ? ` ⚠ UNDERCOUNT (expected ~${bsaleCountField}, got ${offset})` : ""}  elapsed=${elapsedS}s`,
  );

  return { byVariantId, byCode, pagesTotal: pageIndex, recordsTotal: offset, bsaleCountField };
}

// ── Reconcile Supabase skus with the live Shopify variant catalog ─────────────
// Products published (or re-published) in Shopify since the last full product
// sync have no row in `skus`, or a row whose shopify_variant_id is stale/null —
// either way they're invisible to the stock-sync query below (`.not("shopify_
// variant_id", "is", null)`), so they never even reach the Bsale matching step.
// Pull every live variant's SKU once (cheap: ~1 page per 250 variants) and
// backfill/relink before doing anything else.
async function reconcileShopifyVariants(
  shopId: string,
  admin:  { graphql: (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response> },
): Promise<{ live: number; upserted: number }> {
  const t0 = Date.now();

  // 1. Every live variant currently published in Shopify, by SKU.
  const live = new Map<string, { variantId: number; skuCode: string }>(); // normalized code → {variantId, original code}
  let cursor: string | null = null;
  let pages = 0;

  for (;;) {
    const res = await admin.graphql(
      `#graphql
      query AllVariantSkus($cursor: String) {
        productVariants(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges { node { id sku } }
        }
      }`,
      { variables: { cursor } },
    );
    const json = await res.json() as {
      data?: {
        productVariants?: {
          pageInfo: { hasNextPage: boolean; endCursor: string };
          edges: Array<{ node: { id: string; sku: string | null } }>;
        };
      };
    };
    const conn = json.data?.productVariants;
    for (const edge of conn?.edges ?? []) {
      const skuCode = edge.node.sku?.trim();
      if (!skuCode) continue;
      const variantId = parseInt(edge.node.id.split("/").pop()!, 10);
      live.set(skuCode.toUpperCase(), { variantId, skuCode });
    }
    pages++;
    if (!conn?.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }

  console.log(`[stock-sync] reconcile: ${live.size} live Shopify variant SKUs across ${pages} pages  elapsed=${Date.now() - t0}ms`);

  // 2. What Supabase already knows for this shop (paginated past the 1000-row cap).
  const PAGE_SIZE = 1000;
  const existingMap = new Map<string, number | null>(); // normalized code → shopify_variant_id on file
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from("skus")
      .select("sku_code, shopify_variant_id")
      .eq("shop_id", shopId)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`[reconcileShopifyVariants] lookup: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data) existingMap.set(row.sku_code.trim().toUpperCase(), row.shopify_variant_id);
    if (data.length < PAGE_SIZE) break;
  }

  // 3. Backfill missing rows + relink stale/null shopify_variant_id — nothing else
  //    is touched (no `status`, no `title`) so this never clobbers merchant edits.
  const toUpsert: Array<{ shop_id: string; sku_code: string; shopify_variant_id: number }> = [];
  for (const [normCode, entry] of live.entries()) {
    if (existingMap.get(normCode) === entry.variantId) continue;
    toUpsert.push({ shop_id: shopId, sku_code: entry.skuCode, shopify_variant_id: entry.variantId });
  }

  let upserted = 0;
  for (let i = 0; i < toUpsert.length; i += 200) {
    const batch = toUpsert.slice(i, i + 200);
    const { error } = await supabaseAdmin
      .from("skus")
      .upsert(batch, { onConflict: "shop_id,sku_code" });
    if (error) {
      console.error(`[stock-sync] reconcile upsert batch ${i} failed:`, error.message);
    } else {
      upserted += batch.length;
    }
  }

  console.log(`[stock-sync] reconcile: linked ${upserted}/${toUpsert.length} new/stale sku↔variant rows`);
  return { live: live.size, upserted };
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
    synced: 0, shopify_updated: 0, errors: 0, error_details: [], skipped_items: [], items: [],
    shopify_push_errors: [], synced_at: now,
  };

  // 0. Reconcile with Shopify's live variant catalog before matching against
  //    Bsale — non-fatal: if Shopify is unreachable here, fall back to whatever
  //    Supabase already has (same behavior as before this step existed).
  try {
    const admin = await getShopifyGraphQLClient(shopId);
    await reconcileShopifyVariants(shopId, admin);
  } catch (err) {
    console.error("[stock-sync] reconcile step failed (continuing with existing Supabase data):", err);
  }

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
      .order("id", { ascending: true })
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
  const matched:         MatchedEntry[] = [];
  const skippedItems:    Array<{ sku_code: string; title: string | null }> = [];
  const toSaveVariantId: Array<{ id: string; bsale_variant_id: string }> = [];

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
      skippedItems.push({ sku_code: sku.sku_code, title: sku.title });
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

  console.log(`[stock-sync] match  matched=${matched.length}  skipped=${skippedItems.length}  new_variant_ids=${toSaveVariantId.length}`);

  if (matched.length === 0) {
    return { ...empty, total_bsale_sku_codes: shopifySkus.length, skipped: skippedItems.length, skipped_items: skippedItems };
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
  const beforeMap        = new Map<string, number>();
  let shopifyUpdated     = 0;
  const shopifyPushErrors: StockSyncErrorDetail[] = [];
  const NODES_BATCH      = 250;
  const t6                = Date.now();

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

    // Self-heal: some skus.shopify_variant_id values are stale — the variant was
    // deleted and recreated in Shopify (product re-import, merge, etc.), so the
    // GID on file 404s in the nodes() lookup above and silently drops out of
    // itemMap. Without this, those SKUs are matched against Bsale correctly but
    // never reach Shopify at all — no error, no push, stock just stays frozen.
    // Re-resolve by SKU code (source of truth in Shopify) and re-link the row.
    const unresolved = matched.filter(
      (e) => e.shopifyVariantId != null && !itemMap.has(e.shopifyVariantId),
    );
    const variantMissing: StockSyncErrorDetail[] = [];

    if (unresolved.length > 0) {
      console.log(`[stock-sync] ${unresolved.length} matched SKUs have a stale shopify_variant_id — re-resolving by SKU code…`);
      const HEAL_CONCURRENCY = 10;
      for (let i = 0; i < unresolved.length; i += HEAL_CONCURRENCY) {
        const batch = unresolved.slice(i, i + HEAL_CONCURRENCY);
        await Promise.all(batch.map(async (entry) => {
          try {
            const res = await admin.graphql(
              `#graphql
              query FindVariantBySku($query: String!) {
                productVariants(first: 1, query: $query) {
                  edges { node { id sku inventoryItem { id } } }
                }
              }`,
              { variables: { query: `sku:${JSON.stringify(entry.skuCode)}` } },
            );
            const json = await res.json() as {
              data?: { productVariants?: { edges: Array<{ node: { id: string; sku: string; inventoryItem?: { id: string } } }> } };
            };
            const node = json.data?.productVariants?.edges[0]?.node;
            if (!node?.inventoryItem?.id) {
              variantMissing.push({
                sku_code: entry.skuCode,
                title:    entry.title,
                error:    "El SKU ya no existe como variante en Shopify (posible producto eliminado/recreado). Vuelve a sincronizar productos para re-vincularlo.",
              });
              return;
            }
            const newVariantId = parseInt(node.id.split("/").pop()!, 10);
            // Map the OLD (stale) id used throughout `matched`/`entry` to the
            // freshly resolved inventoryItemId so downstream logic needs no changes.
            itemMap.set(entry.shopifyVariantId!, node.inventoryItem.id);
            const { error } = await supabaseAdmin
              .from("skus")
              .update({ shopify_variant_id: newVariantId })
              .eq("id", entry.skuId);
            if (error) {
              console.error(`[stock-sync] re-link shopify_variant_id failed for ${entry.skuCode}:`, error.message);
            } else {
              console.log(`[stock-sync] re-linked ${entry.skuCode}: shopify_variant_id ${entry.shopifyVariantId} → ${newVariantId}`);
            }
          } catch (err) {
            console.error(`[stock-sync] re-resolve by SKU failed for ${entry.skuCode}:`, err);
            variantMissing.push({ sku_code: entry.skuCode, title: entry.title, error: String(err) });
          }
        }));
      }
      console.log(`[stock-sync] re-resolved ${unresolved.length - variantMissing.length}/${unresolved.length} stale variants  (still missing: ${variantMissing.length})`);
      shopifyPushErrors.push(...variantMissing);
    }

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
    interface ChangeItem { entry: MatchedEntry; inventoryItemId: string; locationId: string; delta: number }
    const changes: ChangeItem[] = [];
    for (const entry of matched) {
      if (entry.shopifyVariantId == null) continue;
      const itemGid    = itemMap.get(entry.shopifyVariantId);
      if (!itemGid) continue;
      const shopifyQty = beforeMap.get(entry.skuId) ?? 0;
      const bsaleQty   = afterMap.get(entry.skuId) ?? 0;
      const delta      = bsaleQty - shopifyQty;
      if (delta === 0) { shopifyUpdated++; continue; }
      changes.push({ entry, inventoryItemId: itemGid, locationId: locationGid, delta });
    }

    console.log(`[stock-sync] Shopify: ${changes.length} adjustments needed, ${matched.length - changes.length} already correct`);

    // inventoryAdjustQuantities validates the WHOLE batch atomically: a single bad
    // item (most commonly ITEM_NOT_STOCKED_AT_LOCATION — a variant that was never
    // activated at the location the app writes to) rejects every change in that
    // call, silently leaving up to 99 unrelated, perfectly valid SKUs un-updated.
    // pushChanges bisects on failure to isolate the bad item(s) instead of losing
    // the whole batch, and auto-activates + retries ITEM_NOT_STOCKED_AT_LOCATION.
    const ADJUST_MUTATION = `#graphql
      mutation AdjustInventory($input: InventoryAdjustQuantitiesInput!) {
        inventoryAdjustQuantities(input: $input) {
          userErrors { field message code }
          inventoryAdjustmentGroup { createdAt }
        }
      }`;

    const runAdjust = async (items: ChangeItem[]) => {
      const res = await admin.graphql(ADJUST_MUTATION, {
        variables: {
          input: {
            reason:  "correction",
            name:    "available",
            changes: items.map(({ inventoryItemId, locationId, delta }) => ({ inventoryItemId, locationId, delta })),
          },
        },
      });
      const json = await res.json() as {
        data?: { inventoryAdjustQuantities?: { userErrors: Array<{ field: string; message: string; code: string }> } };
      };
      return json.data?.inventoryAdjustQuantities?.userErrors ?? [];
    };

    const activateItem = async (inventoryItemId: string, locationId: string): Promise<boolean> => {
      const res = await admin.graphql(
        `#graphql
        mutation ActivateInventoryItem($inventoryItemId: ID!, $locationId: ID!) {
          inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
            inventoryLevel { id }
            userErrors { field message }
          }
        }`,
        { variables: { inventoryItemId, locationId } },
      );
      const json = await res.json() as {
        data?: { inventoryActivate?: { inventoryLevel?: { id: string } | null; userErrors: Array<{ message: string }> } };
      };
      return !!json.data?.inventoryActivate?.inventoryLevel;
    };

    const pushChanges = async (items: ChangeItem[]): Promise<void> => {
      if (items.length === 0) return;
      const errs = await runAdjust(items);

      if (errs.length === 0) {
        shopifyUpdated += items.length;
        return;
      }

      if (items.length === 1) {
        const item = items[0];
        const needsActivation = errs.some((e) => e.code === "ITEM_NOT_STOCKED_AT_LOCATION");
        if (needsActivation && (await activateItem(item.inventoryItemId, item.locationId))) {
          const retryErrs = await runAdjust([item]);
          if (retryErrs.length === 0) { shopifyUpdated++; return; }
          console.error(`[stock-sync] push retry after activation still failed for ${item.entry.skuCode}:`, JSON.stringify(retryErrs));
          shopifyPushErrors.push({ sku_code: item.entry.skuCode, title: item.entry.title, error: retryErrs.map((e) => e.message).join("; ") });
          return;
        }
        console.error(`[stock-sync] push failed for ${item.entry.skuCode}:`, JSON.stringify(errs));
        shopifyPushErrors.push({ sku_code: item.entry.skuCode, title: item.entry.title, error: errs.map((e) => e.message).join("; ") });
        return;
      }

      // Bisect to isolate the bad item(s) instead of dropping the whole batch.
      const mid = Math.ceil(items.length / 2);
      await pushChanges(items.slice(0, mid));
      await pushChanges(items.slice(mid));
    };

    for (let i = 0; i < changes.length; i += 100) {
      await pushChanges(changes.slice(i, i + 100));
    }

    if (shopifyPushErrors.length > 0) {
      console.error(`[stock-sync] ${shopifyPushErrors.length} SKUs failed to push to Shopify:`, shopifyPushErrors.map((e) => e.sku_code).join(", "));
    }

    console.log(`[stock-sync] shopify-push  location=${locationGid}  adjusted=${changes.length}  already_ok=${matched.length - changes.length}  shopify_updated=${shopifyUpdated}  push_errors=${shopifyPushErrors.length}  elapsed=${((Date.now() - t6) / 1000).toFixed(1)}s`);
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
    `  shopify_skus=${shopifySkus.length}  matched=${matched.length}  skipped=${skippedItems.length}` +
    `  supabase_synced=${synced}  shopify_updated=${shopifyUpdated}  errors=${errors}` +
    `  total=${totalS}s`,
  );

  return {
    total_bsale_sku_codes: shopifySkus.length,
    shopify_matched:       matched.length,
    skipped:               skippedItems.length,
    synced,
    shopify_updated:       shopifyUpdated,
    errors,
    error_details:         errorDetails,
    skipped_items:         skippedItems,
    items,
    shopify_push_errors:   shopifyPushErrors,
    synced_at:             now,
  };
}
