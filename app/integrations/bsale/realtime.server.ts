import { supabaseAdmin } from "../../db.server";
import { refreshSkuAnalytics } from "../../models/sync.server";
import { apiVersion } from "../../shopify.server";
import { get, put, resolveToken } from "./client.server";

// ── Shopify GraphQL client built from stored offline session ──────────────────
// unauthenticated.admin() fails in external webhook contexts (no request cookie).
// Instead, we load the offline access token directly from shopify_sessions.

async function getShopifyGraphQLClient(shopDomain: string) {
  const { data } = await supabaseAdmin
    .from("shopify_sessions")
    .select("access_token")
    .eq("shop", shopDomain)
    .eq("is_online", false)
    .limit(1)
    .single();

  if (!data?.access_token) {
    throw new Error(`[realtime] No offline session found for shop ${shopDomain}`);
  }

  const token    = data.access_token;
  const endpoint = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;

  return {
    graphql: (query: string, options?: { variables?: Record<string, unknown> }) =>
      fetch(endpoint, {
        method:  "POST",
        headers: {
          "Content-Type":             "application/json",
          "X-Shopify-Access-Token":   token,
        },
        body: JSON.stringify({ query, variables: options?.variables }),
      }),
  };
}

// ── Shopify order payload (ORDERS_PAID webhook) ───────────────────────────────

interface ShopifyLineItem {
  id: number;
  variant_id: number | null;
  quantity: number;
}

export interface ShopifyOrderPayload {
  id: number;
  line_items: ShopifyLineItem[];
}

// ── Bsale notification payload (lightweight webhook — only resourceId) ────────

export interface BsaleNotification {
  resourceId: string;
  resource:   string;
}

// ── Bsale full document (fetched via GET /documents/{id}.json?expand=[details,documentType]) ──

interface BsaleDetailItem {
  id:           number;
  quantity:     number;
  totalAmount?: number;
  variantId?:   number;
  variant?:     { id: number; code?: string };
}

interface BsaleFullDocument {
  id:             number;
  officeId?:      number;
  emissionDate?:  number; // Unix timestamp
  salesId?:       string; // set by SkuBeam on emit_boleta: "shopify_ORDERID"
  document_type?: { id: number; codeSii?: number };
  details?: {
    href?:  string;
    items?: BsaleDetailItem[];
  };
}

// Bsale SII codes that represent a sale (factura, boleta y variantes)
const SALE_DOCUMENT_CODES = [33, 34, 39, 41];

// ── Idempotency helpers ───────────────────────────────────────────────────────

async function isAlreadyProcessed(
  shopId:     string,
  source:     string,
  externalId: string,
): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("processed_webhooks")
    .select("id")
    .eq("shop_id", shopId)
    .eq("source", source)
    .eq("external_id", externalId)
    .maybeSingle();
  return data !== null;
}

async function markProcessed(
  shopId:     string,
  source:     string,
  externalId: string,
): Promise<void> {
  await supabaseAdmin
    .from("processed_webhooks")
    .upsert(
      { shop_id: shopId, source, external_id: externalId },
      { onConflict: "shop_id,source,external_id", ignoreDuplicates: true },
    );
}

// ── Flujo 1: Shopify ORDERS_PAID → Bsale stock adjustment ────────────────────

