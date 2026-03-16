import { supabaseAdmin } from "../../db.server";
import { refreshSkuAnalytics } from "../../models/sync.server";
import {
  paginateProducts,
  paginateOrders,
  getVariations,
  type WooCredentials,
  type WooSimpleProduct,
  type WooVariableProduct,
  type WooVariation,
  type WooCategory,
  type WooImage,
} from "./client.server";

export type WooJobType = "woo_migration" | "woo_migration_preview";

// ── Job CRUD ──────────────────────────────────────────────────────────────────

export async function createWooJob(shopId: string, preview = false) {
  const type: WooJobType = preview ? "woo_migration_preview" : "woo_migration";
  const { data, error } = await supabaseAdmin
    .from("sync_jobs")
    .insert({ shop_id: shopId, type, status: "running" })
    .select()
    .single();

  if (error) throw new Error(`createWooJob: ${error.message}`);
  return data;
}

export async function getActiveWooJob(shopId: string) {
  const { data } = await supabaseAdmin
    .from("sync_jobs")
    .select("id, type, status, records_processed, started_at")
    .eq("shop_id", shopId)
    .in("type", ["woo_migration", "woo_migration_preview"] as WooJobType[])
    .in("status", ["pending", "running"])
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

// ── Job state helpers ─────────────────────────────────────────────────────────

async function updateJobProgress(jobId: string, records: number) {
  await supabaseAdmin
    .from("sync_jobs")
    .update({ records_processed: records })
    .eq("id", jobId);
}

async function completeJob(jobId: string, total: number) {
  await supabaseAdmin
    .from("sync_jobs")
    .update({
      status:            "completed",
      records_processed: total,
      completed_at:      new Date().toISOString(),
    })
    .eq("id", jobId);
}

async function failJob(jobId: string, err: unknown) {
  await supabaseAdmin
    .from("sync_jobs")
    .update({
      status:        "failed",
      error_message: err instanceof Error ? err.message : String(err),
      completed_at:  new Date().toISOString(),
    })
    .eq("id", jobId);
}

// ── WooCommerce credentials ───────────────────────────────────────────────────

async function resolveWooCreds(shopId: string): Promise<WooCredentials> {
  const { data, error } = await supabaseAdmin
    .from("woo_connections")
    .select("url, consumer_key, consumer_secret")
    .eq("shop_id", shopId)
    .single();

  if (error) throw new Error(`resolveWooCreds DB error: ${error.message}`);
  if (!data) throw new Error("No WooCommerce connection found for this shop.");
  console.log("[woo-jobs] woo_connection found", { url: data.url });
  return { url: data.url, consumerKey: data.consumer_key, consumerSecret: data.consumer_secret };
}

// ── Shopify context ───────────────────────────────────────────────────────────

interface ShopifyCtx {
  shopId:      string;
  accessToken: string;
  locationGid: string;  // gid://shopify/Location/XXXXX
}

async function resolveShopifyCtx(shopId: string): Promise<ShopifyCtx | null> {
  console.log("[woo-jobs] resolveShopifyCtx: looking up session", { sessionId: `offline_${shopId}` });

  const { data: sessionData, error: sessionError } = await supabaseAdmin
    .from("shopify_sessions")
    .select("access_token")
    .eq("id", `offline_${shopId}`)
    .single();

  console.log("[woo-jobs] resolveShopifyCtx: session result", {
    found:    !!sessionData,
    hasToken: !!sessionData?.access_token,
    error:    sessionError?.message ?? null,
  });

  if (!sessionData?.access_token) {
    console.warn("[woo-jobs] no Shopify offline session found for", shopId);
    return null;
  }
  const accessToken = sessionData.access_token as string;

  const locRes = await fetch(
    `https://${shopId}/admin/api/2026-04/locations.json`,
    { headers: { "X-Shopify-Access-Token": accessToken } },
  );
  if (!locRes.ok) {
    console.warn("[woo-jobs] failed to fetch Shopify locations", locRes.status);
    return null;
  }
  const locData = await locRes.json() as { locations: Array<{ id: number }> };
  if (!locData.locations?.length) {
    console.warn("[woo-jobs] no Shopify locations found");
    return null;
  }

  const locationGid = `gid://shopify/Location/${locData.locations[0].id}`;
  console.log("[woo-jobs] shopify context resolved", { locationGid });
  return { shopId, accessToken, locationGid };
}

async function shopifyGQL(
  ctx:       ShopifyCtx,
  query:     string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(
    `https://${ctx.shopId}/admin/api/2026-04/graphql.json`,
    {
      method:  "POST",
      headers: {
        "Content-Type":           "application/json",
        "X-Shopify-Access-Token": ctx.accessToken,
      },
      body: JSON.stringify({ query, variables }),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify GraphQL HTTP ${res.status}: ${body}`);
  }

  const json = await res.json() as Record<string, unknown>;

  // Surface GraphQL-level errors (HTTP 200 but errors in payload).
  if (Array.isArray(json.errors) && json.errors.length > 0) {
    console.error("[woo-jobs] shopifyGQL GraphQL errors", JSON.stringify(json.errors));
  }

  return json;
}

function gidToNumeric(gid: string): number {
  return parseInt(gid.split("/").pop() ?? "0", 10);
}

// ── Shopify GraphQL mutations ─────────────────────────────────────────────────

// Step 1 for simple products: create product + get default variant.
// Uses the current `product: ProductCreateInput!` argument (not deprecated `input:`).
const PRODUCT_CREATE_MUTATION = `
  mutation productCreate($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product {
        id
        variants(first: 1) {
          nodes { id inventoryItem { id } }
        }
      }
      userErrors { field message }
    }
  }
`;

// Step 1 for variable products: create product shell — no options, no variants.
// productVariantsBulkCreate (step 2) adds real variants with REMOVE_STANDALONE_VARIANT.
// Uses the current `product: ProductCreateInput!` argument (not deprecated `input:`).
const PRODUCT_CREATE_SHELL_MUTATION = `
  mutation productCreate($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product { id }
      userErrors { field message }
    }
  }
`;

// Step 2 for variable products: add the option with all values to the product shell.
// Options must exist before productVariantsBulkCreate can reference them by name.
const PRODUCT_OPTIONS_CREATE_MUTATION = `
  mutation productOptionsCreate($productId: ID!, $options: [OptionCreateInput!]!) {
    productOptionsCreate(productId: $productId, options: $options) {
      product {
        options { id name values }
      }
      userErrors { field message }
    }
  }
`;

// Step 3 for variable products: create all variants at once.
// strategy: REMOVE_STANDALONE_VARIANT removes the default variant Shopify auto-creates.
// Returns variants directly — no extra query needed.
const VARIANT_BULK_CREATE_MUTATION = `
  mutation productVariantsBulkCreate(
    $productId: ID!
    $variants:  [ProductVariantsBulkInput!]!
    $strategy:  ProductVariantsBulkCreateStrategy
  ) {
    productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: $strategy) {
      productVariants { id title inventoryItem { id } }
      userErrors { field message }
    }
  }
`;

// Updates price (and optionally SKU) on existing variants (simple products).
const VARIANT_UPDATE_MUTATION = `
  mutation productVariantsBulkUpdate(
    $productId: ID!
    $variants:  [ProductVariantsBulkInput!]!
  ) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id inventoryItem { id } }
      userErrors { field message }
    }
  }
