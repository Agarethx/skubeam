import { supabaseAdmin } from "../../db.server";
import { get, resolveToken } from "./client.server";
import { refreshSkuAnalytics } from "../../models/sync.server";
import { apiVersion } from "../../shopify.server";
import type { BsalePage } from "./client.server";

// ── Bsale types ───────────────────────────────────────────────────────────────

interface BsaleStock {
  id:        number;
  quantity:  number;
  officeId:  number | null;
  variantId: number;
  office?:   { id: number; name?: string };
}

interface BsaleVariant {
  id:   number;
  code: string;
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
// Mirrors getShopifyGraphQLClient in realtime.server.ts — needed outside request context

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

// ── Per-variant stock fetch ───────────────────────────────────────────────────

async function fetchStockForVariant(
  variantId:  string,
  token:      string,
  officeId:   number | null,
  debugOnce:  { logged: boolean },
): Promise<BsaleStock[]> {
  try {
    // Bsale API uses lowercase: variantid / officeid (not camelCase)
    const qs = new URLSearchParams({ variantid: variantId, expand: "[office]", limit: "50" });
    if (officeId) qs.set("officeid", String(officeId));

    const page = await get<BsalePage<BsaleStock>>(`/stocks.json?${qs}`, token);
    const items = page.items ?? [];

    if (!debugOnce.logged && items.length > 0) {
      debugOnce.logged = true;
      console.log(`[stock-sync] Bsale returned ${items.length} stock record(s) for variantId=${variantId} — raw[0]:`, JSON.stringify(items[0], null, 2));
    }

    return items;
  } catch {
    return [];
  }
}

async function resolveBsaleVariantId(skuCode: string, token: string): Promise<string | null> {
  try {
    const page = await get<BsalePage<BsaleVariant>>(
      `/variants.json?code=${encodeURIComponent(skuCode)}&limit=1`,
      token,
    );
    const first = page.items?.[0];
    return first ? String(first.id) : null;
  } catch {
    return null;
  }
}

async function runConcurrent<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = await Promise.all(tasks.slice(i, i + concurrency).map((fn) => fn()));
    results.push(...batch);
  }
  return results;
}

// ── Sync ──────────────────────────────────────────────────────────────────────