export async function handleShopifyOrderPaid(
  shopId: string,
  order:  ShopifyOrderPayload,
): Promise<void> {
  const orderId = String(order.id);
  console.log(`[realtime/shopify_order] ── inicio orden=${orderId} shop=${shopId}`);

  if (await isAlreadyProcessed(shopId, "shopify", `order_${orderId}`)) {
    console.log(`[realtime/shopify_order] Orden ${orderId} ya procesada — saltando`);
    return;
  }

  const { data: shop } = await supabaseAdmin
    .from("shops")
    .select("bsale_token")
    .eq("shop_id", shopId)
    .single();

  console.log(`[realtime/shopify_order] Token Bsale encontrado: ${!!shop?.bsale_token}`);

  if (!shop?.bsale_token) {
    console.log(`[realtime/shopify_order] Shop ${shopId} sin token Bsale — marcando procesado`);
    await markProcessed(shopId, "shopify", `order_${orderId}`);
    return;
  }

  const token = resolveToken(shop.bsale_token);

  const variantIds = order.line_items
    .filter((li) => li.variant_id != null)
    .map((li) => li.variant_id!);

  console.log(`[realtime/shopify_order] Variant IDs de la orden:`, variantIds);

  if (variantIds.length === 0) {
    console.log(`[realtime/shopify_order] Sin variant_ids en la orden — saltando`);
    await markProcessed(shopId, "shopify", `order_${orderId}`);
    return;
  }

  const { data: skus } = await supabaseAdmin
    .from("skus")
    .select("shopify_variant_id, bsale_variant_id")
    .eq("shop_id", shopId)
    .in("shopify_variant_id", variantIds)
    .not("bsale_variant_id", "is", null);

  console.log(`[realtime/shopify_order] SKUs con mapeo Bsale encontrados: ${skus?.length ?? 0}`, {
    mapped: skus?.map((s) => ({ shopify: s.shopify_variant_id, bsale: s.bsale_variant_id })) ?? [],
  });

  if (!skus || skus.length === 0) {
    console.log(`[realtime/shopify_order] Sin SKUs mapeados a Bsale para orden ${orderId}`);
    console.log(`[realtime/shopify_order] ⚠ Para que el stock se ajuste en Bsale, sincroniza productos primero`);
    await markProcessed(shopId, "shopify", `order_${orderId}`);
    return;
  }

  const bsaleMap = new Map<number, number>();
  for (const sku of skus) {
    if (sku.shopify_variant_id != null && sku.bsale_variant_id != null) {
      bsaleMap.set(sku.shopify_variant_id, Number(sku.bsale_variant_id));
    }
  }

  for (const lineItem of order.line_items) {
    if (!lineItem.variant_id) continue;
    const bsaleVariantId = bsaleMap.get(lineItem.variant_id);
    if (!bsaleVariantId) {
      console.log(`[realtime/shopify_order] variant_id=${lineItem.variant_id} sin mapeo Bsale — saltando`);
      continue;
    }

    console.log(`[realtime/shopify_order] Ajustando stock Bsale`, {
      shopifyVariantId: lineItem.variant_id,
      bsaleVariantId,
      delta: -lineItem.quantity,
    });

    try {
      await put("/stocks/adjustments.json", token, {
        quantity:  -lineItem.quantity,
        officeId:  1,
        variantId: bsaleVariantId,
      });
      console.log(`[realtime/shopify_order] ✓ Stock ajustado: bsaleVariantId=${bsaleVariantId} delta=-${lineItem.quantity}`);
    } catch (err) {
      console.error(`[realtime/shopify_order] ✗ Error ajustando stock bsaleVariantId=${bsaleVariantId}:`, err);
    }
  }

  await markProcessed(shopId, "shopify", `order_${orderId}`);
  console.log(`[realtime/shopify_order] ── fin orden=${orderId}`);
}

// ── Flujo 2: Bsale document:add → Shopify inventory adjustment ───────────────

