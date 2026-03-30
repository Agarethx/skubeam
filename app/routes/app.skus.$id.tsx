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
import { generateBarcode } from "../lib/barcode.server";
import type { BarcodeType } from "../lib/barcode.server";
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

  console.log("[sku-detail] sale_price:", sku?.sale_price);
  const { score, criteria } = computeHealthScore(sku, analytics);

  const barcodeDataUrl = sku.barcode
    ? await generateBarcode(
        sku.barcode,
        (sku.barcode_type as BarcodeType) ?? "CODE128",
      ).catch(() => null)
    : null;

  return { sku, analytics, inventoryLevels, score, criteria, barcodeDataUrl };
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
    if (!skuCode) return { error: "El código SKU es obligatorio." };

    await updateSku(session.shop, id, {
      sku_code: skuCode,
      barcode,
      barcode_type: barcodeType,
      vendor,
    });
    return { success: "SKU actualizado correctamente." };
  }

  if (intent === "generate_barcode") {
    const code = (formData.get("barcode_code") as string | null)?.trim();
    const type = ((formData.get("barcode_type") as string) || "CODE128") as BarcodeType;

    if (!code) return { error: "Ingresa un código para generar el barcode." };

    let barcodeDataUrl: string;
    try {
      barcodeDataUrl = await generateBarcode(code, type);
    } catch {
      return { error: `No se pudo generar el barcode: código inválido para ${type}.` };
    }

    // Persist so health score reflects the new barcode immediately
    await updateSku(session.shop, id, { barcode: code, barcode_type: type });

    return { success: "Barcode generado y guardado.", barcodeDataUrl };
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
            inventoryLevels(first: 10) {
              edges {
                node {
                  quantities(names: ["available"]) {
                    name
                    quantity
                  }
                  location { id name }
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

    const levels = (variant.inventoryItem?.inventoryLevels?.edges ?? []).map(
      (edge: {
        node: {
          quantities: Array<{ name: string; quantity: number }>;
          location: { id: string; name: string };
        };
      }) => ({
        shopify_location_id: Number(
          edge.node.location.id.replace("gid://shopify/Location/", ""),
        ),
        location_name: edge.node.location.name,
        quantity: edge.node.quantities.find((q) => q.name === "available")?.quantity ?? 0,
      }),
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
  const { sku, analytics, inventoryLevels, score, criteria, barcodeDataUrl } =
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
  const isGenerating =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "generate_barcode";

  const successMsg = actionData && "success" in actionData ? actionData.success : null;
  const errorMsg   = actionData && "error"   in actionData ? actionData.error   : null;

  // Prefer freshly-generated image (action), fall back to loader's render
  const effectiveBarcodeUrl =
    (actionData && "barcodeDataUrl" in actionData ? actionData.barcodeDataUrl : null)
    ?? barcodeDataUrl;

  return (
    <s-page heading={sku.sku_code}>
      {/* ── Aside: health score ── */}
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
      {successMsg && <s-banner tone="success" heading={successMsg} />}
      {errorMsg   && <s-banner tone="critical" heading={errorMsg} />}

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
              <s-option value="EAN8">EAN-8</s-option>
              <s-option value="QR">QR</s-option>
            </s-select>
            <s-text-field
              name="vendor"
              label="Vendor"
              value={sku.vendor ?? ""}
            />
            <s-text-field
              label="Precio de venta (Bsale)"
              value={sku.sale_price ? `${Number(sku.sale_price).toLocaleString("es-CL")}` : ""}
              readOnly
              help-text="El precio se sincroniza desde la lista de precios de Bsale"
            />
            <s-button type="submit" {...(isSaving ? { loading: true } : {})}>
              Guardar cambios
            </s-button>
          </s-stack>
        </Form>
      </s-section>

      {/* ── Main: barcode ── */}
      <s-section heading="Barcode">
        {effectiveBarcodeUrl ? (
          <s-stack direction="block" gap="base">
            <img
              src={effectiveBarcodeUrl}
              alt={`Barcode ${sku.barcode}`}
              style={{ maxWidth: "320px", display: "block", background: "#fff", padding: "12px" }}
            />
            <s-text>{sku.barcode} · {sku.barcode_type ?? "CODE128"}</s-text>
            <s-button
              variant="secondary"
              onClick={() => {
                const win = window.open("", "_blank");
                if (win) {
                  win.document.write(
                    `<img src="${effectiveBarcodeUrl}" style="max-width:100%;padding:24px" />`,
                  );
                  win.document.title = `Barcode ${sku.barcode}`;
                  win.print();
                }
              }}
            >
              Imprimir
            </s-button>
          </s-stack>
        ) : (
          <Form method="post">
            <input type="hidden" name="intent" value="generate_barcode" />
            <s-stack direction="block" gap="base">
              <s-text-field
                name="barcode_code"
                label="Código del barcode"
                value={sku.sku_code}
                placeholder="Ej. 5901234123457"
                help-text="Ingresa el código que quieres codificar"
              />
              <s-select name="barcode_type" label="Formato" value="CODE128">
                <s-option value="CODE128">CODE128 (uso general)</s-option>
                <s-option value="EAN13">EAN-13 (retail, 13 dígitos)</s-option>
                <s-option value="EAN8">EAN-8 (retail compacto, 8 dígitos)</s-option>
                <s-option value="QR">QR Code</s-option>
              </s-select>
              <s-button
                type="submit"
                {...(isGenerating ? { loading: true } : {})}
              >
                Generar barcode
              </s-button>
            </s-stack>
          </Form>
        )}
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
                    <s-badge tone={level.quantity > 0 ? "success" : "critical"}>
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