`;

// Sets tracked + sku on the inventory item.
const INVENTORY_ITEM_UPDATE_MUTATION = `
  mutation inventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
    inventoryItemUpdate(id: $id, input: $input) {
      inventoryItem { id tracked }
      userErrors { field message }
    }
  }
`;


const PRODUCT_CREATE_MEDIA_MUTATION = `
  mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media { ... on MediaImage { id } }
      userErrors { field message }
    }
  }
`;

// ── Shopify product creation ───────────────────────────────────────────────────

interface ShopifyProductIds {
  productGid:       string;
  variantGid:       string;
  inventoryItemGid: string;
}

/**
 * Creates one Shopify product for a single SKU/variant, sets its price, SKU
 * code, inventory tracking, and stock level. Never throws — returns null on
 * any error so the migration continues without failing.
 */
async function createShopifyProductForSku(
  ctx:      ShopifyCtx,
  title:    string,
  vendor:   string | null,
  skuCode:  string,
  price:    string | null,
  stockQty: number | null,
): Promise<ShopifyProductIds | null> {
  try {
    // ── Step 1: productCreate ─────────────────────────────────────────────
    const createRes = await shopifyGQL(ctx, PRODUCT_CREATE_MUTATION, {
      product: {
        title,
        ...(vendor ? { vendor } : {}),
      },
    });

    const productCreate = (createRes as {
      data?: {
        productCreate?: {
          product?: {
            id:       string;
            variants: { nodes: Array<{ id: string; inventoryItem: { id: string } }> };
          };
          userErrors: Array<{ field: string; message: string }>;
        };
      };
    }).data?.productCreate;

    if (productCreate?.userErrors?.length) {
      console.error("[woo-jobs] productCreate userErrors", productCreate.userErrors);
      return null;
    }
    const product = productCreate?.product;
    if (!product) return null;

    const productGid       = product.id;
    const variantNode      = product.variants.nodes[0];
    if (!variantNode) return null;
    const variantGid       = variantNode.id;
    const inventoryItemGid = variantNode.inventoryItem.id;

    // ── Step 2: productVariantsBulkUpdate (SKU + price) ──────────────────
    // Sets sku via the variant — belt-and-suspenders alongside inventoryItemUpdate below.
    const variantInput: Record<string, unknown> = { id: variantGid, sku: skuCode };
    if (price) variantInput.price = price;

    const updateRes = await shopifyGQL(ctx, VARIANT_UPDATE_MUTATION, {
      productId: productGid,
      variants:  [variantInput],
    });
    const variantErrors = ((updateRes as {
      data?: { productVariantsBulkUpdate?: { userErrors: Array<{ field: string; message: string }> } };
    }).data?.productVariantsBulkUpdate?.userErrors) ?? [];
    if (variantErrors.length) {
      console.warn("[woo-jobs] productVariantsBulkUpdate userErrors", variantErrors);
    }

    // ── Step 3: inventoryItemUpdate (tracked: true + sku) ─────────────────
    // sku on InventoryItemInput is available in 2026-04; tracked enables inventory.
    const itemUpdateRes = await shopifyGQL(ctx, INVENTORY_ITEM_UPDATE_MUTATION, {
      id:    inventoryItemGid,
      input: { tracked: true, sku: skuCode },
    });
    const itemErrors = ((itemUpdateRes as {
      data?: { inventoryItemUpdate?: { userErrors: Array<{ field: string; message: string }> } };
    }).data?.inventoryItemUpdate?.userErrors) ?? [];
    if (itemErrors.length) {
      console.warn("[woo-jobs] inventoryItemUpdate userErrors", itemErrors);
    }

    // ── Step 4: inventoryAdjustQuantities (set stock) ─────────────────────
    if (stockQty != null && stockQty > 0) {
      const inventoryItemNumericId = gidToNumeric(inventoryItemGid);
      const locationNumericId      = gidToNumeric(ctx.locationGid);
      const stockRes = await fetch(
        `https://${ctx.shopId}/admin/api/2026-04/inventory_levels/set.json`,
        {
          method:  "POST",
          headers: {
            "Content-Type":           "application/json",
            "X-Shopify-Access-Token": ctx.accessToken,
          },
          body: JSON.stringify({
            location_id:       locationNumericId,
            inventory_item_id: inventoryItemNumericId,
            available:         stockQty,
          }),
        },
      );
      if (!stockRes.ok) {
        const body = await stockRes.text();
        console.warn("[woo-jobs] REST inventory/set failed", { inventoryItemNumericId, status: stockRes.status, body });
      } else {
        console.log("[woo-jobs] stock set via REST", { sku: skuCode, available: stockQty });
      }
    }

    return { productGid, variantGid, inventoryItemGid };
  } catch (err) {
    console.error("[woo-jobs] createShopifyProductForSku error", { skuCode, err });
    return null;
  }
}

