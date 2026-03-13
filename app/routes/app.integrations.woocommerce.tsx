import type { ActionFunctionArgs, HeadersFunction } from "react-router";
import { useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { useSkuBeamNavigate } from "../lib/navigate";

// ── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);

  const formData = await request.formData();
  const storeUrl = (formData.get("store_url") as string ?? "").trim().replace(/\/$/, "");
  const key      = (formData.get("consumer_key") as string ?? "").trim();
  const secret   = (formData.get("consumer_secret") as string ?? "").trim();

  if (!storeUrl || !key || !secret) {
    return { error: "Completa todos los campos antes de analizar." };
  }

  const credentials = Buffer.from(`${key}:${secret}`).toString("base64");
  const headers     = { Authorization: `Basic ${credentials}` };

  try {
    const [productsRes, ordersRes] = await Promise.all([
      fetch(`${storeUrl}/wp-json/wc/v3/products?per_page=1`, { headers }),
      fetch(`${storeUrl}/wp-json/wc/v3/orders?per_page=1`,   { headers }),
    ]);

    if (!productsRes.ok) {
      return {
        error: `No se pudo conectar con la tienda (${productsRes.status}). Verifica la URL y las credenciales.`,
      };
    }

    const productCount = parseInt(productsRes.headers.get("X-WP-Total") ?? "0", 10);
    const orderCount   = ordersRes.ok
      ? parseInt(ordersRes.headers.get("X-WP-Total") ?? "0", 10)
      : 0;

    return { productCount, orderCount };
  } catch {
    return { error: "No se pudo alcanzar la tienda. Verifica que la URL sea correcta y que la REST API de WooCommerce esté habilitada." };
  }
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function pricingTier(count: number): { name: string; price: string; color: string } {
  if (count < 200)  return { name: "Gratis",  price: "$0",       color: "#008060" };
  if (count <= 1000) return { name: "Starter", price: "$49 USD",  color: "#E3911C" };
  return               { name: "Pro",     price: "$99 USD",  color: "#DC2626" };
}

const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  fontSize: "var(--p-font-size-350, 0.875rem)",
  border: "1px solid var(--p-color-border, #e1e3e5)",
  borderRadius: "var(--p-border-radius-200, 8px)",
  background: "var(--p-color-bg-surface, #fff)",
  color: "var(--p-color-text, inherit)",
  boxSizing: "border-box",
};

const LABEL_STYLE: React.CSSProperties = {
  fontSize: "var(--p-font-size-300, 0.75rem)",
  fontWeight: 600,
  color: "var(--p-color-text-subdued, #6d7175)",
  display: "block",
  marginBottom: "6px",
};

// ── Step indicator ────────────────────────────────────────────────────────────

