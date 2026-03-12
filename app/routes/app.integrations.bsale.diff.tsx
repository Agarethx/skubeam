import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
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
      .select("id, sku_code, title, cost_price")
      .eq("shop_id", shopId)
      .eq("status", "active")
      .is("shopify_variant_id", null)
      .order("sku_code", { ascending: true })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1),
  ]);

  const newTotal = newCountResult.count ?? 0;

  console.log(`[bsale-diff] new=${newTotal} published=${publishedCountResult.count ?? 0} page=${page}`);

  return {
    counts: {
      new:       newTotal,
      published: publishedCountResult.count ?? 0,
    },
    items:      (pageRowsResult.data ?? []) as Pick<Tables<"skus">, "id" | "sku_code" | "title" | "cost_price">[],
    page,
    totalPages: Math.ceil(newTotal / PAGE_SIZE),
  };
};

// ── Action ────────────────────────────────────────────────────────────────────

const PRODUCT_CREATE = `#graphql
  mutation productCreate($input: ProductInput!) {
    productCreate(input: $input) {
      product {
        id
        variants(first: 1) { edges { node { id } } }
      }
      userErrors { field message }
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

  // Fetch the Supabase rows for the selected IDs in one query
  const { data: rows } = await supabaseAdmin
    .from("skus")
    .select("id, sku_code, title")
    .eq("shop_id", shopId)
    .in("id", selected);

  const rowMap = new Map((rows ?? []).map((r) => [r.id, r]));

  for (const supabaseId of selected) {
    const row = rowMap.get(supabaseId);
    if (!row) continue;

    try {
      const res  = await admin.graphql(PRODUCT_CREATE, {
        variables: {
          input: {
            title:    row.title ?? row.sku_code,
            variants: [{ sku: row.sku_code, price: "0.00" }],
          },
        },
      });
      const json = await res.json() as {
        data?: {
          productCreate?: {
            product?: {
              id: string;
              variants: { edges: Array<{ node: { id: string } }> };
            };
            userErrors: Array<{ field: string; message: string }>;
          };
        };
      };

      const result = json.data?.productCreate;
      if (result?.userErrors?.length) {
        errors.push(`${row.sku_code}: ${result.userErrors[0].message}`);
        failed++;
        continue;
      }

      // Back-fill Shopify IDs into Supabase
      const product = result?.product;
      if (product) {
        const variantGid = product.variants.edges[0]?.node.id ?? "";
        await supabaseAdmin
          .from("skus")
          .update({
            shopify_product_id: Number(product.id.replace("gid://shopify/Product/", "")),
            shopify_variant_id: Number(variantGid.replace("gid://shopify/ProductVariant/", "")),
          })
          .eq("id", supabaseId)
          .eq("shop_id", shopId);
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
            Selecciona qué SKUs de Bsale crear en Shopify. Se crean con precio
            $0 — actualiza el precio en Shopify después de publicar.
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
                      <th style={{ padding: "8px", textAlign: "right" }}>Costo</th>
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
                          {row.cost_price != null
                            ? `$${Number(row.cost_price).toLocaleString("es-CL")}`
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
                    onClick={() => {
                      window.location.href = `?page=${page - 1}`;
                    }}
                  >
                    ← Anterior
                  </s-button>
                )}
                {page < totalPages && (
                  <s-button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      window.location.href = `?page=${page + 1}`;
                    }}
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
