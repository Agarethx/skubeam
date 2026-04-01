import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useEffect, useRef, useState } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../db.server";
import { useSkuBeamNavigate, useShopifyParams } from "../lib/navigate";

// ── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  const [connResult, activeJobResult, shopResult, lastPreviewJobResult] = await Promise.all([
    supabaseAdmin
      .from("woo_connections")
      .select("url, product_count, order_count, analyzed_at, migrated_at, products_migrated_at, orders_migrated_at")
      .eq("shop_id", shopId)
      .maybeSingle(),

    supabaseAdmin
      .from("sync_jobs")
      .select("id, type, status, records_processed, started_at")
      .eq("shop_id", shopId)
      .in("type", ["woo_migration", "woo_migration_preview"])
      .in("status", ["pending", "running"])
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle(),

    supabaseAdmin
      .from("shops")
      .select("woo_migration_preview")
      .eq("shop_id", shopId)
      .maybeSingle(),

    supabaseAdmin
      .from("sync_jobs")
      .select("records_processed")
      .eq("shop_id", shopId)
      .eq("type", "woo_migration_preview")
      .eq("status", "completed")
      .order("completed_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  return {
    conn:              connResult.data,
    activeJob:         activeJobResult.data,
    previewDone:       shopResult.data?.woo_migration_preview ?? false,
    previewRecords:    lastPreviewJobResult.data?.records_processed ?? null,
    productsMigratedAt: connResult.data?.products_migrated_at ?? null,
    ordersMigratedAt:   connResult.data?.orders_migrated_at   ?? null,
  };
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

// ── Preview done banner ────────────────────────────────────────────────────

