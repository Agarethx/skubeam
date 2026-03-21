import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useFetcher, useLoaderData, useNavigation, useRevalidator } from "react-router";
import { useEffect, useRef } from "react";
import { useSkuBeamNavigate } from "../lib/navigate";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../db.server";
import {
  createBsaleJob,
  getActiveBsaleJob,
} from "../integrations/bsale/jobs.server";
import { registerBsaleWebhook } from "../integrations/bsale/client.server";

// ── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  const [shopRow, activeJob, recentBoletas] = await Promise.all([
    supabaseAdmin
      .from("shops")
      .select("bsale_token, bsale_last_sync, active_addons")
      .eq("shop_id", shopId)
      .single()
      .then(({ data }) => data),
    getActiveBsaleJob(shopId),
    supabaseAdmin
      .from("bsale_documents")
      .select("shopify_order_id, bsale_document_id, status, url_pdf, total_amount, created_at")
      .eq("shop_id", shopId)
      .order("created_at", { ascending: false })
      .limit(5)
      .then(({ data }) => data ?? []),
  ]);

  const hasAddon = shopRow?.active_addons?.includes("bsale_documents") ?? false;

  return {
    hasToken:      !!shopRow?.bsale_token,
    bsaleLastSync: shopRow?.bsale_last_sync ?? null,
    activeJob,
    hasAddon,
    recentBoletas,
  };
};

