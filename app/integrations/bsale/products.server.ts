import { supabaseAdmin } from "../../db.server";
import { get, type BsalePage } from "./client.server";
import { refreshSkuAnalytics } from "../../models/sync.server";
import { apiVersion } from "../../shopify.server";

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
    throw new Error(`[bsale-prices] No offline session for ${shopDomain}`);
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

// ── Bsale price-list detail (with expand=[variant]) ───────────────────────────

interface BsalePriceDetail {
  variantValueWithTaxes: number;
  variant?: {
    id:           number;
    code?:        string;
    description?: string;
    barCode?:     string | null;
    product?: { name?: string };
  };
}

// ── Result types ──────────────────────────────────────────────────────────────

export interface PriceSyncItemDetail {
  sku_code:     string;
  title:        string | null;
  price_before: number | null;
  price_after:  number;
  changed:      boolean;
}

export interface PriceSyncErrorDetail {
  sku_code: string;
  title:    string | null;
  error:    string;
}

/** A variant on sale in Shopify (price < compareAtPrice) — never overwritten. */
export interface PriceSyncDiscountSkip {
  sku_code:         string;
  title:            string | null;
  price_shopify:    number;  // precio de oferta vigente
  compare_at_price: number;  // precio tachado
  price_bsale:      number;  // lo que el sync habría escrito
}

export interface PriceSyncResult {
  /** "preview" = nada se escribió, solo se calculó el diff. "apply" = se pusheó a Shopify. */
  mode:                "preview" | "apply";
  total_bsale_codes:   number;
  shopify_matched:     number;
  skipped:             number;
  synced:              number;
  shopify_updated:     number;
  errors:              number;
  error_details:       PriceSyncErrorDetail[];
  skipped_items:       Array<{ sku_code: string; title: string | null }>;
  items:               PriceSyncItemDetail[];
  discounted_skipped:  PriceSyncDiscountSkip[];
  shopify_push_errors: PriceSyncErrorDetail[];
  synced_at:           string;
}

/**
 * Push Bsale price-list prices to Shopify for SKUs already published there.
 *
 * Mirrors syncBsaleStockToSkuBeam's shape (match against the configured price list,
 * save locally, push to Shopify) but for price instead of quantity. Never touches
 * SKUs that aren't in Shopify yet — those go through the on-demand search + publish
 * flow instead of a bulk import.
 *
 * CONTRATO: esta función solo escribe PRECIO. Nunca toca inventario en Shopify ni
 * `inventory_levels` en Supabase — de eso se encarga exclusivamente
 * syncBsaleStockToSkuBeam. Los dos jobs son disjuntos a propósito.
 *
 * Descuentos: una variante en oferta en Shopify (`compareAtPrice` > `price`) NO se
 * toca. Escribir el precio de lista de Bsale encima la sacaría de oferta y dejaría
 * un tachado incoherente, así que se reporta en `discounted_skipped` y el merchant
 * decide. Los descuentos automáticos y códigos de descuento de Shopify no usan
 * `variant.price`, así que esos SKUs se sincronizan normalmente.
 *
 * `opts.preview` calcula el diff completo sin escribir nada (ni Supabase ni Shopify).
 */
