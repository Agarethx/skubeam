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
  const active = await getActiveSyncJob(shopId);
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
  const job = await getActiveSyncJob(shopId);
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
    await processBulkJsonl(op.url, shopId, job.id);
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

// ── Process JSONL ─────────────────────────────────────────────────────────────

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
  const variants: object[] = [];

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
      if (!node.sku) continue;

      const product = productMap.get(node.__parentId);
      const variantTitle =
        node.title && node.title !== "Default Title" ? node.title : null;
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

  // Upsert in batches of 500
  let processed = 0;
  for (let i = 0; i < variants.length; i += 500) {
    const batch = variants.slice(i, i + 500);
    const { error } = await supabaseAdmin
      .from("skus")
      .upsert(batch, { onConflict: "shopify_variant_id" });
    if (error) {
      console.error(`processBulkJsonl batch ${i}:`, error.message);
    } else {
      processed += batch.length;
    }
  }

  await supabaseAdmin
    .from("sync_jobs")
    .update({
      status: "completed",
      records_processed: processed,
      completed_at: new Date().toISOString(),
    })
    .eq("id", jobId);

  await refreshSkuAnalytics();

  return processed;
}
