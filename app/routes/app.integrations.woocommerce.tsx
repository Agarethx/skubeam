import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useEffect, useRef, useState } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../db.server";
import { useSkuBeamNavigate } from "../lib/navigate";

// ── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  const { data: conn } = await supabaseAdmin
    .from("woo_connections")
    .select("url, product_count, order_count, analyzed_at, migrated_at")
    .eq("shop_id", shopId)
    .maybeSingle();

  // Check for an active migration job
  const { data: activeJob } = await supabaseAdmin
    .from("sync_jobs")
    .select("id, status, records_processed, started_at")
    .eq("shop_id", shopId)
    .eq("type", "woo_migration")
    .in("status", ["pending", "running"])
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return { conn, activeJob };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function pricingTier(count: number): { name: string; price: string } {
  if (count < 200)   return { name: "Gratis",  price: "$0" };
  if (count <= 1000) return { name: "Starter", price: "$49 USD" };
  return               { name: "Pro",     price: "$99 USD" };
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

// ── Step indicator ─────────────────────────────────────────────────────────

function Step({ n, label, active, done }: { n: number; label: string; active?: boolean; done?: boolean }) {
  const bg = done ? "#008060" : active ? "var(--p-color-bg-fill-brand, #008060)" : "var(--p-color-bg-surface-secondary, #f6f6f7)";
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: "12px" }}>
      <div
        style={{
          width: "28px", height: "28px", borderRadius: "50%",
          background: bg,
          border: `1px solid ${active || done ? "transparent" : "var(--p-color-border, #e1e3e5)"}`,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: "var(--p-font-size-300, 0.75rem)", fontWeight: 700,
          color: active || done ? "#fff" : "var(--p-color-text-subdued, #6d7175)",
          flexShrink: 0,
        }}
      >
        {done ? "✓" : n}
      </div>
      <span
        style={{
          fontSize: "var(--p-font-size-350, 0.875rem)",
          fontWeight: active ? 600 : 400,
          color: active ? "var(--p-color-text, inherit)" : "var(--p-color-text-subdued, #6d7175)",
          paddingTop: "4px",
        }}
      >
        {label}
      </span>
    </div>
  );
}

// ── Pricing card ──────────────────────────────────────────────────────────