// ── Action ────────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("[bsale-action] start");

  const { session } = await authenticate.admin(request);
  const shopId   = session.shop;
  console.log("[bsale-action] shopId:", shopId);

  const formData = await request.formData();
  const intent   = formData.get("intent") as string;
  const rawToken = formData.get("bsale_token");
  console.log("[bsale-action] intent:", intent, "| bsale_token length:", String(rawToken ?? "").length);
  console.log("[bsale-action] all formData keys:", [...formData.keys()]);

  if (intent === "save_token") {
    const token = (rawToken as string | null)?.trim() ?? "";
    console.log("[bsale-action] save_token branch | token present:", !!token, "| length:", token.length);
    if (!token) return { error: "El token no puede estar vacío." };

    console.log("[bsale-action] attempting supabase update for shop_id:", shopId);
    const { error, data } = await supabaseAdmin
      .from("shops")
      .update({ bsale_token: token })
      .eq("shop_id", shopId)
      .select("shop_id, bsale_token");
    console.log("[bsale-action] supabase result:", { error, rowsAffected: data?.length ?? 0, data });

    if (error) {
      console.error("[bsale-action] supabase ERROR:", error);
      return { error: `Error guardando token: ${error.message}` };
    }
    if (!data || data.length === 0) {
      console.warn("[bsale-action] WARNING: update matched 0 rows — shop row missing for", shopId);
      return { error: `No se encontró el registro del shop (shop_id: ${shopId}). Intenta re-instalar la app.` };
    }
    console.log("[bsale-action] token saved OK");

    // Auto-register Bsale webhook after saving the token
    const appUrl = process.env.APP_URL ?? "";
    if (appUrl) {
      const webhookUrl = `${appUrl}/webhooks/bsale/document?shop=${shopId}`;
      const reg = await registerBsaleWebhook(token, webhookUrl);
      if (!reg.ok) {
        return { success: "Token guardado. No se pudo registrar el webhook automáticamente — usa el botón 'Re-registrar webhook'.", webhookError: reg.error };
      }
      if (reg.skipped) {
        const reason = reg.reason === "sandbox-no-webhooks"
          ? "Token guardado. Cuenta sandbox — webhook no registrado."
          : "Token guardado. Webhook ya estaba registrado en Bsale.";
        return { success: reason };
      }
      return { success: `Token guardado y webhook registrado en Bsale (id: ${reg.id}).` };
    }

    return { success: "Token guardado correctamente." };
  }

  if (intent === "register_webhook") {
    const { data: shop } = await supabaseAdmin
      .from("shops")
      .select("bsale_token")
      .eq("shop_id", shopId)
      .single();

    const token = shop?.bsale_token;
    if (!token) return { error: "Configura el access token antes de registrar el webhook." };

    const appUrl = process.env.APP_URL ?? "";
    if (!appUrl) return { error: "APP_URL no está configurado en el entorno." };

    const webhookUrl = `${appUrl}/webhooks/bsale/document?shop=${shopId}`;
    const reg = await registerBsaleWebhook(token, webhookUrl);
    if (!reg.ok) return { error: `Error registrando webhook: ${reg.error}` };
    if (reg.skipped) {
      const reason = reg.reason === "sandbox-no-webhooks"
        ? "Cuenta sandbox — el registro de webhooks no está disponible."
        : "El webhook ya estaba registrado en Bsale.";
      return { success: reason };
    }
    return { success: `Webhook registrado en Bsale (id: ${reg.id}). URL: ${webhookUrl}` };
  }

  const { data: shop } = await supabaseAdmin
    .from("shops")
    .select("bsale_token")
    .eq("shop_id", shopId)
    .single();

  if (!shop?.bsale_token && !process.env.BSALE_ACCESS_TOKEN) {
    return { error: "Configura el access token de Bsale antes de sincronizar." };
  }

  if (intent === "sync_products") {
    const job = await createBsaleJob(shopId, "bsale_products");
    return { jobId: job.id, jobType: "bsale_products" as const };
  }

  if (intent === "sync_stock") {
    const job = await createBsaleJob(shopId, "bsale_stock");
    return { jobId: job.id, jobType: "bsale_stock" as const };
  }

  console.warn("[bsale-action] unknown intent:", intent);
  return { error: "Acción desconocida." };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string | null) {
  if (!iso) return "Nunca";
  return new Intl.DateTimeFormat("es-MX", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

function jobTypeLabel(type: string | null | undefined) {
  if (type === "bsale_products") return "productos";
  if (type === "bsale_stock")    return "stock";
  return "datos";
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

// ── UI ────────────────────────────────────────────────────────────────────────

export default function BsaleIntegrationPage() {
  const { hasToken, bsaleLastSync, activeJob, hasAddon, recentBoletas } = useLoaderData<typeof loader>();
  const navigation  = useNavigation();
  const revalidator = useRevalidator();
  const navigate    = useSkuBeamNavigate();

  const webhookFetcher = useFetcher<{ success?: string; error?: string }>();

  const createFetcher = useFetcher<{
    jobId?:        string;
    jobType?:      "bsale_products" | "bsale_stock";
    error?:        string;
    success?:      string;
    webhookError?: string;
  }>();
  const triggerFetcher = useFetcher();
  const statusFetcher  = useFetcher<{
    status:            string | null;
    records_processed: number;
    type:              string | null;
  }>();

  const pollRef         = useRef<ReturnType<typeof setInterval> | null>(null);
  const triggeredJobRef = useRef<string | null>(null);

  const pendingJobId = createFetcher.data?.jobId ?? null;
  const jobId        = pendingJobId ?? activeJob?.id ?? null;
  const polledStatus = statusFetcher.data?.status;
  const isRunning    = !!jobId && polledStatus !== "completed" && polledStatus !== "failed";

  useEffect(() => {
    if (!pendingJobId || triggeredJobRef.current === pendingJobId) return;
    triggeredJobRef.current = pendingJobId;
    triggerFetcher.submit(
      { jobId: pendingJobId },
      { method: "post", action: "/api/bsale/sync" },
    );
  }, [pendingJobId]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const isSavingToken =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "save_token";

  const errorMsg =
    (createFetcher.data && "error" in createFetcher.data
      ? createFetcher.data.error
      : null) ??
    (webhookFetcher.data && "error" in webhookFetcher.data
      ? webhookFetcher.data.error
      : null) ??
    (polledStatus === "failed" ? "La sincronización falló. Revisa los logs." : null);

  const successMsg =
    (createFetcher.data && "success" in createFetcher.data
      ? createFetcher.data.success
      : null) ??
    (webhookFetcher.data && "success" in webhookFetcher.data
      ? webhookFetcher.data.success
      : null);

  const progressLabel  = statusFetcher.data?.records_processed
    ? ` — ${statusFetcher.data.records_processed} registros`
    : "";
  const runningType = statusFetcher.data?.type ?? activeJob?.type ?? null;

  return (
    <s-page heading="Integración Bsale">

      {/* Back */}
      <s-section>
        <s-button variant="tertiary" onClick={() => navigate("/app/integrations")}>
          ← Volver a Integraciones
        </s-button>
      </s-section>

      {/* Feedback banners */}
      {successMsg && <s-banner tone="success" heading={successMsg} />}
      {errorMsg   && <s-banner tone="critical" heading={errorMsg} />}

      {/* ── Status strip ── */}
      <s-section>
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="base">
          <s-box padding="large" borderWidth="small" borderRadius="base" background="base">
            <s-stack direction="block" gap="small">
              <s-text color="subdued">Estado de conexión</s-text>
              <s-badge tone={hasToken ? "success" : "warning"}>
                {hasToken ? "Token configurado ✓" : "Sin token"}
              </s-badge>
            </s-stack>
          </s-box>
          <s-box padding="large" borderWidth="small" borderRadius="base" background="base">
            <s-stack direction="block" gap="small">
              <s-text color="subdued">Última sincronización</s-text>
              <p
                style={{
                  margin: 0,
                  fontSize: "var(--p-font-size-350, 0.875rem)",
                  fontWeight: "var(--p-font-weight-semibold, 600)" as React.CSSProperties["fontWeight"],
                  color: "var(--p-color-text, inherit)",
                }}
              >
                {formatDate(bsaleLastSync)}
              </p>
            </s-stack>
          </s-box>
          <s-box padding="large" borderWidth="small" borderRadius="base" background="base">
            <s-stack direction="block" gap="small">
              <s-text color="subdued">Sync bidireccional</s-text>
              <s-badge tone="info">Tiempo real activo</s-badge>
            </s-stack>
          </s-box>
        </s-grid>
      </s-section>

      {/* ── Config + Sync in two columns ── */}
      <s-section>
        <s-grid gridTemplateColumns="1fr 1fr" gap="base">

          {/* Token config */}
          <s-box padding="large" borderWidth="small" borderRadius="base" background="base">
            <s-stack direction="block" gap="base">
              <p
                style={{
                  margin: 0,
                  fontSize: "var(--p-font-size-400, 1rem)",
                  fontWeight: "var(--p-font-weight-bold, 700)" as React.CSSProperties["fontWeight"],
                }}
              >
                Access Token
              </p>
              <s-text color="subdued">
                Obtén tu token en Bsale → Configuración → API. El token se
                guarda de forma segura y nunca se expone al navegador.
              </s-text>
              <Form method="post">
                <input type="hidden" name="intent" value="save_token" />
                <s-stack direction="block" gap="small">
                  <label style={{ display: "block" }}>
                    <span
                      style={{
                        fontSize: "var(--p-font-size-300, 0.75rem)",
                        fontWeight: 600,
                        color: "var(--p-color-text-subdued, #6d7175)",
                        display: "block",
                        marginBottom: "6px",
                      }}
                    >
                      Access Token de Bsale
                    </span>
                    <input
                      type="password"
                      name="bsale_token"
                      placeholder={hasToken ? "••••••••••••••••••••" : "Pega aquí tu access token"}
                      style={INPUT_STYLE}
                    />
                  </label>
                  <s-button
                    type="submit"
                    variant="secondary"
                    {...(isSavingToken ? { loading: true } : {})}
                  >
                    {hasToken ? "Actualizar token" : "Guardar token"}
                  </s-button>
                </s-stack>
              </Form>

              {hasToken && (
                <webhookFetcher.Form method="post">
                  <input type="hidden" name="intent" value="register_webhook" />
                  <s-button
                    type="submit"
                    variant="tertiary"
                    {...(webhookFetcher.state !== "idle" ? { loading: true } : {})}
                  >
                    Re-registrar webhook
                  </s-button>
                </webhookFetcher.Form>
              )}
            </s-stack>
          </s-box>

          {/* Sync actions */}
          <s-box padding="large" borderWidth="small" borderRadius="base" background="base">
            <s-stack direction="block" gap="base">
              <p
                style={{
                  margin: 0,
                  fontSize: "var(--p-font-size-400, 1rem)",
                  fontWeight: "var(--p-font-weight-bold, 700)" as React.CSSProperties["fontWeight"],
                }}
              >
                Sincronización manual
              </p>

              {!hasToken && (
                <s-banner tone="warning" heading="Configura el access token antes de sincronizar." />
              )}

              {isRunning && (
                <s-banner tone="info">
                  <s-stack direction="inline" gap="small">
                    <s-spinner />
                    <s-text>Sincronizando {jobTypeLabel(runningType)}{progressLabel}…</s-text>
                  </s-stack>
                </s-banner>
              )}

              <s-stack direction="block" gap="small">
                <s-text type="strong">Productos</s-text>
                <s-text color="subdued">
                  Importa el catálogo completo de variantes desde Bsale.
                  Respeta el costo promedio (averageCost) de cada variante.
                </s-text>
                <s-stack direction="inline" gap="small">
                  <createFetcher.Form method="post">
                    <input type="hidden" name="intent" value="sync_products" />
                    <s-button
                      type="submit"
                      {...(isRunning || createFetcher.state !== "idle" ? { loading: true } : {})}
                      {...(!hasToken ? { disabled: true } : {})}
                    >
                      Sincronizar productos
                    </s-button>
                  </createFetcher.Form>
                  {hasToken && !isRunning && (
                    <s-button
                      variant="secondary"
                      onClick={() => navigate("/app/integrations/bsale/diff")}
                    >
                      Revisar diff →
                    </s-button>
                  )}
                </s-stack>
              </s-stack>

              <div style={{ height: "1px", background: "var(--p-color-border, #e1e3e5)" }} />

              <s-stack direction="block" gap="small">
                <s-text type="strong">Stock</s-text>
                <s-text color="subdued">
                  Actualiza los niveles de inventario por oficina. Requiere que
                  los productos ya estén sincronizados.
                </s-text>
                <createFetcher.Form method="post">
                  <input type="hidden" name="intent" value="sync_stock" />
                  <s-button
                    type="submit"
                    variant="secondary"
                    {...(isRunning || createFetcher.state !== "idle" ? { loading: true } : {})}
                    {...(!hasToken ? { disabled: true } : {})}
                  >
                    Sincronizar stock
                  </s-button>
                </createFetcher.Form>
              </s-stack>
            </s-stack>
          </s-box>

        </s-grid>
      </s-section>

      {/* ── Boleta electrónica add-on ── */}
      <s-section heading="Boleta electrónica automática">
        {hasAddon ? (
          <s-stack direction="block" gap="base">
            <s-banner tone="success" heading="Add-on activo — se emite una boleta por cada venta en Shopify." />
            {recentBoletas.length === 0 ? (
              <s-text color="subdued">Aún no hay boletas emitidas.</s-text>
            ) : (
              <div
                style={{
                  border:       "1px solid var(--p-color-border, #e1e3e5)",
                  borderRadius: "var(--p-border-radius-200, 8px)",
                  overflow:     "hidden",
                }}
              >
                {/* Header */}
                <div
                  style={{
                    display:             "grid",
                    gridTemplateColumns: "1fr 100px 90px 60px",
                    padding:             "8px 12px",
                    background:          "var(--p-color-bg-surface-secondary, #f6f6f7)",
                    borderBottom:        "1px solid var(--p-color-border, #e1e3e5)",
                    fontSize:            "var(--p-font-size-300, 0.75rem)",
                    fontWeight:          600,
                    color:               "var(--p-color-text-subdued, #6d7175)",
                    textTransform:       "uppercase",
                    letterSpacing:       "0.04em",
                  }}
                >
                  <span>Orden Shopify</span>
                  <span>Total</span>
                  <span>Estado</span>
                  <span>PDF</span>
                </div>
                {recentBoletas.map((doc, idx) => (
                  <div
                    key={doc.shopify_order_id}
                    style={{
                      display:             "grid",
                      gridTemplateColumns: "1fr 100px 90px 60px",
                      padding:             "10px 12px",
                      alignItems:          "center",
                      background:          idx % 2 === 0
                        ? "var(--p-color-bg-surface, #fff)"
                        : "var(--p-color-bg-surface-secondary, #f6f6f7)",
                      borderBottom: idx < recentBoletas.length - 1
                        ? "1px solid var(--p-color-border-subdued, #e1e3e5)"
                        : "none",
                      fontSize: "var(--p-font-size-350, 0.875rem)",
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>#{doc.shopify_order_id}</span>
                    <span>
                      {doc.total_amount != null
                        ? new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP" }).format(Number(doc.total_amount))
                        : "—"}
                    </span>
                    <span>
                      <s-badge
                        tone={
                          doc.status === "emitted" ? "success"
                          : doc.status === "error"  ? "critical"
                          : "warning"
                        }
                      >
                        {doc.status === "emitted" ? "Emitida"
                          : doc.status === "error" ? "Error"
                          : "Pendiente"}
                      </s-badge>
                    </span>
                    <span>
                      {doc.url_pdf ? (
                        <a
                          href={doc.url_pdf}
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: "var(--p-color-text-emphasis, #005bd3)" }}
                        >
                          Ver
                        </a>
                      ) : (
                        <span style={{ color: "var(--p-color-text-subdued, #6d7175)" }}>—</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </s-stack>
        ) : (
          <s-box padding="large" borderWidth="small" borderRadius="base" background="base">
            <s-stack direction="block" gap="base">
              <s-text color="subdued">
                Emite una boleta electrónica en Bsale automáticamente por cada venta en Shopify.
                El documento se envía al SII y al cliente por email.
              </s-text>
              <s-banner tone="info" heading="Add-on de pago — contacta a soporte para activarlo en tu cuenta." />
            </s-stack>
          </s-box>
        )}
      </s-section>

    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