export async function syncBsalePricesToShopify(
  shopId:      string,
  token:       string,
  priceListId: number,
  opts:        { preview?: boolean; onProgress?: (records: number) => void } = {},
): Promise<PriceSyncResult> {
  const preview  = opts.preview === true;
  const progress = opts.onProgress ?? (() => {});
  const mode: "preview" | "apply" = preview ? "preview" : "apply";
  const now = new Date().toISOString();
  const empty: PriceSyncResult = {
    mode, total_bsale_codes: 0, shopify_matched: 0, skipped: 0, synced: 0,
    shopify_updated: 0, errors: 0, error_details: [], skipped_items: [],
    items: [], discounted_skipped: [], shopify_push_errors: [], synced_at: now,
  };

  // 1. Published, non-archived SKUs — paginated past Supabase's 1000-row cap.
  const PAGE_SIZE = 1000;
  const shopifySkus: Array<{
    id: string; sku_code: string; title: string | null;
    bsale_variant_id: string | null; shopify_variant_id: number; shopify_product_id: number;
  }> = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from("skus")
      .select("id, sku_code, title, bsale_variant_id, shopify_variant_id, shopify_product_id")
      .eq("shop_id", shopId)
      .not("shopify_variant_id", "is", null)
      .neq("status", "archived")
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw new Error(`[syncBsalePricesToShopify] lookup: ${error.message}`);
    if (!data || data.length === 0) break;
    shopifySkus.push(...(data as typeof shopifySkus));
    if (data.length < PAGE_SIZE) break;
  }
  if (shopifySkus.length === 0) return empty;

  // 2. Bsale price list — paginado en lotes de 5 páginas concurrentes (mismo patrón
  //    que el sync de stock). Secuencial, un catálogo de miles de variantes tardaba
  //    minutos, y ahora esta lectura está en el camino crítico de cada vista previa.
  const byVariantId = new Map<number, number>(); // variantId → price
  const byCode      = new Map<string, { price: number; variantId: number }>();
  const LIMIT       = 50;
  const PARALLEL    = 5;
  const t2          = Date.now();

  const getPricePage = async (off: number): Promise<BsalePriceDetail[]> => {
    const data = await get<BsalePage<BsalePriceDetail>>(
      `/price_lists/${priceListId}/details.json?expand=[variant]&limit=${LIMIT}&offset=${off}`,
      token,
    );
    return data?.items ?? [];
  };

  let offset = 0;
  const MAX_RECORDS = 500_000; // tope de seguridad ante una API que nunca devuelve página vacía
  outer: while (offset < MAX_RECORDS) {
    const offsets = Array.from({ length: PARALLEL }, (_, i) => offset + i * LIMIT);
    const pages   = await Promise.all(offsets.map(getPricePage));

    for (const items of pages) {
      if (items.length === 0) break outer;
      for (const item of items) {
        const v = item.variant;
        if (!v?.id || item.variantValueWithTaxes <= 0) continue;
        byVariantId.set(v.id, item.variantValueWithTaxes);
        if (v.code?.trim()) byCode.set(v.code.trim().toUpperCase(), { price: item.variantValueWithTaxes, variantId: v.id });
      }
      offset += items.length;
      if (items.length < LIMIT) break outer;
    }

    // Señal de vida: esta es la fase larga (una lista de precios grande son cientos
    // de páginas). Sin esto la UI solo muestra un spinner mudo y no hay forma de
    // distinguir "va lento" de "el job murió".
    progress(offset);
  }

  console.log(`[bsale-prices] lista ${priceListId}: ${byVariantId.size} variantes con precio (${offset} registros leídos)  elapsed=${((Date.now() - t2) / 1000).toFixed(1)}s`);
  progress(offset);

  // 3. Match — prefer the stored bsale_variant_id, fall back to matching by SKU code.
  const matched: Array<{
    skuId: string; skuCode: string; title: string | null;
    shopifyVariantId: number; shopifyProductId: number; bsalePrice: number;
  }> = [];
  const skippedItems: Array<{ sku_code: string; title: string | null }> = [];
  const toSaveVariantId: Array<{ id: string; bsale_variant_id: string }> = [];

  for (const sku of shopifySkus) {
    let price: number | null = null;
    let resolvedVariantId = sku.bsale_variant_id ? Number(sku.bsale_variant_id) : null;

    if (resolvedVariantId != null) {
      const hit = byVariantId.get(resolvedVariantId);
      if (hit !== undefined) price = hit;
    }
    if (price === null) {
      const codeHit = byCode.get(sku.sku_code?.trim().toUpperCase() ?? "");
      if (codeHit) {
        price = codeHit.price;
        if (!resolvedVariantId) {
          resolvedVariantId = codeHit.variantId;
          toSaveVariantId.push({ id: sku.id, bsale_variant_id: String(codeHit.variantId) });
        }
      }
    }

    if (price === null) {
      skippedItems.push({ sku_code: sku.sku_code, title: sku.title });
    } else {
      matched.push({
        skuId: sku.id, skuCode: sku.sku_code, title: sku.title,
        shopifyVariantId: sku.shopify_variant_id, shopifyProductId: sku.shopify_product_id,
        bsalePrice: price,
      });
    }
  }

  // Re-linking bsale_variant_id is a mapping repair, not a price change — it runs in
  // preview too so the "Aplicar" pass doesn't have to rediscover the same matches.
  for (const u of toSaveVariantId) {
    await supabaseAdmin.from("skus").update({ bsale_variant_id: u.bsale_variant_id }).eq("id", u.id);
  }

  if (matched.length === 0) {
    return { ...empty, total_bsale_codes: shopifySkus.length, skipped: skippedItems.length, skipped_items: skippedItems };
  }

  // 4. Fetch current Shopify price + compareAtPrice. This runs BEFORE any write:
  //    a variant on sale must be classified before we decide to touch it at all.
  const admin = await getShopifyGraphQLClient(shopId);
  const beforeMap = new Map<number, { price: number; compareAt: number | null }>();
  const NODES_BATCH = 250;

  const variantGids = matched.map((m) => `gid://shopify/ProductVariant/${m.shopifyVariantId}`);
  for (let i = 0; i < variantGids.length; i += NODES_BATCH) {
    const batch = variantGids.slice(i, i + NODES_BATCH);
    const res = await admin.graphql(
      `#graphql
      query GetVariantPrices($ids: [ID!]!) {
        nodes(ids: $ids) { ... on ProductVariant { id price compareAtPrice } }
      }`,
      { variables: { ids: batch } },
    );
    const json = await res.json() as {
      data?: { nodes?: Array<{ id: string; price: string; compareAtPrice: string | null } | null> };
    };
    for (const node of json.data?.nodes ?? []) {
      if (!node) continue;
      const varId = parseInt(node.id.split("/").pop()!, 10);
      beforeMap.set(varId, {
        price:     parseFloat(node.price),
        compareAt: node.compareAtPrice != null ? parseFloat(node.compareAtPrice) : null,
      });
    }
  }

  // 5. Split off variants currently on sale — those are never overwritten.
  //    A stale compareAtPrice at or below the price is not a discount, so those
  //    keep syncing normally.
  const EPS = 0.005;
  const eligible: typeof matched = [];
  const discountedSkipped: PriceSyncDiscountSkip[] = [];

  for (const m of matched) {
    const before = beforeMap.get(m.shopifyVariantId);
    if (before && before.compareAt != null && before.compareAt > before.price + EPS) {
      discountedSkipped.push({
        sku_code:         m.skuCode,
        title:            m.title,
        price_shopify:    before.price,
        compare_at_price: before.compareAt,
        price_bsale:      m.bsalePrice,
      });
      continue;
    }
    eligible.push(m);
  }

  discountedSkipped.sort((a, b) => a.sku_code.localeCompare(b.sku_code));

  // 6. Save sale_price in Supabase — only for SKUs whose price we're actually
  //    syncing, so `skus.sale_price` keeps reflecting what's live in Shopify.
  let synced = 0;
  let errors = 0;
  const errorDetails: PriceSyncErrorDetail[] = [];

  if (!preview) {
    for (const m of eligible) {
      const { error } = await supabaseAdmin.from("skus").update({ sale_price: m.bsalePrice }).eq("id", m.skuId);
      if (error) { errors++; errorDetails.push({ sku_code: m.skuCode, title: m.title, error: error.message }); }
      else synced++;
    }
    await refreshSkuAnalytics();
  }

  // 7. Push updated prices — grouped by product, since productVariantsBulkUpdate takes
  //    one productId per call. Skip variants already at the right price.
  const VARIANT_UPDATE_MUTATION = `#graphql
    mutation UpdatePrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        userErrors { field message }
      }
    }`;

  const byProduct = new Map<number, typeof matched>();
  for (const m of eligible) {
    const before = beforeMap.get(m.shopifyVariantId)?.price;
    if (before !== undefined && Math.abs(before - m.bsalePrice) < EPS) continue;
    const arr = byProduct.get(m.shopifyProductId) ?? [];
    arr.push(m);
    byProduct.set(m.shopifyProductId, arr);
  }

  let shopifyUpdated = 0;
  const shopifyPushErrors: PriceSyncErrorDetail[] = [];

  if (!preview) {
    for (const [productId, entries] of byProduct.entries()) {
      const variantsInput = entries.map((e) => ({
        id:    `gid://shopify/ProductVariant/${e.shopifyVariantId}`,
        price: e.bsalePrice.toFixed(2),
      }));
      try {
        const res = await admin.graphql(VARIANT_UPDATE_MUTATION, {
          variables: { productId: `gid://shopify/Product/${productId}`, variants: variantsInput },
        });
        const json = await res.json() as {
          data?: { productVariantsBulkUpdate?: { userErrors: Array<{ field: string; message: string }> } };
        };
        const userErrors = json.data?.productVariantsBulkUpdate?.userErrors ?? [];
        if (userErrors.length === 0) {
          shopifyUpdated += entries.length;
        } else {
          const msg = userErrors.map((e) => e.message).join("; ");
          for (const e of entries) shopifyPushErrors.push({ sku_code: e.skuCode, title: e.title, error: msg });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        for (const e of entries) shopifyPushErrors.push({ sku_code: e.skuCode, title: e.title, error: msg });
      }
    }
  }

  // 8. Build per-SKU comparison for the report (only the SKUs we'd actually touch).
  const items: PriceSyncItemDetail[] = eligible
    .map((m) => {
      const before = beforeMap.get(m.shopifyVariantId)?.price ?? null;
      return {
        sku_code: m.skuCode, title: m.title,
        price_before: before, price_after: m.bsalePrice,
        changed: before === null || Math.abs(before - m.bsalePrice) >= EPS,
      };
    })
    .sort((a, b) => {
      if (a.changed !== b.changed) return a.changed ? -1 : 1;
      return a.sku_code.localeCompare(b.sku_code);
    });

  console.log(
    `[bsale-prices] ${mode}  shop=${shopId}  matched=${matched.length}  elegibles=${eligible.length}` +
    `  en_oferta_omitidos=${discountedSkipped.length}  a_cambiar=${items.filter((i) => i.changed).length}` +
    `  pusheados=${shopifyUpdated}`,
  );

  return {
    mode,
    total_bsale_codes: shopifySkus.length,
    shopify_matched:   matched.length,
    skipped:           skippedItems.length,
    synced,
    shopify_updated:   shopifyUpdated,
    errors,
    error_details:       errorDetails,
    skipped_items:       skippedItems,
    items,
    discounted_skipped:  discountedSkipped,
    shopify_push_errors: shopifyPushErrors,
    synced_at: now,
  };
}

