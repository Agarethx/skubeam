import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { safeRedirect } from "../lib/server";
import { useSkuBeamNavigate } from "../lib/navigate";
import {
  getSkuById,
  getSkuAnalytics,
  getInventoryLevels,
  updateSku,
  archiveSku,
  unarchiveSku,
  syncSkuFromShopify,
  computeHealthScore,
} from "../models/sku.server";

// ── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { id } = params as { id: string };

  const [sku, analytics, inventoryLevels] = await Promise.all([
    getSkuById(session.shop, id),
    getSkuAnalytics(session.shop, id),
    getInventoryLevels(session.shop, id),
  ]);

  const { score, criteria } = computeHealthScore(sku, analytics);

  return { sku, analytics, inventoryLevels, score, criteria };
};

// ── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const { id } = params as { id: string };
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "update") {
    const skuCode = (formData.get("sku_code") as string).trim();
    const barcode = (formData.get("barcode") as string).trim() || null;
    const barcodeType = (formData.get("barcode_type") as string) || "CODE128";
    const vendor = (formData.get("vendor") as string).trim() || null;
    const costRaw = formData.get("cost_price") as string;
    const costPrice = costRaw ? parseFloat(costRaw) : null;

    if (!skuCode) return { error: "El código SKU es obligatorio." };

    await updateSku(session.shop, id, {
      sku_code: skuCode,
      barcode,
      barcode_type: barcodeType,
      vendor,
      cost_price: costPrice,
    });
    return { success: "SKU actualizado correctamente." };
  }

  if (intent === "archive") {
    await archiveSku(session.shop, id);
    return safeRedirect(request, "/app/skus");
  }

  if (intent === "unarchive") {
    await unarchiveSku(session.shop, id);
    return { success: "SKU reactivado." };
  }

  if (intent === "sync") {
    const sku = await getSkuById(session.shop, id);

    if (!sku.shopify_variant_id) {
      return { error: "Este SKU no tiene un variant ID de Shopify asociado." };
    }

    const gid = `gid://shopify/ProductVariant/${sku.shopify_variant_id}`;
    const response = await admin.graphql(
      `#graphql
      query SkuSyncData($id: ID!) {
        productVariant(id: $id) {
          sku
          barcode
          product {
            title
            vendor
            productType
            tags
          }
          inventoryItem {
            unitCost { amount }
          }
          inventoryLevels(first: 20) {
            edges {
              node {
                location { id name }
                quantities(names: ["available"]) {
                  name
                  quantity
                }
              }
            }
          }
        }
      }`,
      { variables: { id: gid } },
    );

    const json = await response.json();
    const variant = json.data?.productVariant;

    if (!variant) return { error: "No se encontró el variant en Shopify." };

    const levels = (variant.inventoryLevels?.edges ?? []).map(
      (edge: {
        node: {
          location: { id: string; name: string };
          quantities: Array<{ name: string; quantity: number }>;
        };
      }) => {
        const locationNumericId = Number(
          edge.node.location.id.replace("gid://shopify/Location/", ""),
        );
        const available =
          edge.node.quantities.find(
            (q: { name: string; quantity: number }) => q.name === "available",
          )?.quantity ?? 0;
        return {
          shopify_location_id: locationNumericId,
          location_name: edge.node.location.name,
          quantity: available,
        };
      },
    );

    const costRaw = variant.inventoryItem?.unitCost?.amount;

    await syncSkuFromShopify(
      session.shop,
      id,
      {
        sku_code: variant.sku || sku.sku_code,
        barcode: variant.barcode || null,
        vendor: variant.product?.vendor || null,
        product_type: variant.product?.productType || null,
        tags: variant.product?.tags ?? [],
        cost_price: costRaw ? parseFloat(costRaw) : null,
      },
      levels,
    );

    return { success: "SKU sincronizado desde Shopify." };
  }

  return { error: "Acción desconocida." };
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function scoreTone(score: number) {
  if (score >= 80) return "success";
  if (score >= 50) return "caution";
  return "critical";
}

function statusTone(status: string | null) {
  switch (status) {
    case "active":   return "success";
    case "archived": return "neutral";
    case "draft":    return "caution";
    default:         return "neutral";
  }
}

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("es-MX", { dateStyle: "medium" }).format(new Date(iso));
}

// ── UI ───────────────────────────────────────────────────────────────────────

