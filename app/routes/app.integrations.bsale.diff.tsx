import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation, useNavigate, useLocation } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useState } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../db.server";
import type { Tables } from "../types/supabase";

const PAGE_SIZE = 250;

// ── Loader ────────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  console.log("[bsale-diff] loader called");

  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  const url  = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));

  const [newCountResult, publishedCountResult, pageRowsResult] = await Promise.all([
    // Fast count: SKUs not yet in Shopify
    supabaseAdmin
      .from("skus")
      .select("*", { count: "exact", head: true })
      .eq("shop_id", shopId)
      .eq("status", "active")
      .is("shopify_variant_id", null),

    // Fast count: SKUs already published
    supabaseAdmin
      .from("skus")
      .select("*", { count: "exact", head: true })
      .eq("shop_id", shopId)
      .eq("status", "active")
      .not("shopify_variant_id", "is", null),

    // Paginated "new" SKUs for the table
    supabaseAdmin
      .from("skus")
      .select("id, sku_code, title, cost_price, sale_price, barcode")
      .eq("shop_id", shopId)
      .eq("status", "active")
      .is("shopify_variant_id", null)
      .order("sku_code", { ascending: true })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1),
  ]);

  const newTotal = newCountResult.count ?? 0;

  console.log(`[bsale-diff] new=${newTotal} published=${publishedCountResult.count ?? 0} page=${page}`);

  if ((pageRowsResult.data ?? []).length > 0) {
    console.log("[bsale-diff] first sku sample:", JSON.stringify(pageRowsResult.data![0], null, 2));
  }

  return {
    counts: {
      new:       newTotal,
      published: publishedCountResult.count ?? 0,
    },
    items:      (pageRowsResult.data ?? []) as Pick<Tables<"skus">, "id" | "sku_code" | "title" | "cost_price" | "sale_price" | "barcode">[],
    page,
    totalPages: Math.ceil(newTotal / PAGE_SIZE),
  };
};

// ── Action ────────────────────────────────────────────────────────────────────

// Step 1 — create the base product (no variants field in 2026-04+)
const PRODUCT_CREATE = `#graphql
  mutation ProductCreate($input: ProductInput!) {
    productCreate(input: $input) {
      product {
        id
        variants(first: 1) { edges { node { id inventoryItem { id } } } }
      }
      userErrors { field message }
    }
  }`;

// Step 2 — update the default (or existing) variant with SKU, price and cost
const VARIANTS_BULK_UPDATE = `#graphql
  mutation ProductVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id }
      userErrors { field message }
    }
  }`;

// Step 3 — enable inventory tracking on the inventory item
const INVENTORY_ITEM_UPDATE = `#graphql
  mutation InventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
    inventoryItemUpdate(id: $id, input: $input) {
      inventoryItem { id tracked }
      userErrors { field message }
    }
  }`;

// Step 4 — set initial stock from Bsale (delta from 0 = total_stock)
const INVENTORY_ADJUST_QUANTITIES = `#graphql
  mutation InventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
    inventoryAdjustQuantities(input: $input) {
      userErrors { field message }
    }
  }`;