// ── Supabase SKU upsert + Shopify sync ────────────────────────────────────────

function wooStatusToSkuStatus(wooStatus: string): string {
  if (wooStatus === "publish") return "active";
  if (wooStatus === "draft")   return "draft";
  return "archived";
}

async function processSimpleProduct(
  shopId:     string,
  product:    WooSimpleProduct,
  shopifyCtx: ShopifyCtx | null,
): Promise<boolean> {
  const skuCode = product.sku || `woo-${product.id}`;
  const price   = product.regular_price || product.price || null;

  // Supabase upsert
  const { error } = await supabaseAdmin
    .from("skus")
    .upsert(
      {
        shop_id:    shopId,
        sku_code:   skuCode,
        title:      product.name,
        status:     wooStatusToSkuStatus(product.status),
        cost_price: price ? parseFloat(price) || null : null,
      },
      { onConflict: "shop_id,sku_code", ignoreDuplicates: false },
    );

  if (error) {
    console.error("[woo-jobs] upsertSimpleProduct error", { skuCode, error: error.message });
    return false;
  }
  console.log("[woo-jobs] product processed", { sku: skuCode, title: product.name });

  // Shopify sync
  if (shopifyCtx) {
    const vendor = product.categories?.[0]?.name ?? null;
    const ids    = await createShopifyProductForSku(
      shopifyCtx, product.name, vendor, skuCode, price, product.stock_quantity,
    );
    if (ids) {
      await supabaseAdmin
        .from("skus")
        .update({
          shopify_product_id: gidToNumeric(ids.productGid),
          shopify_variant_id: gidToNumeric(ids.variantGid),
        })
        .eq("shop_id", shopId)
        .eq("sku_code", skuCode);
      console.log("[woo-jobs] shopify product created", { sku: skuCode, shopifyProductId: ids.productGid });
    }
  }

  return true;
}

// ── Variable product: ONE Shopify product with multiple variants ──────────────

interface VariationForShopify {
  sku:       string;
  title:     string;
  attrLabel: string;
  price:     string | null;
  stockQty:  number | null;
}

/**
 * Gets or creates a Shopify custom collection by name, using a job-level cache
 * to prevent duplicates across products. Associates the product via POST /collects.json.
 * Best-effort: errors are logged but never thrown.
 */