export default function SkuDetail() {
  const { sku, analytics, inventoryLevels, score, criteria } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const skuBeamNavigate = useSkuBeamNavigate();

  const isSaving =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "update";
  const isSyncing =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "sync";

  const successMsg = actionData && "success" in actionData ? actionData.success : null;
  const errorMsg   = actionData && "error"   in actionData ? actionData.error   : null;

  return (
    <s-page heading={sku.sku_code}>
      {/* ── Aside: health score + actions ── */}
      <s-section slot="aside" heading="Health Score">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small">
            <s-badge tone={scoreTone(score)} size="large">
              {score} / 100
            </s-badge>
            <s-badge tone={statusTone(sku.status)}>{sku.status ?? "—"}</s-badge>
          </s-stack>

          {criteria.map((c) => (
            <s-stack key={c.label} direction="inline" gap="small">
              <s-badge tone={c.earned ? "success" : "critical"}>
                {c.earned ? "✓" : "✗"}
              </s-badge>
              <s-text>
                {c.label}
                {!c.earned ? ` (−${c.points} pts)` : ""}
              </s-text>
            </s-stack>
          ))}
        </s-stack>
      </s-section>

      {/* ── Aside: actions ── */}
      <s-section slot="aside" heading="Acciones">
        <s-stack direction="block" gap="base">
          <Form method="post">
            <input type="hidden" name="intent" value="sync" />
            <s-button
              type="submit"
              variant="secondary"
              {...(isSyncing ? { loading: true } : {})}
            >
              Sincronizar con Shopify
            </s-button>
          </Form>

          {sku.status !== "archived" ? (
            <Form method="post">
              <input type="hidden" name="intent" value="archive" />
              <s-button type="submit" tone="critical" variant="secondary">
                Archivar SKU
              </s-button>
            </Form>
          ) : (
            <Form method="post">
              <input type="hidden" name="intent" value="unarchive" />
              <s-button type="submit" variant="secondary">
                Reactivar SKU
              </s-button>
            </Form>
          )}

          <s-button
            variant="tertiary"
            onClick={() => skuBeamNavigate("/app/skus")}
          >
            ← Volver a SKUs
          </s-button>
        </s-stack>
      </s-section>

      {/* ── Main: feedback ── */}
      {successMsg && (
        <s-banner tone="success" heading={successMsg} />
      )}
      {errorMsg && (
        <s-banner tone="critical" heading={errorMsg} />
      )}

      {/* ── Main: editable info ── */}
      <s-section heading="Información del SKU">
        <Form method="post">
          <input type="hidden" name="intent" value="update" />
          <s-stack direction="block" gap="base">
            <s-text-field
              name="sku_code"
              label="Código SKU"
              value={sku.sku_code}
              required
            />
            <s-text-field
              name="barcode"
              label="Barcode"
              value={sku.barcode ?? ""}
              placeholder="EAN-13, CODE128, QR…"
            />
            <s-select name="barcode_type" label="Tipo de barcode" value={sku.barcode_type ?? "CODE128"}>
              <s-option value="CODE128">CODE128</s-option>
              <s-option value="EAN13">EAN-13</s-option>
              <s-option value="QR">QR</s-option>
              <s-option value="UPC">UPC</s-option>
            </s-select>
            <s-text-field
              name="vendor"
              label="Vendor"
              value={sku.vendor ?? ""}
            />
            <s-number-field
              name="cost_price"
              label="Costo (precio)"
              value={sku.cost_price != null ? String(sku.cost_price) : ""}
              min={0}
              step={0.01}
            />
            <s-button
              type="submit"
              {...(isSaving ? { loading: true } : {})}
            >
              Guardar cambios
            </s-button>
          </s-stack>
        </Form>
      </s-section>

      {/* ── Main: ventas ── */}
      <s-section heading="Ventas">
        <s-stack direction="inline" gap="large">
          <s-stack direction="block" gap="small">
            <s-heading>Vendido 30d</s-heading>
            <s-text>{analytics.sold_30d ?? 0} uds.</s-text>
          </s-stack>
          <s-stack direction="block" gap="small">
            <s-heading>Vendido 90d</s-heading>
            <s-text>{analytics.sold_90d ?? 0} uds.</s-text>
          </s-stack>
          <s-stack direction="block" gap="small">
            <s-heading>Última venta</s-heading>
            <s-text>{formatDate(analytics.last_sold_at)}</s-text>
          </s-stack>
        </s-stack>
      </s-section>

      {/* ── Main: stock por location ── */}
      <s-section heading={`Stock por location (total: ${analytics.total_stock ?? 0})`}>
        {inventoryLevels.length === 0 ? (
          <s-paragraph>Sin datos de inventario sincronizados.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header>
              <s-table-header-row>
                <s-table-cell>Location</s-table-cell>
                <s-table-cell>Cantidad disponible</s-table-cell>
                <s-table-cell>Actualizado</s-table-cell>
              </s-table-header-row>
            </s-table-header>
            <s-table-body>
              {inventoryLevels.map((level) => (
                <s-table-row key={level.shopify_location_id}>
                  <s-table-cell>
                    {level.location_name ?? `Location ${level.shopify_location_id}`}
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge
                      tone={level.quantity > 0 ? "success" : "critical"}
                    >
                      {level.quantity}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>{formatDate(level.updated_at)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