export async function handleBsaleDocumentAdd(
  shopId:     string,
  documentId: string,
): Promise<void> {
  if (await isAlreadyProcessed(shopId, "bsale", `doc_${documentId}`)) {
    console.log(`[realtime] Bsale document ${documentId} already processed — skip`);
    return;
  }

  // Get shop's Bsale token (needed to fetch the full document)
  const { data: shop } = await supabaseAdmin
    .from("shops")
    .select("bsale_token")
    .eq("shop_id", shopId)
    .single();

  if (!shop?.bsale_token) {
    console.log(`[realtime] Shop ${shopId} has no Bsale token — skip document ${documentId}`);
    await markProcessed(shopId, "bsale", `doc_${documentId}`);
    return;
  }

  const token = resolveToken(shop.bsale_token);

  // Fetch the full document — the webhook notification only carries resourceId
  const doc = await get<BsaleFullDocument>(
    `/documents/${documentId}.json?expand=[details,documentType]`,
    token,
  );

  // Log once to confirm the real structure from Bsale
  console.log("[realtime] Bsale full document:", JSON.stringify(doc, null, 2));

  // Skip documents created by SkuBeam itself (emit_boleta job uses salesId = "shopify_XXX")
  // Processing these back would double-adjust Shopify stock already reduced by the sale
  if (doc.salesId?.startsWith("shopify_")) {
    console.log(`[realtime] Documento ${documentId} creado por SkuBeam (salesId=${doc.salesId}) — skip para evitar loop`);
    await markProcessed(shopId, "bsale", `doc_${documentId}`);
    return;
  }

  const details = doc.details?.items ?? [];

  if (details.length === 0) {
    console.log(`[realtime] Document ${documentId} has no details — skip`);
    await markProcessed(shopId, "bsale", `doc_${documentId}`);
    return;
  }

  // Extract Bsale variant IDs from the document line items
  const bsaleVariantIds = details
    .map((d) => d.variantId ?? d.variant?.id)
    .filter((id): id is number => id != null);

  if (bsaleVariantIds.length === 0) {
    await markProcessed(shopId, "bsale", `doc_${documentId}`);
    return;
  }

  // Look up shopify_variant_id for each bsale_variant_id
  const { data: skus } = await supabaseAdmin
    .from("skus")
    .select("shopify_variant_id, bsale_variant_id")
    .eq("shop_id", shopId)
    .in("bsale_variant_id", bsaleVariantIds.map(String))
    .not("shopify_variant_id", "is", null);

  if (!skus || skus.length === 0) {
    console.log(`[realtime] No Shopify-mapped SKUs for Bsale document ${documentId}`);
    await markProcessed(shopId, "bsale", `doc_${documentId}`);
    return;
  }

  // bsale_variant_id → shopify_variant_id
  const shopifyMap = new Map<number, number>();
  for (const sku of skus) {
    if (sku.bsale_variant_id != null && sku.shopify_variant_id != null) {
      shopifyMap.set(Number(sku.bsale_variant_id), sku.shopify_variant_id);
    }
  }

  // Unique Shopify variant IDs we need to resolve to inventoryItemId
  const shopifyVariantIds = [
    ...new Set(
      details
        .map((d) => {
          const bId = d.variantId ?? d.variant?.id;
          return bId != null ? shopifyMap.get(bId) : undefined;
        })
        .filter((id): id is number => id != null),
    ),
  ];

  if (shopifyVariantIds.length === 0) {
    await markProcessed(shopId, "bsale", `doc_${documentId}`);
    return;
  }

  // Build Shopify GraphQL client from stored offline session
  const admin = await getShopifyGraphQLClient(shopId);

  // Query Shopify: inventoryItemId per variant + first active location (in parallel)
  const variantGids = shopifyVariantIds.map(
    (id) => `gid://shopify/ProductVariant/${id}`,
  );

  const [inventoryRes, locRes] = await Promise.all([
    admin.graphql(
      `#graphql
      query GetVariantInventoryItems($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            inventoryItem { id }
          }
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
    data?: {
      nodes?: Array<{ id: string; inventoryItem?: { id: string } } | null>;
    };
  };
  const locJson = await locRes.json() as {
    data?: { locations?: { edges: Array<{ node: { id: string } }> } };
  };

  // shopify_variant_id → inventoryItem GID
  const itemMap = new Map<number, string>();
  for (const node of inventoryJson.data?.nodes ?? []) {
    if (!node?.inventoryItem?.id) continue;
    const varId = parseInt(node.id.split("/").pop()!, 10);
    itemMap.set(varId, node.inventoryItem.id);
  }

  const locationId = locJson.data?.locations?.edges[0]?.node.id;
  if (!locationId) {
    console.error(`[realtime] No active Shopify location for shop ${shopId}`);
    await markProcessed(shopId, "bsale", `doc_${documentId}`);
    return;
  }

  // Build delta changes (always negative — this is a sale)
  const changes: Array<{
    inventoryItemId: string;
    locationId:      string;
    delta:           number;
  }> = [];

  for (const detail of details) {
    const bsaleVarId = detail.variantId ?? detail.variant?.id;
    if (bsaleVarId == null) continue;
    const shopifyVarId = shopifyMap.get(bsaleVarId);
    if (shopifyVarId == null) continue;
    const inventoryItemId = itemMap.get(shopifyVarId);
    if (!inventoryItemId) continue;

    changes.push({
      inventoryItemId,
      locationId,
      delta: -Math.abs(detail.quantity),
    });
  }

  if (changes.length === 0) {
    await markProcessed(shopId, "bsale", `doc_${documentId}`);
    return;
  }

  // Call Shopify inventoryAdjustQuantities (delta, not absolute)
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
          changes,
        },
      },
    },
  );

  const adjustJson = await adjustRes.json() as {
    data?: {
      inventoryAdjustQuantities?: {
        userErrors: Array<{ field: string; message: string }>;
      };
    };
  };

  const userErrors = adjustJson.data?.inventoryAdjustQuantities?.userErrors ?? [];
  if (userErrors.length > 0) {
    console.error(
      `[realtime] inventoryAdjustQuantities errors doc ${documentId}:`,
      userErrors,
    );
  } else {
    console.log(
      `[realtime] Shopify inventory adjusted for Bsale doc ${documentId} (${changes.length} items)`,
    );
  }

  // Register sale in sales_history if this document is a sale (non-blocking)
  if (SALE_DOCUMENT_CODES.includes(doc.document_type?.codeSii ?? -1)) {
    await recordBsaleSale(shopId, token, doc);
  }

  await refreshSkuAnalytics();
  await markProcessed(shopId, "bsale", `doc_${documentId}`);
}

// ── recordBsaleSale ───────────────────────────────────────────────────────────

async function recordBsaleSale(
  shopId: string,
  token:  string,
  doc:    BsaleFullDocument,
): Promise<void> {
  try {
    // Fetch details with variant expansion to get sku_code
    const detailsResp = await get<{ items?: BsaleDetailItem[] }>(
      `/documents/${doc.id}/details.json?expand=variant`,
      token,
    );

    const items = detailsResp.items ?? [];
    if (items.length === 0) return;

    // Collect distinct sku_codes to look up sku_id
    const skuCodes = [...new Set(
      items.map((d) => d.variant?.code).filter((c): c is string => !!c),
    )];

    if (skuCodes.length === 0) {
      console.log(`[bsale-sales] No variant codes in document ${doc.id} — skip`);
      return;
    }

    const { data: skus } = await supabaseAdmin
      .from("skus")
      .select("id, sku_code")
      .eq("shop_id", shopId)
      .in("sku_code", skuCodes);

    const skuIdMap = new Map<string, string>();
    for (const s of skus ?? []) {
      skuIdMap.set(s.sku_code, s.id);
    }

    const soldAt = doc.emissionDate
      ? new Date(doc.emissionDate * 1000).toISOString()
      : new Date().toISOString();

    const salesRows = items
      .filter((d) => d.variant?.code && skuIdMap.has(d.variant.code))
      .map((d) => ({
        shop_id:           shopId,
        sku_id:            skuIdMap.get(d.variant!.code!)!,
        sku_code:          d.variant!.code!,
        quantity_sold:     Math.abs(d.quantity),
        revenue:           d.totalAmount ?? 0,
        sold_at:           soldAt,
        channel:           "bsale_pos",
        bsale_document_id: String(doc.id),
      }));

    if (salesRows.length === 0) {
      console.log(`[bsale-sales] No matching SKUs for document ${doc.id} — skip`);
      return;
    }

    const { error } = await supabaseAdmin
      .from("sales_history")
      .upsert(salesRows, {
        onConflict:       "shop_id,bsale_document_id,sku_code",
        ignoreDuplicates: true,
      });

    if (error) {
      console.error("[bsale-sales] Error recording sale:", error);
    } else {
      console.log(`[bsale-sales] Recorded ${salesRows.length} sale lines from document ${doc.id}`);
    }
  } catch (e) {
    // Non-fatal — stock sync already processed; sales history is a best-effort improvement
    console.error("[bsale-sales] Non-fatal error recording sale:", e);
  }
}