function Step({ n, label, active }: { n: number; label: string; active?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
      <div
        style={{
          width: "28px",
          height: "28px",
          borderRadius: "50%",
          background: active ? "var(--p-color-bg-fill-brand, #008060)" : "var(--p-color-bg-surface-secondary, #f6f6f7)",
          border: `1px solid ${active ? "transparent" : "var(--p-color-border, #e1e3e5)"}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "var(--p-font-size-300, 0.75rem)",
          fontWeight: 700,
          color: active ? "#fff" : "var(--p-color-text-subdued, #6d7175)",
          flexShrink: 0,
        }}
      >
        {n}
      </div>
      <span
        style={{
          fontSize: "var(--p-font-size-350, 0.875rem)",
          fontWeight: active ? 600 : 400,
          color: active ? "var(--p-color-text, inherit)" : "var(--p-color-text-subdued, #6d7175)",
        }}
      >
        {label}
      </span>
    </div>
  );
}

// ── Pricing card ──────────────────────────────────────────────────────────────

function PricingCard({
  label,
  price,
  detail,
  highlight,
}: {
  label: string;
  price: string;
  detail: string;
  highlight?: boolean;
}) {
  return (
    <div
      style={{
        border: `2px solid ${highlight ? "var(--p-color-border-brand, #008060)" : "var(--p-color-border, #e1e3e5)"}`,
        borderRadius: "var(--p-border-radius-200, 8px)",
        padding: "16px",
        background: highlight ? "var(--p-color-bg-surface-brand, #f0faf7)" : "var(--p-color-bg-surface, #fff)",
      }}
    >
      <s-stack direction="block" gap="small">
        <s-text color="subdued">{label}</s-text>
        <p
          style={{
            margin: 0,
            fontSize: "var(--p-font-size-600, 1.25rem)",
            fontWeight: "var(--p-font-weight-bold, 700)" as React.CSSProperties["fontWeight"],
            color: highlight ? "var(--p-color-text-brand, #008060)" : "var(--p-color-text, inherit)",
          }}
        >
          {price}
        </p>
        <s-text color="subdued">{detail}</s-text>
        {highlight && <s-badge tone="success">Plan recomendado</s-badge>}
      </s-stack>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function WooCommercePage() {
  const navigate = useSkuBeamNavigate();
  const fetcher  = useFetcher<{
    productCount?: number;
    orderCount?: number;
    error?: string;
  }>();

  const isAnalyzing = fetcher.state !== "idle";
  const result      = fetcher.data;
  const hasResult   = result && "productCount" in result;
  const tier        = hasResult ? pricingTier(result.productCount!) : null;

  return (
    <s-page heading="WooCommerce — Migración de datos">

      {/* Back */}
      <s-section>
        <s-button variant="tertiary" onClick={() => navigate("/app/integrations")}>
          ← Volver a Integraciones
        </s-button>
      </s-section>

      {/* ── Steps overview ── */}
      <s-section heading="Cómo funciona">
        <s-stack direction="block" gap="base">
          <Step n={1} label="Instala el plugin WooCommerce REST API en tu WordPress y habilita las claves de acceso" />
          <Step n={2} label='En WordPress → WooCommerce → Ajustes → Avanzado → REST API, crea una clave con permisos de "Lectura"' />
          <Step n={3} label="Pega la URL de tu tienda y las credenciales abajo, luego haz clic en Analizar tienda" active />
        </s-stack>
      </s-section>

      {/* ── Form ── */}
      <s-section heading="Conectar tienda WooCommerce">
        <fetcher.Form method="post">
          <s-stack direction="block" gap="base">
            {result?.error && (
              <s-banner tone="critical" heading={result.error} />
            )}

            <div style={{ maxWidth: "520px" }}>
              <s-stack direction="block" gap="small">
                <label style={{ display: "block" }}>
                  <span style={LABEL_STYLE}>URL de la tienda</span>
                  <input
                    type="url"
                    name="store_url"
                    placeholder="https://mi-tienda.com"
                    required
                    style={INPUT_STYLE}
                  />
                </label>
                <label style={{ display: "block" }}>
                  <span style={LABEL_STYLE}>Consumer Key</span>
                  <input
                    type="text"
                    name="consumer_key"
                    placeholder="ck_xxxxxxxxxxxxxxxxxxxxxxxx"
                    required
                    style={{ ...INPUT_STYLE, fontFamily: "monospace" }}
                  />
                </label>
                <label style={{ display: "block" }}>
                  <span style={LABEL_STYLE}>Consumer Secret</span>
                  <input
                    type="password"
                    name="consumer_secret"
                    placeholder="cs_xxxxxxxxxxxxxxxxxxxxxxxx"
                    required
                    style={{ ...INPUT_STYLE, fontFamily: "monospace" }}
                  />
                </label>
              </s-stack>
            </div>

            <s-button
              type="submit"
              variant="primary"
              {...(isAnalyzing ? { loading: true } : {})}
            >
              Analizar tienda
            </s-button>
          </s-stack>
        </fetcher.Form>
      </s-section>

      {/* ── Analysis result ── */}
      {hasResult && (
        <s-section heading="Resultado del análisis">
          <s-stack direction="block" gap="base">
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <s-box padding="large" borderWidth="small" borderRadius="base" background="base">
                <s-stack direction="block" gap="small">
                  <s-text color="subdued">Productos encontrados</s-text>
                  <p
                    style={{
                      margin: 0,
                      fontSize: "var(--p-font-size-750, 1.75rem)",
                      fontWeight: "var(--p-font-weight-bold, 700)" as React.CSSProperties["fontWeight"],
                      color: "var(--p-color-text, inherit)",
                    }}
                  >
                    {result.productCount!.toLocaleString("es-CL")}
                  </p>
                  <s-text color="subdued">incluye todas las variantes</s-text>
                </s-stack>
              </s-box>
              <s-box padding="large" borderWidth="small" borderRadius="base" background="base">
                <s-stack direction="block" gap="small">
                  <s-text color="subdued">Órdenes disponibles</s-text>
                  <p
                    style={{
                      margin: 0,
                      fontSize: "var(--p-font-size-750, 1.75rem)",
                      fontWeight: "var(--p-font-weight-bold, 700)" as React.CSSProperties["fontWeight"],
                      color: "var(--p-color-text, inherit)",
                    }}
                  >
                    {result.orderCount!.toLocaleString("es-CL")}
                  </p>
                  <s-text color="subdued">historial para forecast</s-text>
                </s-stack>
              </s-box>
            </s-grid>

            {tier && (
              <s-banner
                tone="info"
                heading={`Plan recomendado: ${tier.name} — ${tier.price}`}
              >
                <s-paragraph>
                  Basado en {result.productCount!.toLocaleString("es-CL")} productos encontrados en tu tienda.
                </s-paragraph>
              </s-banner>
            )}

            <s-button variant="primary" {...({ disabled: true } as object)}>
              Iniciar migración — Próximamente
            </s-button>
          </s-stack>
        </s-section>
      )}

      {/* ── Qué se migrará ── */}
      <s-section heading="Qué se migrará">
        <s-stack direction="block" gap="small">
          {[
            { label: "Productos y variantes",          detail: "SKU, título, descripción, imágenes, atributos" },
            { label: "Stock actual por variante",      detail: "Niveles de inventario en todas las ubicaciones" },
            { label: "Historial de órdenes (+$149)",   detail: "Últimos 12 meses — necesario para calcular velocity y forecast" },
          ].map((item, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                gap: "12px",
                padding: "12px 0",
                borderBottom: i < 2 ? "1px solid var(--p-color-border-subdued, #e1e3e5)" : "none",
              }}
            >
              <div
                style={{
                  width: "8px",
                  height: "8px",
                  borderRadius: "50%",
                  background: "var(--p-color-bg-fill-success, #008060)",
                  flexShrink: 0,
                  marginTop: "6px",
                }}
              />
              <div>
                <p style={{ margin: 0, fontWeight: 600, fontSize: "var(--p-font-size-350, 0.875rem)" }}>
                  {item.label}
                </p>
                <p style={{ margin: 0, fontSize: "var(--p-font-size-300, 0.75rem)", color: "var(--p-color-text-subdued, #6d7175)" }}>
                  {item.detail}
                </p>
              </div>
            </div>
          ))}
        </s-stack>
      </s-section>

      {/* ── Pricing ── */}
      <s-section heading="Precios de migración">
        <s-stack direction="block" gap="base">
          <s-grid gridTemplateColumns="repeat(3, 1fr)" gap="base">
            <PricingCard
              label="Hasta 200 productos"
              price="Gratis"
              detail="Productos + stock actual"
              highlight={!!tier && tier.name === "Gratis"}
            />
            <PricingCard
              label="200 – 1.000 productos"
              price="$49 USD"
              detail="Productos + stock actual"
              highlight={!!tier && tier.name === "Starter"}
            />
            <PricingCard
              label="Más de 1.000 productos"
              price="$99 USD"
              detail="Productos + stock actual"
              highlight={!!tier && tier.name === "Pro"}
            />
          </s-grid>
          <s-box padding="base" borderWidth="small" borderRadius="base" background="base">
            <s-stack direction="inline" gap="base" alignItems="center">
              <div>
                <p style={{ margin: 0, fontWeight: 600, fontSize: "var(--p-font-size-350, 0.875rem)" }}>
                  + Historial de órdenes
                </p>
                <s-text color="subdued">
                  Importa los últimos 12 meses de ventas para calcular velocidad de venta,
                  reorder points y forecast automáticamente
                </s-text>
              </div>
              <p
                style={{
                  margin: 0,
                  fontSize: "var(--p-font-size-600, 1.25rem)",
                  fontWeight: "var(--p-font-weight-bold, 700)" as React.CSSProperties["fontWeight"],
                  color: "var(--p-color-text, inherit)",
                  whiteSpace: "nowrap",
                }}
              >
                +$149 USD
              </p>
            </s-stack>
          </s-box>
        </s-stack>
      </s-section>

    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
