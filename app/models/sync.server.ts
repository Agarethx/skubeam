import { supabaseAdmin } from "../db.server";

// ── Materialized view refresh ─────────────────────────────────────────────────

export async function refreshSkuAnalytics() {
  const { error } = await supabaseAdmin.rpc("refresh_sku_analytics");
  if (error) console.error("[refreshSkuAnalytics]", error.message);
}

// ── Active job ────────────────────────────────────────────────────────────────

export async function getActiveSyncJob(shopId: string) {
  const { data } = await supabaseAdmin
    .from("sync_jobs")
    .select("*")
    .eq("shop_id", shopId)
    .in("status", ["pending", "running"])
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

export async function getLastCompletedSyncJob(shopId: string, type: string) {
  const { data } = await supabaseAdmin
    .from("sync_jobs")
    .select("*")
    .eq("shop_id", shopId)
    .eq("type", type)
    .eq("status", "completed")
    .order("completed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

export async function getActiveSyncJobByType(shopId: string, type: string) {
  const { data } = await supabaseAdmin
    .from("sync_jobs")
    .select("*")
    .eq("shop_id", shopId)
    .eq("type", type)
    .in("status", ["pending", "running"])
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

// Scoped to the two job types actually driven by Shopify's bulk-operations API —
// used by checkAndAdvanceBulkSync so an unrelated active job (bulk_publish,
// bsale_products, bsale_stock) never gets mistaken for the Shopify bulk op being polled.
async function getActiveShopifyBulkJob(shopId: string) {
  const { data } = await supabaseAdmin
    .from("sync_jobs")
    .select("*")
    .eq("shop_id", shopId)
    .in("type", ["full_product_sync", "orders_sync"])
    .in("status", ["pending", "running"])
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

// ── Start bulk sync ───────────────────────────────────────────────────────────

const BULK_PRODUCTS_MUTATION = `#graphql
  mutation ProductsSync {
    bulkOperationRunQuery(
      query: """
        {
          products {
            edges {
              node {
                id
                title
                vendor
                productType
                variants {
                  edges {
                    node {
                      id
                      title
                      sku
                      barcode
                      inventoryItem {
                        unitCost { amount }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      """
    ) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }`;

export async function startBulkSync(admin: { graphql: (query: string) => Promise<Response> }, shopId: string) {
  const active = await getActiveShopifyBulkJob(shopId);
  if (active) return active;

  const response = await admin.graphql(BULK_PRODUCTS_MUTATION);
  const json = await response.json() as {
    data?: {
      bulkOperationRunQuery?: {
        bulkOperation?: { id: string; status: string };
        userErrors: Array<{ field: string; message: string }>;
      };
    };
  };

  const result = json.data?.bulkOperationRunQuery;
  if (result?.userErrors && result.userErrors.length > 0) {
    throw new Error(result.userErrors[0].message);
  }

  const operationId = result?.bulkOperation?.id;
  if (!operationId) throw new Error("Shopify no devolvió un ID de operación.");

  const { data, error } = await supabaseAdmin
    .from("sync_jobs")
    .insert({
      shop_id: shopId,
      type: "full_product_sync",
      status: "running",
      operation_id: operationId,
    })
    .select()
    .single();

  if (error) throw new Error(`startBulkSync DB: ${error.message}`);
  return data;
}

// ── Poll & advance ────────────────────────────────────────────────────────────

const BULK_STATUS_QUERY = `#graphql
  query BulkOperationStatus {
    currentBulkOperation {
      id
      status
      errorCode
      url
      objectCount
    }
  }`;

export async function checkAndAdvanceBulkSync(
  admin: { graphql: (query: string) => Promise<Response> },
  shopId: string,
) {
  const job = await getActiveShopifyBulkJob(shopId);
  if (!job) return null;

  const response = await admin.graphql(BULK_STATUS_QUERY);
  const json = await response.json() as {
    data?: {
      currentBulkOperation?: {
        id: string;
        status: string;
        errorCode: string | null;
        url: string | null;
        objectCount: string | null;
      };
    };
  };

  const op = json.data?.currentBulkOperation;
  if (!op) return job;

  // Guard: only process if this is our operation
  if (op.id !== job.operation_id) return job;

  if (op.status === "COMPLETED" && op.url) {
    if (job.type === "orders_sync") {
      await processOrdersJsonl(op.url, shopId, job.id);
    } else {
      await processBulkJsonl(op.url, shopId, job.id);
    }
    return { ...job, status: "completed" as const };
  }

  if (op.status === "FAILED" || op.status === "CANCELED") {
    await supabaseAdmin
      .from("sync_jobs")
      .update({
        status: "failed",
        error_message: op.errorCode ?? "Unknown error",
        completed_at: new Date().toISOString(),
      })
      .eq("id", job.id);
    return { ...job, status: "failed" as const };
  }

  // Still running — update object count for progress display
  const count = op.objectCount ? Number(op.objectCount) : null;
  if (count !== null) {
    await supabaseAdmin
      .from("sync_jobs")
      .update({ records_processed: count })
      .eq("id", job.id);
    return { ...job, records_processed: count };
  }

  return job;
}

// ── Orders bulk sync ──────────────────────────────────────────────────────────

export async function startOrdersSync(
  admin: { graphql: (query: string) => Promise<Response> },
  shopId: string,
) {
  const active = await getActiveShopifyBulkJob(shopId);
  if (active) return active;

  const since = new Date();
  since.setFullYear(since.getFullYear() - 1);
  const sinceDate = since.toISOString().split("T")[0];

  const mutation = `#graphql
    mutation {
      bulkOperationRunQuery(
        query: """
          {
            orders(query: "created_at:>=${sinceDate}") {
              edges {
                node {
                  id
                  createdAt
                  lineItems {
                    edges {
                      node {
                        id
                        quantity
                        variant { id }
                      }
                    }
                  }
                }
              }
            }
          }
        """
      ) {
        bulkOperation { id status }
        userErrors { field message }
      }
    }`;

  const response = await admin.graphql(mutation);
  const json = await response.json() as {
    data?: {
      bulkOperationRunQuery?: {
        bulkOperation?: { id: string; status: string };
        userErrors: Array<{ field: string; message: string }>;
      };
    };
  };

  const result = json.data?.bulkOperationRunQuery;
  if (result?.userErrors && result.userErrors.length > 0) {
    throw new Error(result.userErrors[0].message);
  }

  const operationId = result?.bulkOperation?.id;
  if (!operationId) throw new Error("Shopify no devolvió un ID de operación para órdenes.");

  const { data, error } = await supabaseAdmin
    .from("sync_jobs")
    .insert({
      shop_id: shopId,
      type: "orders_sync",
      status: "running",
      operation_id: operationId,
    })
    .select()
    .single();

  if (error) throw new Error(`startOrdersSync DB: ${error.message}`);
  return data;
}

// ── Process Orders JSONL ───────────────────────────────────────────────────────

export async function processOrdersJsonl(
  jsonlUrl: string,
  shopId: string,
  jobId: string,
) {
  const fetchResponse = await fetch(jsonlUrl);
  if (!fetchResponse.ok) {
    throw new Error(`processOrdersJsonl: HTTP ${fetchResponse.status}`);
  }

  const text = await fetchResponse.text();
  const lines = text.trim().split("\n").filter(Boolean);

  // Pass 1: collect order createdAt timestamps
  const orderMap = new Map<string, string>(); // orderId GID → createdAt ISO

  for (const line of lines) {
    const node = JSON.parse(line) as {
      id: string;
      __parentId?: string;
      createdAt?: string;
    };
    if (!node.__parentId && node.createdAt) {
      orderMap.set(node.id, node.createdAt);
    }
  }

  // Pass 2: collect line items
  const lineItems: Array<{
    variantGid: string;
    lineItemId: number;
    quantity: number;
    orderGid: string;
  }> = [];

  for (const line of lines) {
    const node = JSON.parse(line) as {
      id: string;
      __parentId?: string;
      quantity?: number;
      variant?: { id: string } | null;
    };
    if (
      node.__parentId &&
      node.variant?.id &&
      (node.quantity ?? 0) > 0
    ) {
      lineItems.push({
        variantGid:  node.variant.id,
        lineItemId:  parseInt(node.id.split("/").pop()!, 10),
        quantity:    node.quantity!,
        orderGid:    node.__parentId,
      });
    }
  }

  if (lineItems.length === 0) {
    await supabaseAdmin
      .from("sync_jobs")
      .update({ status: "completed", records_processed: 0, completed_at: new Date().toISOString() })
      .eq("id", jobId);
    return 0;
  }

  // Lookup sku_id by shopify_variant_id
  const variantIds = [...new Set(
    lineItems.map((li) => parseInt(li.variantGid.split("/").pop()!, 10)),
  )];

  const { data: skus } = await supabaseAdmin
    .from("skus")
    .select("id, shopify_variant_id")
    .eq("shop_id", shopId)
    .in("shopify_variant_id", variantIds);

  const skuMap = new Map<number, string>(); // shopify_variant_id → sku uuid
  for (const sku of skus ?? []) {
    if (sku.shopify_variant_id != null) {
      skuMap.set(sku.shopify_variant_id, sku.id);
    }
  }

  // Build rows
  const now = new Date().toISOString();
  const rows: object[] = [];

  for (const li of lineItems) {
    const variantId = parseInt(li.variantGid.split("/").pop()!, 10);
    const skuId     = skuMap.get(variantId);
    const soldAt    = orderMap.get(li.orderGid);
    const orderId   = parseInt(li.orderGid.split("/").pop()!, 10);

    if (!skuId || !soldAt) continue;

    rows.push({
      shop_id:               shopId,
      sku_id:                skuId,
      shopify_order_id:      orderId,
      shopify_line_item_id:  li.lineItemId,
      quantity_sold:         li.quantity,
      sold_at:               soldAt,
    });
  }

  // Upsert in batches (idempotent via unique index on sku_id, shopify_line_item_id)
  let processed = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await supabaseAdmin
      .from("sales_history")
      .upsert(batch, { onConflict: "sku_id,shopify_line_item_id" });
    if (error) {
      console.error(`processOrdersJsonl batch ${i}:`, error.message);
    } else {
      processed += batch.length;
    }
  }

  await supabaseAdmin
    .from("sync_jobs")
    .update({
      status: "completed",
      records_processed: processed,
      completed_at: now,
    })
    .eq("id", jobId);

  await refreshSkuAnalytics();
  return processed;
}

// ── Process Products JSONL ─────────────────────────────────────────────────────

export type SkippedProductSyncItem = {
  shopify_variant_id: number;
  shopify_product_id: number | null;
  product_title: string;
  variant_title: string | null;
  sku_code?: string;
  reason: "no_sku" | "duplicate_sku" | "other_error";
  detail?: string;
  /** For reason=duplicate_sku: the product title already holding this SKU code. */
  conflicts_with_title?: string;
};

export type ProductSyncSummary = {
  records_total: number;
  skipped: SkippedProductSyncItem[];
};

export async function processBulkJsonl(
  jsonlUrl: string,
  shopId: string,
  jobId: string,
) {
  const fetchResponse = await fetch(jsonlUrl);
  if (!fetchResponse.ok) {
    throw new Error(`processBulkJsonl: HTTP ${fetchResponse.status}`);
  }

  const text = await fetchResponse.text();
  const lines = text.trim().split("\n").filter(Boolean);

  const productMap = new Map<
    string,
    { title: string; vendor: string | null; productType: string | null }
  >();
  const variants: Array<{
    shop_id: string;
    shopify_variant_id: number;
    shopify_product_id: number;
    sku_code: string;
    barcode: string | null;
    title: string | null;
    vendor: string | null;
    product_type: string | null;
    cost_price: number | null;
    status: string;
    updated_at: string;
  }> = [];
  const skippedItems: SkippedProductSyncItem[] = [];
  let recordsTotal = 0;

  for (const line of lines) {
    const node = JSON.parse(line) as {
      id: string;
      __parentId?: string;
      title?: string;
      vendor?: string;
      productType?: string;
      sku?: string;
      barcode?: string;
      inventoryItem?: { unitCost?: { amount?: string } };
    };

    if (!node.__parentId) {
      productMap.set(node.id, {
        title: node.title ?? node.id,
        vendor: node.vendor ?? null,
        productType: node.productType ?? null,
      });
    } else {
      recordsTotal++;
      const product = productMap.get(node.__parentId);
      const variantTitle =
        node.title && node.title !== "Default Title" ? node.title : null;

      if (!node.sku) {
        skippedItems.push({
          shopify_variant_id: parseInt(node.id.split("/").pop()!, 10),
          shopify_product_id: parseInt(node.__parentId.split("/").pop()!, 10),
          product_title: product?.title ?? node.__parentId,
          variant_title: variantTitle,
          reason: "no_sku",
        });
        continue;
      }

      const fullTitle = product
        ? variantTitle
          ? `${product.title} - ${variantTitle}`
          : product.title
        : node.sku;

      variants.push({
        shop_id: shopId,
        shopify_variant_id: parseInt(node.id.split("/").pop()!, 10),
        shopify_product_id: parseInt(node.__parentId.split("/").pop()!, 10),
        sku_code: node.sku,
        barcode: node.barcode || null,
        title: fullTitle,
        vendor: product?.vendor ?? null,
        product_type: product?.productType ?? null,
        cost_price: node.inventoryItem?.unitCost?.amount
          ? parseFloat(node.inventoryItem.unitCost.amount)
          : null,
        status: "active",
        updated_at: new Date().toISOString(),
      });
    }
  }

  // Upsert in batches of 500 — a batch-level failure (e.g. one variant's SKU
  // colliding with an existing row under skus_shop_sku_unique) must not silently
  // drop the other ~499 valid rows in that batch, so retry row-by-row on error.
  let processed = 0;
  for (let i = 0; i < variants.length; i += 500) {
    const batch = variants.slice(i, i + 500);
    const { error } = await supabaseAdmin
      .from("skus")
      .upsert(batch, { onConflict: "shopify_variant_id" });

    if (!error) {
      processed += batch.length;
      continue;
    }

    console.error(`processBulkJsonl batch ${i}:`, error.message);
    for (const row of batch) {
      const { error: rowError } = await supabaseAdmin
        .from("skus")
        .upsert([row], { onConflict: "shopify_variant_id" });

      if (!rowError) {
        processed++;
        continue;
      }

      const isDuplicateSku =
        rowError.code === "23505" && rowError.message.includes("skus_shop_sku_unique");

      if (isDuplicateSku) {
        const { data: existing } = await supabaseAdmin
          .from("skus")
          .select("title")
          .eq("shop_id", shopId)
          .eq("sku_code", row.sku_code)
          .maybeSingle();

        skippedItems.push({
          shopify_variant_id: row.shopify_variant_id,
          shopify_product_id: row.shopify_product_id,
          product_title: row.title ?? row.sku_code,
          variant_title: null,
          sku_code: row.sku_code,
          reason: "duplicate_sku",
          conflicts_with_title: existing?.title ?? undefined,
        });
      } else {
        skippedItems.push({
          shopify_variant_id: row.shopify_variant_id,
          shopify_product_id: row.shopify_product_id,
          product_title: row.title ?? row.sku_code,
          variant_title: null,
          sku_code: row.sku_code,
          reason: "other_error",
          detail: rowError.message,
        });
      }
    }
  }

  const summary: ProductSyncSummary = { records_total: recordsTotal, skipped: skippedItems };

  await supabaseAdmin
    .from("sync_jobs")
    .update({
      status: "completed",
      records_processed: processed,
      completed_at: new Date().toISOString(),
      payload: summary,
    })
    .eq("id", jobId);

  await refreshSkuAnalytics();

  return processed;
}