async function getOrCreateCollection(
  name:           string,
  cache:          Map<string, string>,
  ctx:            ShopifyCtx,
  numericProductId: string,
): Promise<string | null> {
  const authHeaders = {
    "Content-Type":           "application/json",
    "X-Shopify-Access-Token": ctx.accessToken,
  };
  const baseUrl = `https://${ctx.shopId}/admin/api/2026-04`;

  let collectionId = cache.get(name);

  if (!collectionId) {
    // Check if collection already exists in Shopify
    try {
      const searchRes = await fetch(
        `${baseUrl}/custom_collections.json?title=${encodeURIComponent(name)}&limit=1`,
        { headers: authHeaders },
      );
      if (searchRes.ok) {
        const searchJson = await searchRes.json() as { custom_collections?: Array<{ id: number }> };
        if (searchJson.custom_collections && searchJson.custom_collections.length > 0) {
          collectionId = String(searchJson.custom_collections[0].id);
          cache.set(name, collectionId);
          console.log("[woo-jobs] collection found existing", { name, collectionId });
        }
      }
    } catch (err) {
      console.warn("[woo-jobs] getOrCreateCollection search error", { name, err });
    }
  }

  if (!collectionId) {
    // Create new collection
    try {
      const createRes = await fetch(`${baseUrl}/custom_collections.json`, {
        method:  "POST",
        headers: authHeaders,
        body:    JSON.stringify({ custom_collection: { title: name } }),
      });
      if (createRes.ok) {
        const createJson = await createRes.json() as { custom_collection?: { id: number } };
        if (createJson.custom_collection?.id) {
          collectionId = String(createJson.custom_collection.id);
          cache.set(name, collectionId);
          console.log("[woo-jobs] collection created", { name, collectionId });
        }
      } else {
        const body = await createRes.text();
        console.warn("[woo-jobs] collection create failed", { name, status: createRes.status, body });
        return null;
      }
    } catch (err) {
      console.warn("[woo-jobs] getOrCreateCollection create error", { name, err });
      return null;
    }
  }

  if (!collectionId) return null;

  // Associate product to collection via POST /collects.json
  try {
    const collectRes = await fetch(`${baseUrl}/collects.json`, {
      method:  "POST",
      headers: authHeaders,
      body:    JSON.stringify({ collect: { product_id: numericProductId, collection_id: collectionId } }),
    });
    if (!collectRes.ok) {
      const body = await collectRes.text();
      // 422 means already collected — that's fine
      if (collectRes.status !== 422) {
        console.warn("[woo-jobs] collect associate failed", { name, collectionId, status: collectRes.status, body });
      }
    } else {
      console.log("[woo-jobs] product added to collection", { name, collectionId, productId: numericProductId });
    }
  } catch (err) {
    console.warn("[woo-jobs] collect associate error", { name, collectionId, err });
  }

  return collectionId;
}

/**
 * Creates ONE Shopify product with ALL variants for a WooCommerce variable
 * product. Each WooCommerce variation becomes a Shopify variant (not a
 * separate product). Returns the mapping of sku → Shopify IDs, or null on
 * total failure.
 */