type SyncEntry = {
  skuId:           string;
  skuCode:         string;
  title:           string | null;
  variantId:       string;       // Bsale variant ID
  shopifyVariantId: number | null; // Shopify variant ID
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

  // 1. All Shopify-published SKUs (include shopify_variant_id for Shopify push)
  const { data: skuRows, error: skuErr } = await supabaseAdmin
    .from("skus")
    .select("id, sku_code, title, bsale_variant_id, shopify_variant_id")
    .eq("shop_id", shopId)
    .not("shopify_variant_id", "is", null);

  if (skuErr) throw new Error(`[syncBsaleStockToSkuBeam] lookup: ${skuErr.message}`);

  const shopifySkus = skuRows ?? [];
  console.log("[stock-sync] Shopify-published SKUs:", shopifySkus.length);
  if (shopifySkus.length === 0) return empty;

  // 2. Resolve bsale_variant_id for SKUs that don't have it yet
  const withId    = shopifySkus.filter((s) => s.bsale_variant_id);
  const withoutId = shopifySkus.filter((s) => !s.bsale_variant_id);

  console.log("[stock-sync] with bsale_variant_id:", withId.length, "| need lookup:", withoutId.length);

  const resolved: SyncEntry[] = [];

  if (withoutId.length > 0) {
    const lookupResults = await runConcurrent(
      withoutId.map((s) => async () => ({
        skuId: s.id, skuCode: s.sku_code, title: s.title,
        shopifyVariantId: s.shopify_variant_id as number | null,
        variantId: await resolveBsaleVariantId(s.sku_code, token),
      })),
      5,
    );

    const toUpdate: Array<{ id: string; bsale_variant_id: string }> = [];
    for (const r of lookupResults) {
      if (r.variantId) {
        resolved.push({
          skuId: r.skuId, skuCode: r.skuCode, title: r.title,
          variantId: r.variantId, shopifyVariantId: r.shopifyVariantId,
        });
        toUpdate.push({ id: r.skuId, bsale_variant_id: r.variantId });
      }
    }
    for (const u of toUpdate) {
      await supabaseAdmin.from("skus").update({ bsale_variant_id: u.bsale_variant_id }).eq("id", u.id);
    }
    if (toUpdate.length > 0) console.log("[stock-sync] saved bsale_variant_id for", toUpdate.length, "SKUs");
  }

  const allEntries: SyncEntry[] = [
    ...withId.map((s) => ({
      skuId: s.id, skuCode: s.sku_code, title: s.title,
      variantId: s.bsale_variant_id as string,
      shopifyVariantId: s.shopify_variant_id as number | null,
    })),
    ...resolved,
  ];

  const notFound = shopifySkus.length - allEntries.length;
  console.log("[stock-sync] fetching stock for", allEntries.length, "variants |", notFound, "not found in Bsale");

  // 3. Fetch stock from Bsale in parallel batches of 5
  if (officeId) {
    console.log("[stock-sync] filtering by officeId:", officeId);
  } else {
    console.warn("[stock-sync] no officeId configured — fetching all offices");
  }

  const debugOnce = { logged: false };
  const fetched = await runConcurrent(
    allEntries.map((e) => async () => {
      const stocks = await fetchStockForVariant(e.variantId, token, officeId, debugOnce);
      return { ...e, stocks };
    }),
    5,
  );

  // 4. Build deduplicated inventory_levels rows (max qty per sku+office)
  const rowMap = new Map<string, {
    shop_id: string; sku_id: string; shopify_location_id: number;
    location_name: string; quantity: number; updated_at: string;
  }>();

  for (const { skuId, stocks } of fetched) {
    for (const s of stocks) {
      const locationId = s.officeId ?? s.office?.id;
      if (!locationId) continue;
      const key = `${skuId}:${locationId}`;
      const qty = Math.max(0, Math.round(s.quantity));
      const existing = rowMap.get(key);
      if (existing) {
        existing.quantity = Math.max(existing.quantity, qty);
      } else {
        rowMap.set(key, {
          shop_id:             shopId,
          sku_id:              skuId,
          shopify_location_id: locationId,
          location_name:       s.office?.name ?? `Oficina ${locationId}`,
          quantity:            qty,
          updated_at:          now,
        });
      }
    }
  }

  // afterMap: stock at the configured office only.
  // Bsale may return records for ALL offices even when officeId is passed as a query param.
  // Filter client-side so we never sum across all offices.
  const afterMap = new Map<string, number>();
  for (const row of rowMap.values()) {
    if (officeId && row.shopify_location_id !== officeId) continue;
    afterMap.set(row.sku_id, (afterMap.get(row.sku_id) ?? 0) + row.quantity);
  }

  // Only upsert the configured office row (drop other offices from rowMap)
  const rows = officeId
    ? [...rowMap.values()].filter((r) => r.shopify_location_id === officeId)
    : [...rowMap.values()];
  console.log("[stock-sync] inventory_level rows to upsert:", rows.length);

  // 5. Upsert inventory_levels in Supabase
  let synced = 0;
  let errors = 0;
  const errorDetails: StockSyncErrorDetail[] = [];

  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200);
    const { error } = await supabaseAdmin
      .from("inventory_levels")
      .upsert(batch, { onConflict: "sku_id,shopify_location_id" });

    if (error) {
      console.error(`[syncBsaleStockToSkuBeam] batch ${i}:`, error.message);
      errors += batch.length;
      for (const row of batch as Array<{ sku_id: string }>) {
        const entry = fetched.find((f) => f.skuId === row.sku_id);
        errorDetails.push({ sku_code: entry?.skuCode ?? row.sku_id, title: entry?.title ?? null, error: error.message });
      }
    } else {
      synced += batch.length;
    }
  }

  await refreshSkuAnalytics();

  // 6. Push quantities to Shopify and capture before/after from Shopify itself
  //    beforeMap = Shopify's stock before this push (meaningful comparison)
  //    On error: fall back silently (beforeMap stays empty = all show 0 before)
  const beforeMap = new Map<string, number>();
  let shopifyUpdated = 0;

  try {
    const admin = await getShopifyGraphQLClient(shopId);

    const variantGids = allEntries
      .filter((e) => e.shopifyVariantId != null)
      .map((e) => `gid://shopify/ProductVariant/${e.shopifyVariantId}`);

    if (variantGids.length === 0) throw new Error("No Shopify variant IDs available");

    // Fetch inventory items + first active location in parallel
    const [inventoryRes, locRes] = await Promise.all([
      admin.graphql(
        `#graphql
        query GetVariantInventoryItems($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on ProductVariant { id inventoryItem { id } }
          }
        }`,
        { variables: { ids: variantGids } },
      ),
      admin.graphql(`#graphql
        query GetFirstLocation {
          locations(first: 1, includeLegacy: false) {
            edges { node { id } }
          }
        }`),
    ]);

    const inventoryJson = await inventoryRes.json() as {
      data?: { nodes?: Array<{ id: string; inventoryItem?: { id: string } } | null> };
    };
    const locJson = await locRes.json() as {
      data?: { locations?: { edges: Array<{ node: { id: string } }> } };
    };

    const locationGid = locJson.data?.locations?.edges[0]?.node.id;
    if (!locationGid) throw new Error("[stock-sync] No active Shopify location found");

    // shopifyVariantId → inventoryItemId GID
    const itemMap = new Map<number, string>();
    for (const node of inventoryJson.data?.nodes ?? []) {
      if (!node?.inventoryItem?.id) continue;
      const varId = parseInt(node.id.split("/").pop()!, 10);
      itemMap.set(varId, node.inventoryItem.id);
    }

    // Query current Shopify quantities for beforeMap
    const inventoryItemGids = [...new Set(itemMap.values())];
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
      { variables: { ids: inventoryItemGids, locId: locationGid } },
    );

    const qtyJson = await qtyRes.json() as {
      data?: {
        nodes?: Array<{
          id: string;
          inventoryLevel?: { quantities: Array<{ name: string; quantity: number }> };
        } | null>;
      };
    };

    // inventoryItemGid → skuId
    const itemToSku = new Map<string, string>();
    for (const [varId, itemGid] of itemMap.entries()) {
      const entry = allEntries.find((e) => e.shopifyVariantId === varId);
      if (entry) itemToSku.set(itemGid, entry.skuId);
    }

    for (const node of qtyJson.data?.nodes ?? []) {
      if (!node) continue;
      const skuId = itemToSku.get(node.id);
      if (!skuId) continue;
      const available = node.inventoryLevel?.quantities?.find((q) => q.name === "available")?.quantity ?? 0;
      beforeMap.set(skuId, available);
    }

    console.log(`[stock-sync] Shopify beforeMap built for ${beforeMap.size} SKUs`);

    // Build delta changes (Bsale qty − Shopify current qty)
    // Using inventoryAdjustQuantities (same pattern as realtime.server.ts — proven to work)
    const changes: Array<{ inventoryItemId: string; locationId: string; delta: number }> = [];
    for (const entry of allEntries) {
      if (entry.shopifyVariantId == null) continue;
      const itemGid   = itemMap.get(entry.shopifyVariantId);
      if (!itemGid) continue;
      const shopifyQty = beforeMap.get(entry.skuId) ?? 0;
      const bsaleQty   = afterMap.get(entry.skuId) ?? 0;
      const delta      = bsaleQty - shopifyQty;
      if (delta === 0) {
        shopifyUpdated++; // Already correct — count as success
        continue;
      }
      changes.push({ inventoryItemId: itemGid, locationId: locationGid, delta });
    }

    // Apply deltas in batches of 100
    for (let i = 0; i < changes.length; i += 100) {
      const batch = changes.slice(i, i + 100);
      const adjustRes = await admin.graphql(
        `#graphql
        mutation AdjustInventory($input: InventoryAdjustQuantitiesInput!) {
          inventoryAdjustQuantities(input: $input) {
            userErrors { field message }
            inventoryAdjustmentGroup { createdAt }
          }
        }`,
        {
          variables: {
            input: {
              reason:  "correction",
              name:    "available",
              changes: batch,
            },
          },
        },
      );

      const adjustJson = await adjustRes.json() as {
        data?: {
          inventoryAdjustQuantities?: {
            userErrors:               Array<{ field: string; message: string }>;
            inventoryAdjustmentGroup: { createdAt: string } | null;
          };
        };
      };

      const errs = adjustJson.data?.inventoryAdjustQuantities?.userErrors ?? [];
      if (errs.length > 0) {
        console.error("[stock-sync] inventoryAdjustQuantities errors:", JSON.stringify(errs));
      } else {
        shopifyUpdated += batch.length;
      }
    }

    console.log(`[stock-sync] Shopify: ${shopifyUpdated} synced (${changes.length} adjusted, ${allEntries.length - changes.length} already correct)`);
  } catch (err) {
    console.error("[stock-sync] Shopify push failed (sync still saved to DB):", err);
  }

  // 7. Build per-SKU before/after detail
  //    qty_before = Shopify stock before push (or 0 if Shopify fetch failed)
  //    qty_after  = Bsale stock (what was pushed to Shopify)
  const items: StockSyncItemDetail[] = allEntries
    .map((e) => {
      const before = beforeMap.get(e.skuId) ?? 0;
      const after  = afterMap.get(e.skuId) ?? 0;
      return {
        sku_code:   e.skuCode,
        title:      e.title,
        qty_before: before,
        qty_after:  after,
        changed:    before !== after,
      };
    })
    .sort((a, b) => {
      if (a.changed !== b.changed) return a.changed ? -1 : 1;
      return a.sku_code.localeCompare(b.sku_code);
    });

  return {
    total_bsale_sku_codes: shopifySkus.length,
    shopify_matched:       allEntries.length,
    skipped:               notFound,
    synced,
    shopify_updated:       shopifyUpdated,
    errors,
    error_details:         errorDetails,
    items,
    synced_at:             now,
  };
}