function PricingCard({ label, price, detail, highlight }: {
  label: string; price: string; detail: string; highlight?: boolean;
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
        <p style={{ margin: 0, fontSize: "var(--p-font-size-600, 1.25rem)", fontWeight: "bold" as React.CSSProperties["fontWeight"], color: highlight ? "var(--p-color-text-brand, #008060)" : "var(--p-color-text, inherit)" }}>
          {price}
        </p>
        <s-text color="subdued">{detail}</s-text>
        {highlight && <s-badge tone="success">Plan recomendado</s-badge>}
      </s-stack>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function WooCommercePage() {
  const { conn, activeJob } = useLoaderData<typeof loader>();
  const navigate    = useSkuBeamNavigate();
  const revalidator = useRevalidator();

  const analyzeFetcher = useFetcher<{ productCount?: number; orderCount?: number; error?: string }>();
  const migrateFetcher = useFetcher<{ jobId?: string; error?: string }>();
  const statusFetcher  = useFetcher<{ status: string | null; records_processed: number; type: string | null }>();

  const [includeOrders, setIncludeOrders] = useState(false);

  // Track polled job id
  const jobId        = migrateFetcher.data?.jobId ?? activeJob?.id ?? null;
  const polledStatus = statusFetcher.data?.status;
  const isMigrating  = !!jobId && polledStatus !== "completed" && polledStatus !== "failed";

  // Polling
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!jobId) return;
    pollRef.current = setInterval(() => {
      statusFetcher.load(`/api/sync/status?jobId=${jobId}`);
    }, 3000);
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [jobId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (polledStatus === "completed" || polledStatus === "failed") {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      revalidator.revalidate();
    }
  }, [polledStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  const isAnalyzing  = analyzeFetcher.state !== "idle";
  const analyzeResult= analyzeFetcher.data;
  const hasAnalysis  = analyzeResult && "productCount" in analyzeResult;
  const tier         = hasAnalysis ? pricingTier(analyzeResult.productCount!) : null;
  const alreadyDone  = !!conn?.migrated_at;

  // Determine current step
  const currentStep = isMigrating ? 3
    : hasAnalysis ? 2
    : 1;

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
          <Step n={1} label='Configura WooCommerce: ve a WordPress → WooCommerce → Ajustes → Avanzado → REST API y crea una clave con permisos de "Lectura"' done={currentStep > 1} active={currentStep === 1} />
          <Step n={2} label="Pega la URL de tu tienda y las credenciales, luego haz clic en Analizar tienda para ver cuántos productos y órdenes se migrarán" done={currentStep > 2} active={currentStep === 2} />
          <Step n={3} label="Confirma el plan e inicia la migración. SkuBeam importará todos los productos y (opcionalmente) el historial de ventas de los últimos 12 meses" done={alreadyDone} active={currentStep === 3} />
        </s-stack>
      </s-section>

      {/* Migration complete banner */}
      {alreadyDone && polledStatus !== "completed" && (
        <s-banner
          tone="success"
          heading={`Migración completada — ${conn.product_count?.toLocaleString("es-CL") ?? "?"} productos importados desde ${conn.url}`}
        />
      )}
      {polledStatus === "completed" && (
        <s-banner
          tone="success"
          heading={`Migración completada — ${statusFetcher.data?.records_processed?.toLocaleString("es-CL")} registros importados`}
        />
      )}
      {polledStatus === "failed" && (
        <s-banner tone="critical" heading="La migración falló. Revisa los logs e inténtalo de nuevo." />
      )}

      {/* ── Active migration progress ── */}
      {isMigrating && (
        <s-section heading="Migración en curso">
          <s-box padding="large" borderWidth="small" borderRadius="base" background="base">
            <s-stack direction="block" gap="base">
              <s-banner tone="info">
                <s-stack direction="inline" gap="small">
                  <s-spinner />
                  <s-text>
                    Importando datos de WooCommerce
                    {statusFetcher.data?.records_processed
                      ? ` — ${statusFetcher.data.records_processed.toLocaleString("es-CL")} registros procesados`
                      : "…"}
                  </s-text>
                </s-stack>
              </s-banner>
              <s-text color="subdued">
                Este proceso puede tardar varios minutos dependiendo del tamaño de tu catálogo.
                Puedes cerrar esta ventana y volver a revisar el estado más tarde.
              </s-text>
            </s-stack>
          </s-box>
        </s-section>
      )}

      {/* ── Analyze form ── */}
      {!isMigrating && (
        <s-section heading="Conectar tienda WooCommerce">
          <analyzeFetcher.Form method="post" action="/api/woo/analyze">
            <s-stack direction="block" gap="base">
              {analyzeResult?.error && (
                <s-banner tone="critical" heading={analyzeResult.error} />
              )}

              <div style={{ maxWidth: "520px" }}>
                <s-stack direction="block" gap="small">
                  <label style={{ display: "block" }}>
                    <span style={LABEL_STYLE}>URL de la tienda</span>
                    <input
                      type="url"
                      name="store_url"
                      defaultValue={conn?.url ?? ""}
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
          </analyzeFetcher.Form>
        </s-section>
      )}

      {/* ── Analysis result + migration CTA ── */}
      {hasAnalysis && !isMigrating && (
        <s-section heading="Resultado del análisis">
          <s-stack direction="block" gap="base">
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <s-box padding="large" borderWidth="small" borderRadius="base" background="base">
                <s-stack direction="block" gap="small">
                  <s-text color="subdued">Productos encontrados</s-text>
                  <p style={{ margin: 0, fontSize: "var(--p-font-size-750, 1.75rem)", fontWeight: "bold" as React.CSSProperties["fontWeight"] }}>
                    {analyzeResult.productCount!.toLocaleString("es-CL")}
                  </p>
                  <s-text color="subdued">incluye todas las variantes</s-text>
                </s-stack>
              </s-box>
              <s-box padding="large" borderWidth="small" borderRadius="base" background="base">
                <s-stack direction="block" gap="small">
                  <s-text color="subdued">Órdenes disponibles</s-text>
                  <p style={{ margin: 0, fontSize: "var(--p-font-size-750, 1.75rem)", fontWeight: "bold" as React.CSSProperties["fontWeight"] }}>
                    {analyzeResult.orderCount!.toLocaleString("es-CL")}
                  </p>
                  <s-text color="subdued">últimos 12 meses</s-text>
                </s-stack>
              </s-box>
            </s-grid>

            {tier && (
              <s-banner tone="info" heading={`Plan recomendado: ${tier.name} — ${tier.price}`}>
                <s-paragraph>
                  Basado en {analyzeResult.productCount!.toLocaleString("es-CL")} productos encontrados en tu tienda.
                </s-paragraph>
              </s-banner>
            )}

            {/* Migration options */}
            <s-box padding="large" borderWidth="small" borderRadius="base" background="base">
              <s-stack direction="block" gap="base">
                <p style={{ margin: 0, fontSize: "var(--p-font-size-400, 1rem)", fontWeight: "bold" as React.CSSProperties["fontWeight"] }}>
                  Opciones de migración
                </p>

                <div style={{ display: "flex", alignItems: "flex-start", gap: "12px" }}>
                  <input
                    id="include_orders"
                    type="checkbox"
                    checked={includeOrders}
                    onChange={(e) => setIncludeOrders(e.currentTarget.checked)}
                    style={{ marginTop: "3px", cursor: "pointer" }}
                  />
                  <div>
                    <label htmlFor="include_orders" style={{ cursor: "pointer", fontWeight: 600, fontSize: "var(--p-font-size-350, 0.875rem)" }}>
                      Incluir historial de órdenes (+$149 USD)
                    </label>
                    <p style={{ margin: "4px 0 0", fontSize: "var(--p-font-size-300, 0.75rem)", color: "var(--p-color-text-subdued, #6d7175)" }}>
                      Importa los últimos 12 meses de ventas para calcular velocity, reorder points y forecast automáticamente.
                    </p>
                  </div>
                </div>

                {migrateFetcher.data?.error && (
                  <s-banner tone="critical" heading={migrateFetcher.data.error} />
                )}

                <migrateFetcher.Form method="post" action="/api/woo/migrate">
                  <input type="hidden" name="include_orders" value={includeOrders ? "1" : "0"} />
                  <s-button
                    type="submit"
                    variant="primary"
                    {...(migrateFetcher.state !== "idle" ? { loading: true } : {})}
                  >
                    Iniciar migración
                  </s-button>
                </migrateFetcher.Form>
              </s-stack>
            </s-box>
          </s-stack>
        </s-section>
      )}

      {/* ── What gets migrated ── */}
      <s-section heading="Qué se migrará">
        <s-stack direction="block" gap="small">
          {[
            { label: "Productos y variantes",        detail: "SKU, título, precio de costo, atributos de variante" },
            { label: "Stock actual por variante",    detail: "Niveles de inventario en todas las ubicaciones" },
            { label: "Historial de órdenes (+$149)", detail: "Últimos 12 meses — necesario para calcular velocity y forecast" },
          ].map((item, i) => (
            <div
              key={i}
              style={{
                display: "flex", gap: "12px", padding: "12px 0",
                borderBottom: i < 2 ? "1px solid var(--p-color-border-subdued, #e1e3e5)" : "none",
              }}
            >
              <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: "var(--p-color-bg-fill-success, #008060)", flexShrink: 0, marginTop: "6px" }} />
              <div>
                <p style={{ margin: 0, fontWeight: 600, fontSize: "var(--p-font-size-350, 0.875rem)" }}>{item.label}</p>
                <p style={{ margin: 0, fontSize: "var(--p-font-size-300, 0.75rem)", color: "var(--p-color-text-subdued, #6d7175)" }}>{item.detail}</p>
              </div>
            </div>
          ))}
        </s-stack>
      </s-section>

      {/* ── Pricing ── */}
      <s-section heading="Precios de migración">
        <s-stack direction="block" gap="base">
          <s-grid gridTemplateColumns="repeat(3, 1fr)" gap="base">
            <PricingCard label="Hasta 200 productos" price="Gratis"   detail="Productos + stock actual" highlight={!!tier && tier.name === "Gratis"} />
            <PricingCard label="200 – 1.000 productos" price="$49 USD" detail="Productos + stock actual" highlight={!!tier && tier.name === "Starter"} />
            <PricingCard label="Más de 1.000 productos" price="$99 USD" detail="Productos + stock actual" highlight={!!tier && tier.name === "Pro"} />
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
              <p style={{ margin: 0, fontSize: "var(--p-font-size-600, 1.25rem)", fontWeight: "bold" as React.CSSProperties["fontWeight"], whiteSpace: "nowrap" }}>
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