async function createShopifyVariableProduct(
  ctx:              ShopifyCtx,
  title:            string,
  vendor:           string | null,
  descriptionHtml:  string,
  categories:       WooCategory[],
  images:           WooImage[],
  variations:       VariationForShopify[],
  collectionCache:  Map<string, string>,
): Promise<Array<{ sku: string; productGid: string; variantGid: string; inventoryItemGid: string }> | null> {
  if (variations.length === 0) return null;

  try {
    // ── Step 1: productCreate — shell only (title, vendor, tags, description) ──
    // No options, no variants. productVariantsBulkCreate (step 2) handles variants.
    console.log("[woo-jobs] createShopifyVariableProduct: step 1 productCreate (shell)", {
      title, vendor, variationCount: variations.length,
    });

    const createRes = await shopifyGQL(ctx, PRODUCT_CREATE_SHELL_MUTATION, {
      product: {
        title,
        status: "ACTIVE",
        ...(vendor          ? { vendor }          : {}),
        ...(descriptionHtml ? { descriptionHtml } : {}),
        tags: ["migrado-woocommerce", ...categories.map((c) => c.name).filter(Boolean)],
      },
    });

    console.log("[woo-jobs] step 1 raw", JSON.stringify((createRes as { data?: unknown }).data));

    const productCreate = (createRes as {
      data?: {
        productCreate?: {
          product?:   { id: string };
          userErrors: Array<{ field: string; message: string }>;
        };
      };
    }).data?.productCreate;

    if (productCreate?.userErrors?.length) {
      console.error("[woo-jobs] step 1 userErrors", productCreate.userErrors);
      return null;
    }
    const productGid = productCreate?.product?.id;
    if (!productGid) {
      console.error("[woo-jobs] step 1 returned no product — full response:", JSON.stringify(createRes));
      return null;
    }
    console.log("[woo-jobs] step 1 done", { productGid });

    // ── Step 1b: publish to online store channel via REST ─────────────────
    const productNumericId = productGid.split("/").pop()!;
    try {
      const pubRes = await fetch(
        `https://${ctx.shopId}/admin/api/2026-04/products/${productNumericId}.json`,
        {
          method:  "PUT",
          headers: {
            "Content-Type":           "application/json",
            "X-Shopify-Access-Token": ctx.accessToken,
          },
          body: JSON.stringify({ product: { id: Number(productNumericId), published: true } }),
        },
      );
      if (!pubRes.ok) {
        const body = await pubRes.text();
        console.warn("[woo-jobs] step 1b publish failed", { productGid, status: pubRes.status, body });
      } else {
        console.log("[woo-jobs] step 1b product published to online store", { productGid });
      }
    } catch (err) {
      console.warn("[woo-jobs] step 1b publish error", { productGid, err });
    }

    // ── Step 2: productOptionsCreate — define option + values on the product ──
    // Options must exist before productVariantsBulkCreate can reference them by name.
    const optionName   = "Tamaño";
    const optionValues = variations.map((v) => ({ name: v.attrLabel || v.sku }));

    console.log("[woo-jobs] step 2: productOptionsCreate", {
      productGid, optionName, valueCount: optionValues.length, optionValues,
    });

    const optionsRes = await shopifyGQL(ctx, PRODUCT_OPTIONS_CREATE_MUTATION, {
      productId: productGid,
      options:   [{ name: optionName, values: optionValues }],
    });

    // Log the FULL response — data + any top-level errors — so we can see exactly
    // what the API returned (including HTTP-200 GraphQL errors or unknown field errors).
    console.log("[woo-jobs] step 2 full response", JSON.stringify(optionsRes));

    const typed2 = optionsRes as {
      data?:   { productOptionsCreate?: { product?: { options: Array<{ id: string; name: string; values: string[] }> }; userErrors: Array<{ field: string; message: string }> } };
      errors?: Array<{ message: string; locations?: unknown }>;
    };

    if (typed2.errors?.length) {
      // Top-level GraphQL errors mean the mutation itself was rejected (e.g. unknown field, auth).
      console.error("[woo-jobs] step 2 GraphQL errors — mutation may not exist in this API version", typed2.errors);
      return null;
    }

    const optionsCreate = typed2.data?.productOptionsCreate;

    if (optionsCreate === undefined) {
      console.error("[woo-jobs] step 2 data.productOptionsCreate is undefined — check mutation name and API version");
      return null;
    }

    if (optionsCreate.userErrors?.length) {
      console.error("[woo-jobs] step 2 userErrors", optionsCreate.userErrors);
      return null;
    }

    console.log("[woo-jobs] step 2 done", {
      options: optionsCreate.product?.options.map((o) => o.name),
    });

    // ── Step 3: productVariantsBulkCreate — all real variants in one call ──
    // Option "Tamaño" now exists; REMOVE_STANDALONE_VARIANT removes the default variant.
    const variantInputs = variations.map((v) => ({
      price:        v.price ?? undefined,
      optionValues: [{ optionName, name: v.attrLabel || v.sku }],
    }));

    console.log("[woo-jobs] step 3: productVariantsBulkCreate", {
      productGid, variantCount: variantInputs.length, variantInputs,
    });

    const bulkRes = await shopifyGQL(ctx, VARIANT_BULK_CREATE_MUTATION, {
      productId: productGid,
      variants:  variantInputs,
      strategy:  "REMOVE_STANDALONE_VARIANT",
    });

    console.log("[woo-jobs] step 3 raw", JSON.stringify((bulkRes as { data?: unknown }).data));

    const bulkCreate = (bulkRes as {
      data?: {
        productVariantsBulkCreate?: {
          productVariants: Array<{ id: string; title: string; inventoryItem: { id: string } }>;
          userErrors:      Array<{ field: string; message: string }>;
        };
      };
    }).data?.productVariantsBulkCreate;

    if (bulkCreate?.userErrors?.length) {
      console.error("[woo-jobs] step 3 userErrors", bulkCreate.userErrors);
      return null;
    }

    const createdVariants = bulkCreate?.productVariants ?? [];
    console.log("[woo-jobs] step 3 done", {
      variantCount:  createdVariants.length,
      variantTitles: createdVariants.map((v) => v.title),
    });

    // Match each created variant back to its source variation by title.
    const matched: Array<{
      variantGid:       string;
      inventoryItemGid: string;
      variation:        VariationForShopify;
    }> = [];

    for (const createdVariant of createdVariants) {
      const variation = variations.find(
        (v) => (v.attrLabel || v.sku) === createdVariant.title,
      );
      if (!variation) {
        console.warn("[woo-jobs] step 3: no variation matched for title", { title: createdVariant.title });
        continue;
      }
      matched.push({
        variantGid:       createdVariant.id,
        inventoryItemGid: createdVariant.inventoryItem.id,
        variation,
      });
    }

    console.log("[woo-jobs] matched variations", { matched: matched.length, total: variations.length });

    // ── Step 4: inventoryItemUpdate per variant — tracked: true + sku ─────
    for (const m of matched) {
      const itemRes = await shopifyGQL(ctx, INVENTORY_ITEM_UPDATE_MUTATION, {
        id:    m.inventoryItemGid,
        input: { tracked: true, sku: m.variation.sku },
      });
      const itemErrors = ((itemRes as {
        data?: { inventoryItemUpdate?: { userErrors: Array<{ field: string; message: string }> } };
      }).data?.inventoryItemUpdate?.userErrors) ?? [];
      if (itemErrors.length) {
        console.warn("[woo-jobs] step 4 inventoryItemUpdate userErrors", { sku: m.variation.sku, itemErrors });
      } else {
        console.log("[woo-jobs] step 4 sku set", { sku: m.variation.sku });
      }
    }

    // ── Step 5: batch inventoryAdjustQuantities for variants with stock ────
    const stockChanges = matched
      .filter((m) => (m.variation.stockQty ?? 0) > 0)
      .map((m) => ({
        inventoryItemId: m.inventoryItemGid,
        locationId:      ctx.locationGid,
        delta:           m.variation.stockQty as number,
        sku:             m.variation.sku,
      }));

    if (stockChanges.length > 0) {
      console.log("[woo-jobs] step 5: setting stock via REST", { changes: stockChanges.length });
      for (const change of stockChanges) {
        const inventoryItemNumericId = gidToNumeric(change.inventoryItemId);
        const locationNumericId      = gidToNumeric(change.locationId);
        const stockRes = await fetch(
          `https://${ctx.shopId}/admin/api/2026-04/inventory_levels/set.json`,
          {
            method:  "POST",
            headers: {
              "Content-Type":           "application/json",
              "X-Shopify-Access-Token": ctx.accessToken,
            },
            body: JSON.stringify({
              location_id:       locationNumericId,
              inventory_item_id: inventoryItemNumericId,
              available:         change.delta,
            }),
          },
        );
        if (!stockRes.ok) {
          const body = await stockRes.text();
          console.warn("[woo-jobs] step 5 REST inventory/set failed", { sku: change.sku, status: stockRes.status, body });
        } else {
          console.log("[woo-jobs] step 5 stock set via REST", { sku: change.sku, available: change.delta });
        }
      }
    }

    // ── Step 6: get/create Shopify collections per WooCommerce category ──────
    if (categories.length > 0) {
      const numericProductId = String(gidToNumeric(productGid));
      for (const category of categories) {
        if (!category.name) continue;
        await getOrCreateCollection(category.name, collectionCache, ctx, numericProductId);
      }
    }

    // ── Step 7: import product images ─────────────────────────────────────
    if (images.length > 0) {
      console.log("[woo-jobs] step 7: importing images", { count: images.length });
      const mediaRes = await shopifyGQL(ctx, PRODUCT_CREATE_MEDIA_MUTATION, {
        productId: productGid,
        media:     images.slice(0, 10).map((img) => ({
          originalSource:   img.src,
          mediaContentType: "IMAGE",
          ...(img.alt ? { alt: img.alt } : {}),
        })),
      });
      const mediaErrors = ((mediaRes as {
        data?: { productCreateMedia?: { userErrors: Array<{ field: string; message: string }> } };
      }).data?.productCreateMedia?.userErrors) ?? [];
      if (mediaErrors.length) {
        console.warn("[woo-jobs] step 7 productCreateMedia userErrors", mediaErrors);
      } else {
        console.log("[woo-jobs] step 7 done — images imported");
      }
    }

    console.log("[woo-jobs] createShopifyVariableProduct complete", { productGid, matched: matched.length });
    return matched.map((m) => ({
      sku:              m.variation.sku,
      productGid,
      variantGid:       m.variantGid,
      inventoryItemGid: m.inventoryItemGid,
    }));
  } catch (err) {
    console.error("[woo-jobs] createShopifyVariableProduct THREW", { title, err });
    return null;
  }
}