// Pre-flight — first active location for the shop
const GET_FIRST_LOCATION = `#graphql
  query GetFirstLocation {
    locations(first: 1, includeLegacy: false) {
      edges { node { id } }
    }
  }`;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shopId   = session.shop;
  const formData = await request.formData();

  const selected = formData.getAll("selected") as string[];
  if (selected.length === 0) return { published: 0, failed: 0, errors: [] as string[] };

  let published = 0;
  let failed    = 0;
  const errors: string[] = [];

  // Fetch rows — include shopify IDs so we can distinguish new vs. changed
  const { data: rows } = await supabaseAdmin
    .from("skus")
    .select("id, sku_code, title, cost_price, sale_price, barcode, shopify_variant_id, shopify_product_id")
    .eq("shop_id", shopId)
    .in("id", selected);

  const rowMap = new Map((rows ?? []).map((r) => [r.id, r]));

  // Log raw DB values to trace price/stock origin
  for (const r of rows ?? []) {
    console.log(`[bsale-publish] DB row for ${r.sku_code}: sale_price=${r.sale_price} cost_price=${r.cost_price}`);
  }

  // Pre-fetch location + stock totals once — used for all new products in this batch
  const skuCodes = (rows ?? []).map((r) => r.sku_code);

  const [locRes, stockRes] = await Promise.all([
    admin.graphql(GET_FIRST_LOCATION),
    supabaseAdmin
      .from("sku_analytics")
      .select("sku_code, total_stock")
      .eq("shop_id", shopId)
      .in("sku_code", skuCodes),
  ]);

  const locJson = await locRes.json() as {
    data?: { locations?: { edges: Array<{ node: { id: string } }> } };
  };
  const locationId = locJson.data?.locations?.edges[0]?.node.id ?? null;

  const stockMap = new Map<string, number>(
    (stockRes.data ?? []).map((r) => [r.sku_code, r.total_stock ?? 0]),
  );

  // Log sku_analytics stock values
  console.log("[bsale-publish] sku_analytics stock map:", JSON.stringify(Object.fromEntries(stockMap)));

  for (const supabaseId of selected) {
    const row = rowMap.get(supabaseId);
    if (!row) continue;

    const cost       = row.cost_price != null ? String(row.cost_price) : "0";
    const price      = row.sale_price != null ? String(row.sale_price) : "0.00";
    const totalStock = stockMap.get(row.sku_code) ?? 0;

    console.log(`[bsale-publish] sku: ${row.sku_code}`);
    console.log(`[bsale-publish] sale_price from DB: ${row.sale_price}`);
    console.log(`[bsale-publish] price being sent to Shopify: ${price}`);
    console.log(`[bsale-publish] stock being sent: ${totalStock}`);

    try {
      let productGid: string;
      let variantGid: string;
      let inventoryItemGid: string | null = null;
      const isNewProduct = row.shopify_variant_id == null;

      if (isNewProduct) {
        // ── New product: two-step flow ────────────────────────────────────────

        // Step 1: create the base product (title only — no variants input)
        const createRes = await admin.graphql(PRODUCT_CREATE, {
          variables: {
            input: { title: row.title ?? row.sku_code },
          },
        });
        const createJson = await createRes.json() as {
          data?: {
            productCreate?: {
              product?: {
                id: string;
                variants: { edges: Array<{ node: { id: string; inventoryItem?: { id: string } } }> };
              };
              userErrors: Array<{ field: string; message: string }>;
            };
          };
        };

        const createResult = createJson.data?.productCreate;
        if (createResult?.userErrors?.length) {
          errors.push(`${row.sku_code}: ${createResult.userErrors[0].message}`);
          failed++;
          continue;
        }

        const product = createResult?.product;
        if (!product) {
          errors.push(`${row.sku_code}: productCreate no retornó producto`);
          failed++;
          continue;
        }

        productGid        = product.id;
        const defaultVariant = product.variants.edges[0]?.node;
        variantGid        = defaultVariant?.id ?? "";
        inventoryItemGid  = defaultVariant?.inventoryItem?.id ?? null;

        if (!variantGid) {
          errors.push(`${row.sku_code}: no se encontró la variante default`);
          failed++;
          continue;
        }
      } else {
        // ── Changed product: update only ──────────────────────────────────────
        productGid = `gid://shopify/Product/${row.shopify_product_id}`;
        variantGid = `gid://shopify/ProductVariant/${row.shopify_variant_id}`;
      }

      // Step 2: set SKU (via inventoryItem.sku), price and cost on the variant
      // In API 2026-04, `sku` moved from ProductVariantsBulkInput → InventoryItemInput
      const updateRes = await admin.graphql(VARIANTS_BULK_UPDATE, {
        variables: {
          productId: productGid,
          variants: [{
            id:            variantGid,
            price,
            ...(row.barcode ? { barcode: row.barcode } : {}),
            inventoryItem: { sku: row.sku_code, cost },
          }],
        },
      });
      const updateJson = await updateRes.json() as {
        data?: {
          productVariantsBulkUpdate?: {
            userErrors: Array<{ field: string; message: string }>;
          };
        };
      };

      const updateErrors = updateJson.data?.productVariantsBulkUpdate?.userErrors ?? [];
      if (updateErrors.length) {
        errors.push(`${row.sku_code}: ${updateErrors[0].message}`);
        failed++;
        continue;
      }

      // Back-fill Shopify IDs into Supabase (only needed for new products)
      if (isNewProduct) {
        await supabaseAdmin
          .from("skus")
          .update({
            shopify_product_id: Number(productGid.replace("gid://shopify/Product/", "")),
            shopify_variant_id: Number(variantGid.replace("gid://shopify/ProductVariant/", "")),
          })
          .eq("id", supabaseId)
          .eq("shop_id", shopId);
      }

      // Steps 3 + 4: activate inventory tracking and set initial stock
      // Only for new products — existing products already have tracked inventory
      if (isNewProduct && inventoryItemGid && locationId) {

        // Step 3: enable tracked = true on the inventory item
        const trackRes = await admin.graphql(INVENTORY_ITEM_UPDATE, {
          variables: { id: inventoryItemGid, input: { tracked: true } },
        });
        const trackJson = await trackRes.json() as {
          data?: { inventoryItemUpdate?: { userErrors: Array<{ field: string; message: string }> } };
        };
        const trackErrors = trackJson.data?.inventoryItemUpdate?.userErrors ?? [];
        if (trackErrors.length) {
          console.warn(`[diff] inventoryItemUpdate errors for ${row.sku_code}:`, trackErrors);
        }

        // Step 4: set initial stock (delta from 0 = total_stock from sku_analytics)
        if (totalStock > 0) {
          const stockRes2 = await admin.graphql(INVENTORY_ADJUST_QUANTITIES, {
            variables: {
              input: {
                reason:  "correction",
                name:    "available",
                changes: [{ inventoryItemId: inventoryItemGid, locationId, delta: totalStock }],
              },
            },
          });
          const stockJson = await stockRes2.json() as {
            data?: { inventoryAdjustQuantities?: { userErrors: Array<{ field: string; message: string }> } };
          };
          const stockErrors = stockJson.data?.inventoryAdjustQuantities?.userErrors ?? [];
          if (stockErrors.length) {
            console.warn(`[diff] inventoryAdjustQuantities errors for ${row.sku_code}:`, stockErrors);
          }
        }
      }

      published++;
    } catch (err) {
      errors.push(`${row.sku_code}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  return { published, failed, errors };
};

// ── UI ────────────────────────────────────────────────────────────────────────

export default function BsaleDiffPage() {
  const { counts, items, page, totalPages } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();

  const isSubmitting = navigation.state === "submitting";
  const isLoading    = navigation.state === "loading";

  const rrNavigate = useNavigate();
  const location   = useLocation();
  const shopify    = useAppBridge();

  function goToPage(p: number) {
    const params = new URLSearchParams(location.search);
    params.set("page", String(p));
    shopify.loading(true);
    rrNavigate(`?${params.toString()}`);
  }

  const [selected, setSelected] = useState<Set<string>>(new Set());

  const allSelected = items.length > 0 && items.every((r) => selected.has(r.id));

  function toggleAll() {
    if (allSelected) {
      setSelected((prev) => {
        const next = new Set(prev);
        items.forEach((r) => next.delete(r.id));
        return next;
      });
    } else {
      setSelected((prev) => new Set([...prev, ...items.map((r) => r.id)]));
    }
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectedCount = items.filter((r) => selected.has(r.id)).length;

  if (isLoading) {
    return (
      <s-page heading="Publicar en Shopify">
        <s-section heading="Cargando…">
          <s-stack direction="inline" gap="small">
            <s-spinner />
            <s-text>Consultando SKUs sin publicar…</s-text>
          </s-stack>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Publicar en Shopify">
      {/* ── Aside ── */}
      <s-section slot="aside" heading="Resumen">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small">
            <s-badge tone="success">{counts.new} sin publicar</s-badge>
            <s-badge tone="neutral">{counts.published} publicados</s-badge>
          </s-stack>
          <s-text>
            Selecciona qué SKUs de Bsale crear en Shopify. Se publicarán con
            el precio de venta de Bsale (con IVA). Si un SKU no tiene precio
            en Bsale, se creará con precio $0.
          </s-text>
          {totalPages > 1 && (
            <s-text>
              Página {page} de {totalPages} ({counts.new} SKUs sin publicar en total)
            </s-text>
          )}
        </s-stack>
      </s-section>

      {/* ── Feedback ── */}
      {actionData && "published" in actionData && actionData.published > 0 && (
        <s-banner
          tone="success"
          heading={`${actionData.published} SKU${actionData.published !== 1 ? "s" : ""} publicado${actionData.published !== 1 ? "s" : ""} correctamente en Shopify.`}
        />
      )}
      {actionData && "failed" in actionData && actionData.failed > 0 && (
        <s-banner tone="critical" heading={`${actionData.failed} SKU${actionData.failed !== 1 ? "s" : ""} fallaron al publicarse.`}>
          <s-stack direction="block" gap="small">
            {actionData.errors.slice(0, 5).map((e, i) => (
              <s-text key={i}>{e}</s-text>
            ))}
          </s-stack>
        </s-banner>
      )}

      {/* ── Table ── */}
      <s-section heading={`SKUs sin publicar${totalPages > 1 ? ` — página ${page}/${totalPages}` : ""}`}>
        {counts.new === 0 ? (
          <s-banner tone="success" heading="Todos los SKUs de Bsale ya están publicados en Shopify." />
        ) : (
          <s-stack direction="block" gap="base">
            <Form method="post">
              {/* Selected IDs as hidden inputs */}
              {[...selected].map((id) => (
                <input key={id} type="hidden" name="selected" value={id} />
              ))}

              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid var(--p-color-border)" }}>
                      <th style={{ padding: "8px", textAlign: "left", width: "36px" }}>
                        <input
                          type="checkbox"
                          checked={allSelected}
                          onChange={toggleAll}
                          style={{ cursor: "pointer" }}
                        />
                      </th>
                      <th style={{ padding: "8px", textAlign: "left" }}>SKU</th>
                      <th style={{ padding: "8px", textAlign: "left" }}>Título (Bsale)</th>
                      <th style={{ padding: "8px", textAlign: "right" }}>Precio (Bsale)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((row) => (
                      <tr
                        key={row.id}
                        style={{ borderBottom: "1px solid var(--p-color-border-subdued)" }}
                      >
                        <td style={{ padding: "8px" }}>
                          <input
                            type="checkbox"
                            checked={selected.has(row.id)}
                            onChange={() => toggleOne(row.id)}
                            style={{ cursor: "pointer" }}
                          />
                        </td>
                        <td style={{ padding: "8px", fontFamily: "monospace" }}>
                          {row.sku_code}
                        </td>
                        <td style={{ padding: "8px" }}>
                          {row.title ?? <em style={{ color: "var(--p-color-text-subdued)" }}>Sin título</em>}
                        </td>
                        <td style={{ padding: "8px", textAlign: "right" }}>
                          {row.sale_price != null
                            ? `$${Number(row.sale_price).toLocaleString("es-CL")}`
                            : <em style={{ color: "var(--p-color-text-subdued)" }}>—</em>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Submit + pagination */}
              <div style={{ marginTop: "16px", display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
                <s-button
                  type="submit"
                  variant="primary"
                  {...(isSubmitting || selectedCount === 0 ? { disabled: true } : {})}
                  {...(isSubmitting ? { loading: true } : {})}
                >
                  {isSubmitting
                    ? "Publicando…"
                    : `Publicar ${selectedCount > 0 ? selectedCount : ""} seleccionado${selectedCount !== 1 ? "s" : ""} en Shopify`}
                </s-button>
                <s-text>{selectedCount} de {items.length} seleccionados en esta página</s-text>
              </div>
            </Form>

            {/* Pagination */}
            {totalPages > 1 && (
              <s-stack direction="inline" gap="small">
                {page > 1 && (
                  <s-button
                    type="button"
                    variant="secondary"
                    onClick={() => goToPage(page - 1)}
                  >
                    ← Anterior
                  </s-button>
                )}
                {page < totalPages && (
                  <s-button
                    type="button"
                    variant="secondary"
                    onClick={() => goToPage(page + 1)}
                  >
                    Siguiente →
                  </s-button>
                )}
              </s-stack>
            )}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