// ── On-demand search (Bsale → "Sin publicar" tab) ──────────────────────────────
//
// Bsale's /variants.json?code=X only does an EXACT match on code (verified live —
// a partial code returns count:0). Partial matching only works on /products.json
// via the `name` filter. So a search combines both: exact SKU-code lookup (fast
// path, 0 or 1 result) plus partial product-name lookup (can return several
// products), then expands each matched product's variants. This intentionally
// never scans the full Bsale catalog — bounded by BoundedProducts/BoundedVariants.

interface BsaleRawVariant {
  id:       number;
  code:     string;
  description?: string;
  barCode?: string | null;
  product:  { id: string };
}

interface BsaleRawProduct {
  id:    number;
  name:  string;
  state: number;
}

export interface BsaleSearchVariant {
  bsale_variant_id:    string;
  sku_code:            string;
  barcode:             string | null;
  product_name:        string;
  variant_description: string | null;
  price:               number | null;
}

const MAX_PRODUCTS = 8;
const MAX_VARIANTS = 30;

export async function searchBsaleProducts(
  token:       string,
  priceListId: number,
  query:       string,
): Promise<BsaleSearchVariant[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const [exactVariantRes, productNameRes] = await Promise.all([
    get<BsalePage<BsaleRawVariant>>(`/variants.json?code=${encodeURIComponent(trimmed)}&limit=5`, token).catch(() => null),
    get<BsalePage<BsaleRawProduct>>(`/products.json?name=${encodeURIComponent(trimmed)}&limit=${MAX_PRODUCTS}&state=0`, token).catch(() => null),
  ]);

  const productNameMap = new Map<string, string>();
  const productIds = new Set<string>();
  for (const v of exactVariantRes?.items ?? []) productIds.add(v.product.id);
  for (const p of productNameRes?.items ?? []) {
    productIds.add(String(p.id));
    productNameMap.set(String(p.id), p.name);
  }
  if (productIds.size === 0) return [];

  const productIdList = [...productIds].slice(0, MAX_PRODUCTS);
  const allVariants: Array<BsaleRawVariant & { productId: string }> = [];

  await Promise.all(productIdList.map(async (pid) => {
    try {
      const varsRes = await get<BsalePage<BsaleRawVariant>>(`/products/${pid}/variants.json?limit=50`, token);
      for (const v of varsRes?.items ?? []) {
        if (!v.code?.trim()) continue;
        allVariants.push({ ...v, productId: pid });
      }
      if (!productNameMap.has(pid)) {
        const prod = await get<{ name?: string }>(`/products/${pid}.json`, token).catch(() => null);
        if (prod?.name) productNameMap.set(pid, prod.name);
      }
    } catch (err) {
      console.warn(`[bsale-search] failed to fetch variants for product ${pid}:`, String(err));
    }
  }));

  const bounded = allVariants.slice(0, MAX_VARIANTS);
  const results: BsaleSearchVariant[] = await Promise.all(
    bounded.map(async (v) => {
      let price: number | null = null;
      try {
        const priceRes = await get<BsalePage<{ variantValueWithTaxes: number }>>(
          `/price_lists/${priceListId}/details.json?variantid=${v.id}`,
          token,
        );
        price = priceRes?.items?.[0]?.variantValueWithTaxes ?? null;
      } catch {
        // price stays null — still shown in results, just flagged as "sin precio"
      }

      return {
        bsale_variant_id:    String(v.id),
        sku_code:            v.code.trim(),
        barcode:             v.barCode ?? null,
        product_name:        productNameMap.get(v.productId) ?? v.code,
        variant_description: v.description?.trim() || null,
        price,
      };
    }),
  );

  const upperQuery = trimmed.toUpperCase();
  results.sort((a, b) => {
    const aExact = a.sku_code.toUpperCase() === upperQuery ? 0 : 1;
    const bExact = b.sku_code.toUpperCase() === upperQuery ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    return a.sku_code.localeCompare(b.sku_code);
  });

  return results;
}