/**
 * Processes all variations of a WooCommerce variable product:
 * - Upserts each variation to Supabase
 * - Creates ONE Shopify product with all variants in a single call
 * - Updates Supabase rows with shopify_product_id + shopify_variant_id
 * Returns count of successfully processed SKUs.
 */
async function processVariableProduct(
  shopId:          string,
  product:         WooVariableProduct,
  variations:      WooVariation[],
  shopifyCtx:      ShopifyCtx | null,
  collectionCache: Map<string, string>,
): Promise<number> {
  console.log("[woo-jobs] processVariableProduct entered", {
    productId:      product.id,
    title:          product.name,
    variationCount: variations.length,
    hasShopifyCtx:  !!shopifyCtx,
  });

  try {
    const vendor        = product.categories?.[0]?.name ?? null;
    let   syncedCount   = 0;
    const variationsForShopify: VariationForShopify[] = [];

    // Phase A: Supabase upsert for each variation
    for (const variation of variations) {
      const skuCode   = variation.sku || `woo-${product.id}-${variation.id}`;
      const attrLabel = variation.attributes.map((a) => `${a.name}: ${a.option}`).join(" / ");
      const title     = attrLabel ? `${product.name} (${attrLabel})` : product.name;
      const price     = variation.regular_price || variation.price || null;

      console.log("[woo-jobs] upserting variation", { skuCode, title, price, stockQty: variation.stock_quantity });

      const { error } = await supabaseAdmin
        .from("skus")
        .upsert(
          {
            shop_id:    shopId,
            sku_code:   skuCode,
            title,
            status:     "active",
            cost_price: price ? parseFloat(price) || null : null,
          },
          { onConflict: "shop_id,sku_code", ignoreDuplicates: false },
        );

      if (error) {
        console.error("[woo-jobs] upsertVariation error", { skuCode, error: error.message });
        continue;
      }

      syncedCount++;
      variationsForShopify.push({ sku: skuCode, title, attrLabel, price, stockQty: variation.stock_quantity });
      console.log("[woo-jobs] variation upserted to Supabase", { sku: skuCode });
    }

    console.log("[woo-jobs] Phase A done", {
      syncedCount,
      variationsForShopifyCount: variationsForShopify.length,
      willCallShopify:           !!shopifyCtx && variationsForShopify.length > 0,
    });

    // Phase B: ONE Shopify product with all variants
    if (shopifyCtx && variationsForShopify.length > 0) {
      console.log("[woo-jobs] calling createShopifyVariableProduct", {
        title:          product.name,
        vendor,
        variantCount:   variationsForShopify.length,
        shopId:         shopifyCtx.shopId,
        locationGid:    shopifyCtx.locationGid,
      });

      const descriptionHtml = product.description || product.short_description || "";
      const results = await createShopifyVariableProduct(
        shopifyCtx, product.name, vendor, descriptionHtml, product.categories, product.images, variationsForShopify, collectionCache,
      );

      console.log("[woo-jobs] createShopifyVariableProduct returned", {
        success:      results !== null,
        resultCount:  results?.length ?? 0,
      });

      if (results) {
        for (const r of results) {
          if (!r.sku) continue;
          await supabaseAdmin
            .from("skus")
            .upsert(
              {
                shop_id:            shopId,
                sku_code:           r.sku,
                shopify_product_id: gidToNumeric(r.productGid),
                shopify_variant_id: gidToNumeric(r.variantGid),
              },
              { onConflict: "shop_id,sku_code", ignoreDuplicates: false },
            );
          console.log("[woo-jobs] shopify product created", { sku: r.sku, shopifyProductId: r.productGid });
        }
      }
    } else if (!shopifyCtx) {
      console.warn("[woo-jobs] Phase B skipped — no shopifyCtx");
    } else {
      console.warn("[woo-jobs] Phase B skipped — no variationsForShopify (all Supabase upserts failed?)");
    }

    console.log("[woo-jobs] processVariableProduct done", { productId: product.id, syncedCount });
    return syncedCount;
  } catch (err) {
    console.error("[woo-jobs] processVariableProduct THREW", { productId: product.id, err });
    throw err;
  }
}