function PreviewDoneBanner({
  records,
  tier,
  renderMigrateButtons,
}: {
  records:              number | null;
  tier:                 { name: string; price: string } | null;
  renderMigrateButtons: () => React.ReactNode;
}) {
  return (
    <div
      style={{
        border: "2px solid var(--p-color-border-brand, #008060)",
        borderRadius: "var(--p-border-radius-200, 8px)",
        padding: "20px 24px",
        background: "var(--p-color-bg-surface-brand, #f0faf7)",
      }}
    >
      <s-stack direction="block" gap="base">
        <p style={{ margin: 0, fontWeight: 700, fontSize: "var(--p-font-size-400, 1rem)", color: "var(--p-color-text-brand, #008060)" }}>
          Vista previa completada
        </p>
        <p style={{ margin: 0, fontSize: "var(--p-font-size-350, 0.875rem)", color: "var(--p-color-text, inherit)" }}>
          {records != null
            ? `${records.toLocaleString("es-CL")} registros importados correctamente.`
            : "Productos y órdenes importados correctamente."}{" "}
          ¿Todo se ve bien? Migra el catálogo completo{tier && tier.price !== "$0" ? ` por ${tier.price}` : " gratis"}.
        </p>
        <s-stack direction="inline" gap="base" alignItems="center">
          {renderMigrateButtons()}
        </s-stack>
      </s-stack>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────

type MigrationMode = "preview" | "products" | "orders";

export default function WooCommercePage() {
  const { conn, activeJob, previewDone, previewRecords, productsMigratedAt, ordersMigratedAt } = useLoaderData<typeof loader>();
  const navigate       = useSkuBeamNavigate();
  const revalidator    = useRevalidator();
  const shopifyParams  = useShopifyParams();
  const migrateAction  = `/api/woo/migrate${shopifyParams}`;

  const analyzeFetcher  = useFetcher<{ productCount?: number; orderCount?: number; simpleCount?: number; variableCount?: number; error?: string }>();
  const previewFetcher  = useFetcher<{ jobId?: string; preview?: boolean; error?: string }>();
  const productsFetcher = useFetcher<{ jobId?: string; preview?: boolean; error?: string }>();
  const ordersFetcher   = useFetcher<{ jobId?: string; preview?: boolean; error?: string }>();
  const statusFetcher   = useFetcher<{ status: string | null; records_processed: number; type: string | null }>();

  // Explicit migration state — avoids stale polledStatus issues when switching jobs.
  // mode tracks what phase is running so we can show the right label and estimated total.
  const [activeMigration, setActiveMigration] = useState<{ jobId: string; mode: MigrationMode } | null>(() =>
    activeJob ? { jobId: activeJob.id, mode: activeJob.type === "woo_migration_preview" ? "preview" : "products" } : null,
  );

  // Track which jobId the last statusFetcher response belongs to, to avoid
  // treating a "completed" response for job A as completion of job B.
  const polledJobIdRef = useRef<string | null>(null);
  const pollRef        = useRef<ReturnType<typeof setInterval> | null>(null);

  // When a fetcher returns a new jobId, make it the active migration immediately.
  useEffect(() => {
    const jobId = previewFetcher.data?.jobId;
    if (jobId) setActiveMigration({ jobId, mode: "preview" });
  }, [previewFetcher.data?.jobId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const jobId = productsFetcher.data?.jobId;
    if (jobId) setActiveMigration({ jobId, mode: "products" });
  }, [productsFetcher.data?.jobId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const jobId = ordersFetcher.data?.jobId;
    if (jobId) setActiveMigration({ jobId, mode: "orders" });
  }, [ordersFetcher.data?.jobId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Start polling when activeMigration changes to a new job.
  useEffect(() => {
    if (!activeMigration) return;
    const { jobId } = activeMigration;
    // Immediate first poll so the UI responds without waiting 3 s.
    statusFetcher.load(`/api/sync/status?jobId=${jobId}`);
    pollRef.current = setInterval(() => {
      statusFetcher.load(`/api/sync/status?jobId=${jobId}`);
    }, 3000);
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [activeMigration?.jobId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Record which jobId this poll response belongs to.
  const polledStatus = statusFetcher.data?.status;
  useEffect(() => {
    if (activeMigration && statusFetcher.data) {
      polledJobIdRef.current = activeMigration.jobId;
    }
  }, [statusFetcher.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // When polling confirms completion/failure for the CURRENT job, finalize.
  useEffect(() => {
    if (!activeMigration) return;
    if (
      (polledStatus === "completed" || polledStatus === "failed") &&
      polledJobIdRef.current === activeMigration.jobId
    ) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      setActiveMigration(null);
      revalidator.revalidate();
    }
  }, [polledStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  const isMigrating  = !!activeMigration;
  const isPreviewJob = activeMigration?.mode === "preview";

  const isAnalyzing  = analyzeFetcher.state !== "idle";
  const analyzeResult= analyzeFetcher.data;
  const hasAnalysis  = analyzeResult && "productCount" in analyzeResult;
  const tier         = hasAnalysis
    ? pricingTier(analyzeResult.productCount!)
    : conn?.product_count != null ? pricingTier(conn.product_count) : null;
  const productsMigrated    = !!productsMigratedAt;
  const ordersMigrated      = !!ordersMigratedAt;

  // Estimated total for progress bar — scoped to the active migration mode.
  const estimatedTotal = conn && activeMigration ? (
    activeMigration.mode === "products" ? (conn.product_count ?? 0) :
    activeMigration.mode === "orders"   ? (conn.order_count   ?? 0) :
    /* preview */ (conn.product_count ?? 0) + (conn.order_count ?? 0)
  ) : null;
  const recordsDone  = statusFetcher.data?.records_processed ?? 0;
  const progressPct  = estimatedTotal && estimatedTotal > 0
    ? Math.min(99, Math.round((recordsDone / estimatedTotal) * 100))
    : null;

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
          <Step n={3} label="Confirma el plan e inicia la migración. SkuBeam importará todos los productos y (opcionalmente) el historial de ventas de los últimos 12 meses" done={productsMigrated} active={currentStep === 3} />
        </s-stack>
      </s-section>

      {/* Full migration complete banner */}
      {productsMigrated && polledStatus !== "completed" && (
        <s-banner
          tone="success"
          heading={`Migración completada — ${conn?.product_count?.toLocaleString("es-CL") ?? "?"} productos importados desde ${conn?.url ?? ""}`}
        />
      )}
      {polledStatus === "completed" && !isPreviewJob && (
        <s-banner
          tone="success"
          heading={`Migración completada — ${statusFetcher.data?.records_processed?.toLocaleString("es-CL")} registros importados`}
        />
      )}

      {/* Preview complete banner (in-session) */}
      {polledStatus === "completed" && isPreviewJob && (
        <s-section>
          <PreviewDoneBanner
            records={statusFetcher.data?.records_processed ?? null}
            tier={tier}
            renderMigrateButtons={() => (
              <>
                <productsFetcher.Form method="post" action={migrateAction}>
                  <input type="hidden" name="mode" value="products" />
                  <input type="hidden" name="preview" value="0" />
                  <s-button
                    type="submit"
                    variant="primary"
                    {...(productsFetcher.state !== "idle" ? { loading: true } : {})}
                  >
                    {tier ? `Migrar productos — ${tier.price}` : "Migrar productos"}
                  </s-button>
                </productsFetcher.Form>
                <ordersFetcher.Form method="post" action={migrateAction}>
                  <input type="hidden" name="mode" value="orders" />
                  <input type="hidden" name="preview" value="0" />
                  <s-button
                    type="submit"
                    variant="secondary"
                    {...(ordersFetcher.state !== "idle" ? { loading: true } : {})}
                  >
                    Migrar órdenes — $149 USD
                  </s-button>
                </ordersFetcher.Form>
              </>
            )}
          />
        </s-section>
      )}

      {polledStatus === "failed" && !activeJob && (
        <s-banner tone="critical" heading="La migración falló. Revisa los logs e inténtalo de nuevo." />
      )}

      {/* ── Active migration progress ── */}
      {isMigrating && (
        <s-section heading={isPreviewJob ? "Vista previa en curso" : "Migración en curso"}>
          <s-box padding="large" borderWidth="small" borderRadius="base" background="base">
            <s-stack direction="block" gap="base">
              {/* Header row */}
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <s-spinner />
                <div style={{ flex: 1 }}>
                  <p style={{ margin: 0, fontWeight: 600, fontSize: "var(--p-font-size-350, 0.875rem)" }}>
                    {activeMigration?.mode === "preview"   ? "Importando muestra de 5 productos y 5 órdenes…" :
                   activeMigration?.mode === "products"  ? "Migrando productos…" :
                   activeMigration?.mode === "orders"    ? "Migrando historial de órdenes…" :
                   "Importando datos de WooCommerce…"}
                  </p>
                  {recordsDone > 0 && (
                    <p style={{ margin: "2px 0 0", fontSize: "var(--p-font-size-300, 0.75rem)", color: "var(--p-color-text-subdued, #6d7175)" }}>
                      {recordsDone.toLocaleString("es-CL")} registros procesados
                      {estimatedTotal && estimatedTotal > 0
                        ? ` de ~${estimatedTotal.toLocaleString("es-CL")}`
                        : ""}
                    </p>
                  )}
                </div>
                {progressPct !== null && (
                  <p style={{ margin: 0, fontWeight: 700, fontSize: "var(--p-font-size-400, 1rem)", color: "var(--p-color-text-brand, #008060)" }}>
                    {progressPct}%
                  </p>
                )}
              </div>

              {/* Progress bar */}
              <div style={{ height: "6px", borderRadius: "3px", background: "var(--p-color-bg-fill-secondary, #e4e5e7)", overflow: "hidden" }}>
                {progressPct !== null ? (
                  <div
                    style={{
                      height: "100%",
                      width: `${progressPct}%`,
                      background: "var(--p-color-bg-fill-brand, #008060)",
                      borderRadius: "3px",
                      transition: "width 0.5s ease",
                    }}
                  />
                ) : (
                  /* Indeterminate stripe animation when we have no total estimate */
                  <div
                    style={{
                      height: "100%",
                      width: "40%",
                      background: "var(--p-color-bg-fill-brand, #008060)",
                      borderRadius: "3px",
                      animation: "woo-progress-slide 1.4s ease-in-out infinite",
                    }}
                  />
                )}
              </div>

              <style>{`
                @keyframes woo-progress-slide {
                  0%   { transform: translateX(-100%); }
                  100% { transform: translateX(350%); }
                }
              `}</style>

              {!isPreviewJob && (
                <s-stack direction="block" gap="small">
                  <s-text color="subdued">
                    Este proceso puede tardar entre 10 y 40 minutos dependiendo de la cantidad de productos.
                    Con catálogos grandes (+1.000 productos) puede demorar más de una hora.
                  </s-text>
                  <s-text color="subdued">
                    Puedes cerrar esta ventana con seguridad — la migración continúa en segundo plano.
                    Vuelve más tarde para ver el resultado.
                  </s-text>
                </s-stack>
              )}
            </s-stack>
          </s-box>
        </s-section>
      )}

      {/* ── Preview done banner (on re-visit, no active analysis) ── */}
      {previewDone && !productsMigrated && !hasAnalysis && !isMigrating && polledStatus !== "completed" && (
        <s-section>
          <PreviewDoneBanner
            records={previewRecords}
            tier={tier}
            renderMigrateButtons={() => (
              <>
                {!productsMigrated ? (
                  <productsFetcher.Form method="post" action={migrateAction}>
                    <input type="hidden" name="mode" value="products" />
                    <input type="hidden" name="preview" value="0" />
                    <s-button
                      type="submit"
                      variant="primary"
                      {...(productsFetcher.state !== "idle" ? { loading: true } : {})}
                    >
                      {tier ? `Migrar productos — ${tier.price}` : "Migrar productos"}
                    </s-button>
                  </productsFetcher.Form>
                ) : (
                  <s-badge tone="success">✓ Productos migrados</s-badge>
                )}
                {productsMigrated && !ordersMigrated && (
                  <ordersFetcher.Form method="post" action={migrateAction}>
                    <input type="hidden" name="mode" value="orders" />
                    <input type="hidden" name="preview" value="0" />
                    <s-button
                      type="submit"
                      variant="secondary"
                      {...(ordersFetcher.state !== "idle" ? { loading: true } : {})}
                    >
                      Migrar órdenes — $149 USD
                    </s-button>
                  </ordersFetcher.Form>
                )}
                {ordersMigrated && (
                  <s-badge tone="success">✓ Órdenes migradas</s-badge>
                )}
              </>
            )}
          />
        </s-section>
      )}

      {/* ── Analyze form ── */}
      {!isMigrating && !(previewDone && !productsMigrated && !hasAnalysis) && (
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
                  {analyzeResult.simpleCount != null && analyzeResult.variableCount != null ? (
                    <s-stack direction="block" gap="small-500">
                      <s-text color="subdued">
                        {analyzeResult.simpleCount.toLocaleString("es-CL")} simples
                        {" + "}
                        {analyzeResult.variableCount.toLocaleString("es-CL")} con variantes
                      </s-text>
                      {analyzeResult.variableCount > 0 && (
                        <s-text color="subdued">el total de SKUs puede ser mayor</s-text>
                      )}
                    </s-stack>
                  ) : (
                    <s-text color="subdued">incluye todas las variantes</s-text>
                  )}
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

            {/* Migration CTAs */}
            <s-box padding="large" borderWidth="small" borderRadius="base" background="base">
              <s-stack direction="block" gap="base">
                <p style={{ margin: 0, fontSize: "var(--p-font-size-400, 1rem)", fontWeight: "bold" as React.CSSProperties["fontWeight"] }}>
                  Opciones de migración
                </p>

                {(previewFetcher.data?.error || productsFetcher.data?.error || ordersFetcher.data?.error) && (
                  <s-banner tone="critical" heading={previewFetcher.data?.error ?? productsFetcher.data?.error ?? ordersFetcher.data?.error} />
                )}

                <s-stack direction="inline" gap="base" alignItems="center">
                  {/* Free preview — always uses "all" mode internally */}
                  {!previewDone && (
                    <previewFetcher.Form method="post" action={migrateAction}>
                      <input type="hidden" name="preview" value="1" />
                      <s-button
                        type="submit"
                        variant="secondary"
                        onClick={() => console.log("[woo] submitting preview")}
                        {...(previewFetcher.state !== "idle" ? { loading: true } : {})}
                      >
                        Probar gratis (5 productos + 5 órdenes)
                      </s-button>
                    </previewFetcher.Form>
                  )}

                  {/* Botón 1: Migrar productos */}
                  {!productsMigrated ? (
                    <productsFetcher.Form method="post" action={migrateAction}>
                      <input type="hidden" name="mode" value="products" />
                      <input type="hidden" name="preview" value="0" />
                      <s-button
                        type="submit"
                        variant="primary"
                        {...(productsFetcher.state !== "idle" ? { loading: true } : {})}
                      >
                        {tier ? `Migrar productos — ${tier.price}` : "Migrar productos"}
                      </s-button>
                    </productsFetcher.Form>
                  ) : (
                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      <s-badge tone="success">✓ Productos migrados</s-badge>
                      <span style={{ fontSize: "var(--p-font-size-300, 0.75rem)", color: "var(--p-color-text-subdued, #6d7175)" }}>
                        {new Date(productsMigratedAt!).toLocaleDateString("es-CL")}
                      </span>
                    </div>
                  )}

                  {/* Botón 2: Migrar órdenes — solo disponible si productos ya fueron migrados */}
                  {productsMigrated && !ordersMigrated && (
                    <ordersFetcher.Form method="post" action={migrateAction}>
                      <input type="hidden" name="mode" value="orders" />
                      <input type="hidden" name="preview" value="0" />
                      <s-button
                        type="submit"
                        variant="secondary"
                        {...(ordersFetcher.state !== "idle" ? { loading: true } : {})}
                      >
                        Migrar historial de órdenes — $149 USD
                      </s-button>
                    </ordersFetcher.Form>
                  )}
                  {ordersMigrated && (
                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      <s-badge tone="success">✓ Órdenes migradas</s-badge>
                      <span style={{ fontSize: "var(--p-font-size-300, 0.75rem)", color: "var(--p-color-text-subdued, #6d7175)" }}>
                        {new Date(ordersMigratedAt!).toLocaleDateString("es-CL")}
                      </span>
                    </div>
                  )}
                </s-stack>

                {productsMigrated && !ordersMigrated && (
                  <s-text color="subdued">
                    Importa los últimos 12 meses de ventas para calcular velocity, reorder points y forecast automáticamente.
                  </s-text>
                )}
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