// ── Shopify order creation (REST) ─────────────────────────────────────────────

/**
 * Creates a WooCommerce order in Shopify via the REST API.
 * Uses processed_webhooks for idempotency — skips if already migrated.
 * Never throws; returns the Shopify order id or null on failure/skip.
 */
async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 3): Promise<Response> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch(url, options);
    if (res.status !== 429) return res;
    const retryAfter = Number(res.headers.get("Retry-After") || 60);
    console.log(`[woo-jobs] rate limited, waiting ${retryAfter}s before retry ${attempt + 1}`);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
  }
  throw new Error("Max retries exceeded on 429");
}

async function createShopifyOrder(
  ctx:   ShopifyCtx,
  order: import("./client.server").WooOrder,
): Promise<number | null> {
  const dedupeKey = `woo-${order.id}`;

  // Idempotency check — skip if this WooCommerce order was already migrated
  const { data: existing } = await supabaseAdmin
    .from("processed_webhooks")
    .select("id")
    .eq("source", "woo_order_migration")
    .eq("external_id", dedupeKey)
    .maybeSingle();

  if (existing) {
    console.log("[woo-jobs] shopify order already migrated, skipping", { wooId: order.id });
    return null;
  }

  try {
    const res = await fetchWithRetry(
      `https://${ctx.shopId}/admin/api/2026-04/orders.json`,
      {
        method:  "POST",
        headers: {
          "Content-Type":           "application/json",
          "X-Shopify-Access-Token": ctx.accessToken,
        },
        body: JSON.stringify({
          order: {
            email:              order.billing?.email || "",
            created_at:         order.date_created,
            financial_status:   "paid",
            fulfillment_status: order.status === "completed" ? "fulfilled" : null,
            source_name:        "WooCommerce",
            tags:               "migrado-woocommerce",
            note:               `Migrado desde WooCommerce. ID original: ${order.id}. Método de pago: ${order.payment_method_title || "N/A"}`,
            note_attributes: [
              { name: "woo_order_id",          value: String(order.id) },
              { name: "woo_status",             value: order.status },
              { name: "woo_payment_method",     value: order.payment_method_title || "" },
              // Include any WooCommerce meta_data fields (e.g. tracking numbers)
              ...order.meta_data
                .filter((m) => m.key && !m.key.startsWith("_"))  // skip private fields
                .slice(0, 20)                                      // Shopify limit: 10, keep a safety buffer
                .map((m) => ({ name: `woo_meta_${m.key}`, value: String(m.value).slice(0, 255) })),
            ],
            line_items: order.line_items.map((item) => ({
              title:    item.name,
              quantity: item.quantity,
              price:    item.price,
              sku:      item.sku,
            })),
            billing_address: {
              first_name: order.billing?.first_name,
              last_name:  order.billing?.last_name,
              address1:   order.billing?.address_1,
              city:       order.billing?.city,
              country:    order.billing?.country,
              phone:      order.billing?.phone,
            },
            shipping_lines: order.shipping_lines?.length
              ? order.shipping_lines.map((s) => ({
                  title:      s.method_title,
                  code:       s.method_id,
                  price:      s.total,
                  source:     "WooCommerce",
                }))
              : undefined,
          },
        }),
      },
    );

    if (!res.ok) {
      const body = await res.text();
      console.error("[woo-jobs] shopify order create failed", { wooId: order.id, status: res.status, body });
      return null;
    }

    const shopifyOrder = await res.json() as { order?: { id: number } };
    const shopifyId = shopifyOrder.order?.id ?? null;
    console.log("[woo-jobs] shopify order created", { wooId: order.id, shopifyId });

    // Record in processed_webhooks so re-runs skip it
    await supabaseAdmin
      .from("processed_webhooks")
      .insert({ source: "woo_order_migration", external_id: dedupeKey })
      .select()
      .maybeSingle();  // ignore duplicate key errors on concurrent runs

    return shopifyId ?? null;
  } catch (err) {
    console.error("[woo-jobs] createShopifyOrder error", { wooId: order.id, err });
    return null;
  }
}

// ── Sales history import ──────────────────────────────────────────────────────

async function importOrdersForShop(
  shopId:     string,
  creds:      WooCredentials,
  jobId:      string,
  baseCount:  number,
  preview     = false,
  shopifyCtx: ShopifyCtx | null = null,
): Promise<number> {
  let orderCount = 0;

  for await (const orders of paginateOrders(creds, { preview })) {
    for (const order of orders) {
      // Create order in Shopify (idempotent, best-effort)
      if (shopifyCtx) {
        await createShopifyOrder(shopifyCtx, order);
        // 500ms throttle — dev stores have a ~5 orders/min REST limit
        await new Promise((r) => setTimeout(r, 500));
      }

      // Save each line item to sales_history in Supabase
      for (const item of order.line_items) {
        if (!item.sku) continue;

        const { data: skuRow } = await supabaseAdmin
          .from("skus")
          .select("id")
          .eq("shop_id", shopId)
          .eq("sku_code", item.sku)
          .maybeSingle();

        if (!skuRow) continue;

        const { error } = await supabaseAdmin
          .from("sales_history")
          .upsert(
            {
              shop_id:              shopId,
              sku_id:               skuRow.id,
              quantity_sold:        item.quantity,
              shopify_line_item_id: -item.id,  // negative = WooCommerce source
              sold_at:              order.date_created,
            },
            { onConflict: "sku_id,shopify_line_item_id", ignoreDuplicates: true },
          );

        if (!error) orderCount++;
      }
    }

    await updateJobProgress(jobId, baseCount + orderCount);
  }

  return orderCount;
}

// ── Main processor ────────────────────────────────────────────────────────────

export async function processWooMigration(
  jobId:         string,
  shopId:        string,
  includeOrders: boolean,
  preview        = false,
): Promise<void> {
  try {
    console.log("[woo-jobs] processWooMigration start", { jobId, shopId, preview });

    const [creds, shopifyCtx] = await Promise.all([
      resolveWooCreds(shopId),
      resolveShopifyCtx(shopId),
    ]);

    console.log("[woo-jobs] shopifyCtx resolved", {
      hasCtx:      !!shopifyCtx,
      locationGid: shopifyCtx?.locationGid ?? null,
    });
    if (!shopifyCtx) {
      console.warn("[woo-jobs] no Shopify context — products will be saved to Supabase only");
    }

    let synced = 0;
    // Job-level cache: collection name → Shopify collection numeric ID
    const collectionCache = new Map<string, string>();

    // ── Phase 1: Products ──────────────────────────────────────────────────
    console.log("[woo-jobs] starting paginateProducts", { preview });
    let pageCount = 0;

    for await (const products of paginateProducts(creds, { preview })) {
      pageCount++;
      console.log("[woo-jobs] product page", { page: pageCount, count: products.length });

      for (const product of products) {
        console.log("[woo-jobs] processing woo product", { id: product.id, type: product.type, name: product.name });

        if (product.type === "simple") {
          const ok = await processSimpleProduct(
            shopId,
            product as WooSimpleProduct,
            shopifyCtx,
          );
          if (ok) synced++;
        } else if (product.type === "variable") {
          const varProduct = product as WooVariableProduct;
          console.log("[woo-jobs] fetching variations for variable product", { id: varProduct.id, name: varProduct.name });
          const variations = await getVariations(creds, varProduct.id);
          console.log("[woo-jobs] variations fetched", { count: variations.length });
          console.log("[woo-jobs] calling processVariableProduct", { productId: varProduct.id, variationCount: variations.length, hasShopifyCtx: !!shopifyCtx });
          const count = await processVariableProduct(shopId, varProduct, variations, shopifyCtx, collectionCache);
          synced += count;
        } else {
          console.warn("[woo-jobs] unknown product type, skipping", { id: (product as { id: number }).id, type: (product as { type: string }).type });
        }
      }

      await updateJobProgress(jobId, synced);
      console.log("[woo-jobs] progress updated", { synced });
    }
    console.log("[woo-jobs] paginateProducts done", { synced });

    // ── Phase 2: Orders ───────────────────────────────────────────────────
    // Preview always imports orders (5 max). Full migration only if opted in.
    if (preview || includeOrders) {
      console.log("[woo-jobs] starting importOrdersForShop", { preview, includeOrders });
      const orderRecords = await importOrdersForShop(shopId, creds, jobId, synced, preview, shopifyCtx);
      synced += orderRecords;
      console.log("[woo-jobs] importOrdersForShop done", { orderRecords, synced });
    } else {
      console.log("[woo-jobs] skipping orders (includeOrders=false, preview=false)");
    }

    // ── Finalize ──────────────────────────────────────────────────────────
    console.log("[woo-jobs] refreshing sku_analytics");
    await refreshSkuAnalytics();

    if (preview) {
      console.log("[woo-jobs] marking shop preview done");
      await supabaseAdmin
        .from("shops")
        .update({ woo_migration_preview: true })
        .eq("shop_id", shopId);
    } else {
      console.log("[woo-jobs] stamping migrated_at on woo_connections");
      await supabaseAdmin
        .from("woo_connections")
        .update({ migrated_at: new Date().toISOString() })
        .eq("shop_id", shopId);
    }

    await completeJob(jobId, synced);
    console.log("[woo-jobs] processWooMigration complete", { jobId, synced });
  } catch (err) {
    console.error("[woo-jobs] error", err);
    await failJob(jobId, err).catch((failErr) =>
      console.error("[woo-jobs] failJob also failed", failErr),
    );
  }
}
