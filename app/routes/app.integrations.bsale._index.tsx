import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useEffect, useRef, useState } from "react";
import { useSkuBeamNavigate } from "../lib/navigate";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../db.server";
import {
  createBsaleJob,
  getActiveBsaleJob,
} from "../integrations/bsale/jobs.server";
import {
  registerBsaleWebhook,
  getPriceLists,
  getOffices,
  type BsalePriceListOption,
  type BsaleOfficeOption,
} from "../integrations/bsale/client.server";

// ── Loader ────────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  const [shopRow, activeJob, recentBoletas] = await Promise.all([
    supabaseAdmin
      .from("shops")
      .select("bsale_token, bsale_last_sync, active_addons, bsale_price_list_id, bsale_office_id")
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

  const hasToken    = !!shopRow?.bsale_token;
  const hasPriceList = !!shopRow?.bsale_price_list_id;
  const hasOffice    = !!shopRow?.bsale_office_id;
  const hasAddon     = shopRow?.active_addons?.includes("bsale_documents") ?? false;

  // Always load price lists + offices when the token exists
  // (needed both for wizard and for "Cambiar configuración" flow)
  const [priceLists, offices]: [BsalePriceListOption[], BsaleOfficeOption[]] = hasToken
    ? await Promise.all([
        getPriceLists(shopRow!.bsale_token!),
        getOffices(shopRow!.bsale_token!),
      ])
    : [[], []];

  const isFullyConfigured = hasToken && hasPriceList && hasOffice;

  return {
    hasToken,
    hasPriceList,
    hasOffice,
    isFullyConfigured,
    priceListId:   shopRow?.bsale_price_list_id ?? null,
    officeId:      shopRow?.bsale_office_id ?? null,
    bsaleLastSync: shopRow?.bsale_last_sync ?? null,
    activeJob,
    hasAddon,
    recentBoletas,
    priceLists,
    offices,
  };
};

// ── Action ────────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  const formData = await request.formData();
  const intent   = formData.get("intent") as string;

  if (intent === "save_token") {
    const token = ((formData.get("bsale_token") as string | null) ?? "").trim();
    if (!token) return { error: "El token no puede estar vacío." };

    const { error, data } = await supabaseAdmin
      .from("shops")
      .update({ bsale_token: token })
      .eq("shop_id", shopId)
      .select("shop_id");

    if (error) return { error: `Error guardando token: ${error.message}` };
    if (!data?.length) return { error: `No se encontró el registro del shop. Intenta re-instalar la app.` };

    const appUrl = process.env.APP_URL ?? "";
    if (appUrl) {
      const webhookUrl = `${appUrl}/webhooks/bsale/document?shop=${shopId}`;
      const reg = await registerBsaleWebhook(token, webhookUrl);
      if (reg.skipped && reg.reason === "sandbox-no-webhooks") {
        return { success: "Token guardado. Cuenta sandbox — webhook no registrado.", tokenSaved: true };
      }
      if (reg.skipped) {
        return { success: "Token guardado. Webhook ya estaba registrado.", tokenSaved: true };
      }
      if (!reg.ok) {
        return { success: "Token guardado. Webhook pendiente de registro manual.", tokenSaved: true };
      }
      return { success: `Token guardado y webhook registrado (id: ${reg.id}).`, tokenSaved: true };
    }
    return { success: "Token guardado correctamente.", tokenSaved: true };
  }

  if (intent === "register_webhook") {
    const { data: shop } = await supabaseAdmin
      .from("shops").select("bsale_token").eq("shop_id", shopId).single();
    const token = shop?.bsale_token;
    if (!token) return { error: "Configura el access token antes de registrar el webhook." };
    const appUrl = process.env.APP_URL ?? "";
    if (!appUrl) return { error: "APP_URL no está configurado en el entorno." };
    const webhookUrl = `${appUrl}/webhooks/bsale/document?shop=${shopId}`;
    const reg = await registerBsaleWebhook(token, webhookUrl);
    if (!reg.ok) return { error: `Error registrando webhook: ${reg.error}` };
    if (reg.skipped) return { success: reg.reason === "sandbox-no-webhooks"
      ? "Cuenta sandbox — webhooks no disponibles."
      : "El webhook ya estaba registrado." };
    return { success: `Webhook registrado (id: ${reg.id}). URL: ${webhookUrl}` };
  }

  const { data: shop } = await supabaseAdmin
    .from("shops").select("bsale_token").eq("shop_id", shopId).single();
  if (!shop?.bsale_token && !process.env.BSALE_ACCESS_TOKEN)
    return { error: "Configura el access token de Bsale antes de sincronizar." };

  if (intent === "sync_products") {
    const job = await createBsaleJob(shopId, "bsale_products");
    return { jobId: job.id, jobType: "bsale_products" as const };
  }
  if (intent === "sync_stock") {
    console.log("[stock-sync] action called, intent:", intent);
    console.log("[stock-sync] shop:", shopId);
    console.log("[stock-sync] bsale_token exists:", !!shop?.bsale_token);
    const job = await createBsaleJob(shopId, "bsale_stock");
    console.log("[stock-sync] job created:", job.id);
    return { jobId: job.id, jobType: "bsale_stock" as const };
  }

  return { error: "Acción desconocida." };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string | null) {
  if (!iso) return "Nunca";
  return new Intl.DateTimeFormat("es-CL", { dateStyle: "medium", timeStyle: "short" })
    .format(new Date(iso));
}

function jobTypeLabel(type: string | null | undefined) {
  if (type === "bsale_products") return "productos";
  if (type === "bsale_stock")    return "stock";
  return "datos";
}

const INPUT_STYLE: React.CSSProperties = {
  width:        "100%",
  padding:      "8px 12px",
  fontSize:     "var(--p-font-size-350, 0.875rem)",
  border:       "1px solid var(--p-color-border, #e1e3e5)",
  borderRadius: "var(--p-border-radius-200, 8px)",
  background:   "var(--p-color-bg-surface, #fff)",
  color:        "var(--p-color-text, inherit)",
  boxSizing:    "border-box",
};

const SELECT_STYLE: React.CSSProperties = {
  ...INPUT_STYLE,
  appearance:     "auto",
  cursor:         "pointer",
  paddingRight:   "32px",
};

const LABEL_STYLE: React.CSSProperties = {
  fontSize:     "var(--p-font-size-300, 0.75rem)",
  fontWeight:   600,
  color:        "var(--p-color-text-subdued, #6d7175)",
  display:      "block",
  marginBottom: "6px",
};

const HEADING_STYLE: React.CSSProperties = {
  margin:     0,
  fontSize:   "var(--p-font-size-400, 1rem)",
  fontWeight: "var(--p-font-weight-bold, 700)" as React.CSSProperties["fontWeight"],
};

// ── Wizard step header ─────────────────────────────────────────────────────────

function WizardHeader({ step, onReset }: { step: 1 | 2 | 3 | 4; onReset?: () => void }) {
  const labels = ["Token", "Lista de precios", "Sucursal", "Confirmar"];
  return (
    <s-box padding="base" borderWidth="small" borderRadius="base" background="subdued">
      <s-stack direction="block" gap="small">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <s-text>
            <strong>Configuración Bsale</strong> — Paso {step} de 4: {labels[step - 1]}
          </s-text>
          {onReset && (
            <s-button variant="tertiary" onClick={onReset}>
              Cancelar
            </s-button>
          )}
        </div>
        {/* Progress bar */}
        <div style={{ background: "var(--p-color-border, #e1e3e5)", borderRadius: 4, height: 4 }}>
          <div
            style={{
              background:    "var(--p-color-icon-success, #008060)",
              borderRadius:  4,
              height:        4,
              width:         `${(step / 4) * 100}%`,
              transition:    "width 0.3s ease",
            }}
          />
        </div>
      </s-stack>
    </s-box>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function BsaleIntegrationPage() {
  const {
    hasToken, hasPriceList, hasOffice, isFullyConfigured,
    priceListId, officeId,
    bsaleLastSync, activeJob, hasAddon, recentBoletas,
    priceLists, offices,
  } = useLoaderData<typeof loader>();

  const revalidator = useRevalidator();
  const navigate    = useSkuBeamNavigate();

  // Wizard state — start from DB state; "Cambiar configuración" resets to 1
  const initialStep: 1 | 2 | 3 | 4 = !hasToken ? 1 : !hasPriceList ? 2 : !hasOffice ? 3 : 4;
  const [showWizard, setShowWizard] = useState(!isFullyConfigured);
  const [step, setStep]             = useState<1 | 2 | 3 | 4>(initialStep);

  // Local selections for steps 2 + 3
  const [selectedPriceListId, setSelectedPriceListId] = useState<number | "">(priceListId ?? "");
  const [selectedOfficeId,    setSelectedOfficeId]    = useState<number | "">(officeId ?? "");

  // Fetchers
  const tokenFetcher   = useFetcher<{ success?: string; error?: string; tokenSaved?: boolean }>();
  const webhookFetcher = useFetcher<{ success?: string; error?: string }>();
  const setupFetcher   = useFetcher<{ ok?: boolean }>();
  const createFetcher  = useFetcher<{ jobId?: string; jobType?: "bsale_products" | "bsale_stock"; error?: string; success?: string }>();
  const triggerFetcher = useFetcher();
  const statusFetcher  = useFetcher<{ status: string | null; records_processed: number; type: string | null }>();

  const pollRef         = useRef<ReturnType<typeof setInterval> | null>(null);
  const triggeredJobRef = useRef<string | null>(null);

  // Step 1 → 2: advance when token is saved
  useEffect(() => {
    if (tokenFetcher.data?.tokenSaved && step === 1) setStep(2);
  }, [tokenFetcher.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // Step 2 → 3 and Step 3 → 4: advance when setup saved
  useEffect(() => {
    if (setupFetcher.data?.ok) {
      if (step === 2) setStep(3);
      else if (step === 3) setStep(4);
    }
  }, [setupFetcher.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync polling
  const pendingJobId = createFetcher.data?.jobId ?? null;
  const jobId        = pendingJobId ?? activeJob?.id ?? null;
  const polledStatus = statusFetcher.data?.status;
  const isRunning    = !!jobId && polledStatus !== "completed" && polledStatus !== "failed";

  useEffect(() => {
    if (!pendingJobId || triggeredJobRef.current === pendingJobId) return;
    triggeredJobRef.current = pendingJobId;
    triggerFetcher.submit({ jobId: pendingJobId }, { method: "post", action: "/api/bsale/sync" });
  }, [pendingJobId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!jobId) return;
    pollRef.current = setInterval(() => statusFetcher.load(`/api/sync/status?jobId=${jobId}`), 3000);
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [jobId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (polledStatus === "completed" || polledStatus === "failed") {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      revalidator.revalidate();
      // After first sync completes from step 4, exit wizard
      if (step === 4) setShowWizard(false);
    }
  }, [polledStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  const isSavingToken = tokenFetcher.state !== "idle";
  const isSavingSetup = setupFetcher.state !== "idle";

  const errorMsg =
    tokenFetcher.data?.error ??
    webhookFetcher.data?.error ??
    createFetcher.data?.error ??
    (polledStatus === "failed" ? "La sincronización falló. Revisa los logs." : null);

  const successMsg =
    tokenFetcher.data?.success ??
    webhookFetcher.data?.success ??
    createFetcher.data?.success;

  const progressLabel = statusFetcher.data?.records_processed
    ? ` — ${statusFetcher.data.records_processed} registros`
    : "";
  const runningType = statusFetcher.data?.type ?? activeJob?.type ?? null;

  // ── Handlers ──────────────────────────────────────────────────────────────

  function saveSetup(payload: { priceListId?: number; officeId?: number }) {
    setupFetcher.submit(JSON.stringify(payload), {
      method:   "POST",
      action:   "/api/bsale/setup",
      encType:  "application/json",
    });
  }

  // ── Render ────────────────────────────────────────────────────────────────

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

      {/* ── WIZARD ─────────────────────────────────────────────────────────── */}
      {showWizard && (
        <s-stack direction="block" gap="base">

          <WizardHeader
            step={step}
            onReset={isFullyConfigured ? () => setShowWizard(false) : undefined}
          />

          {/* ── Step 1: Token ────────────────────────────────────────────── */}
          {step === 1 && (
            <s-box padding="large" borderWidth="small" borderRadius="base" background="base">
              <s-stack direction="block" gap="base">
                <p style={HEADING_STYLE}>Access Token de Bsale</p>
                <s-text color="subdued">
                  Obtén tu token en Bsale → Configuración → API. Se guarda de forma
                  segura y nunca se expone al navegador.
                </s-text>
                {hasToken && (
                  <div>
                    <s-badge tone="success">Conectado ✓</s-badge>
                  </div>
                )}
                <tokenFetcher.Form method="post">
                  <input type="hidden" name="intent" value="save_token" />
                  <s-stack direction="block" gap="small">
                    <label style={{ display: "block" }}>
                      <span style={LABEL_STYLE}>Access Token</span>
                      <input
                        type="password"
                        name="bsale_token"
                        placeholder={hasToken ? "••••••••••••••••••••" : "Pega aquí tu access token"}
                        style={INPUT_STYLE}
                        required
                      />
                    </label>
                    <s-button
                      type="submit"
                      variant="primary"
                      {...(isSavingToken ? { loading: true } : {})}
                    >
                      {hasToken ? "Actualizar y continuar →" : "Guardar y continuar →"}
                    </s-button>
                    {hasToken && (
                      <s-button variant="secondary" onClick={() => setStep(2)}>
                        Continuar sin cambiar token →
                      </s-button>
                    )}
                  </s-stack>
                </tokenFetcher.Form>
              </s-stack>
            </s-box>
          )}

          {/* ── Step 2: Price list ───────────────────────────────────────── */}
          {step === 2 && (
            <s-box padding="large" borderWidth="small" borderRadius="base" background="base">
              <s-stack direction="block" gap="base">
                <p style={HEADING_STYLE}>Lista de precios de venta</p>
                <s-text color="subdued">
                  Los precios de venta se tomarán de esta lista al sincronizar con Shopify.
                </s-text>

                {priceLists.length === 0 ? (
                  <s-banner tone="warning" heading="No se encontraron listas de precio activas en Bsale. Verifica tu token." />
                ) : (
                  <s-stack direction="block" gap="small">
                    <label style={{ display: "block" }}>
                      <span style={LABEL_STYLE}>Lista de precios</span>
                      <select
                        value={selectedPriceListId}
                        onChange={(e) => setSelectedPriceListId(e.target.value ? Number(e.target.value) : "")}
                        style={SELECT_STYLE}
                      >
                        <option value="">Seleccionar lista…</option>
                        {priceLists.map((pl) => (
                          <option key={pl.id} value={pl.id}>
                            {pl.name} ({pl.currency})
                          </option>
                        ))}
                      </select>
                    </label>
                    <s-button
                      variant="primary"
                      onClick={() => {
                        if (!selectedPriceListId) return;
                        saveSetup({ priceListId: selectedPriceListId });
                      }}
                      {...(isSavingSetup ? { loading: true } : {})}
                      {...(!selectedPriceListId ? { disabled: true } : {})}
                    >
                      Continuar →
                    </s-button>
                  </s-stack>
                )}

                <s-button variant="tertiary" onClick={() => setStep(1)}>
                  ← Atrás
                </s-button>
              </s-stack>
            </s-box>
          )}

          {/* ── Step 3: Office ───────────────────────────────────────────── */}
          {step === 3 && (
            <s-box padding="large" borderWidth="small" borderRadius="base" background="base">
              <s-stack direction="block" gap="base">
                <p style={HEADING_STYLE}>Sucursal online</p>
                <s-text color="subdued">
                  ¿Desde qué sucursal se descuenta el stock al vender online?
                </s-text>

                {offices.length === 0 ? (
                  <s-banner tone="warning" heading="No se encontraron sucursales activas en Bsale." />
                ) : (
                  <s-stack direction="block" gap="small">
                    <label style={{ display: "block" }}>
                      <span style={LABEL_STYLE}>Sucursal</span>
                      <select
                        value={selectedOfficeId}
                        onChange={(e) => setSelectedOfficeId(e.target.value ? Number(e.target.value) : "")}
                        style={SELECT_STYLE}
                      >
                        <option value="">Seleccionar sucursal…</option>
                        {offices.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.name}{o.address ? ` — ${o.address}` : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    <s-button
                      variant="primary"
                      onClick={() => {
                        if (!selectedOfficeId) return;
                        saveSetup({ officeId: selectedOfficeId });
                      }}
                      {...(isSavingSetup ? { loading: true } : {})}
                      {...(!selectedOfficeId ? { disabled: true } : {})}
                    >
                      Continuar →
                    </s-button>
                  </s-stack>
                )}

                <s-button variant="tertiary" onClick={() => setStep(2)}>
                  ← Atrás
                </s-button>
              </s-stack>
            </s-box>
          )}

          {/* ── Step 4: Confirm + sync ───────────────────────────────────── */}
          {step === 4 && (
            <s-box padding="large" borderWidth="small" borderRadius="base" background="base">
              <s-stack direction="block" gap="base">
                <p style={HEADING_STYLE}>¡Todo listo! Confirma y sincroniza</p>

                {/* Summary */}
                <div
                  style={{
                    background:   "var(--p-color-bg-surface-secondary, #f6f6f7)",
                    borderRadius: "var(--p-border-radius-200, 8px)",
                    padding:      "16px",
                  }}
                >
                  <s-stack direction="block" gap="small">
                    <div style={{ display: "flex", gap: 8 }}>
                      <span style={{ minWidth: 140, color: "var(--p-color-text-subdued, #6d7175)", fontSize: "var(--p-font-size-350, 0.875rem)" }}>Lista de precios:</span>
                      <s-text>
                        {priceLists.find((pl) => pl.id === (selectedPriceListId || priceListId))?.name ?? `ID ${selectedPriceListId || priceListId}`}
                      </s-text>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <span style={{ minWidth: 140, color: "var(--p-color-text-subdued, #6d7175)", fontSize: "var(--p-font-size-350, 0.875rem)" }}>Sucursal online:</span>
                      <s-text>
                        {offices.find((o) => o.id === (selectedOfficeId || officeId))?.name ?? `ID ${selectedOfficeId || officeId}`}
                      </s-text>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <span style={{ minWidth: 140, color: "var(--p-color-text-subdued, #6d7175)", fontSize: "var(--p-font-size-350, 0.875rem)" }}>Webhook:</span>
                      <s-badge tone="success">Registrado ✓</s-badge>
                    </div>
                  </s-stack>
                </div>

                {isRunning && (
                  <s-banner tone="info">
                    <s-stack direction="inline" gap="small">
                      <s-spinner />
                      <s-text>Sincronizando {jobTypeLabel(runningType)}{progressLabel}…</s-text>
                    </s-stack>
                  </s-banner>
                )}

                <s-stack direction="inline" gap="small">
                  <createFetcher.Form method="post">
                    <input type="hidden" name="intent" value="sync_products" />
                    <s-button
                      type="submit"
                      variant="primary"
                      {...(isRunning || createFetcher.state !== "idle" ? { loading: true } : {})}
                    >
                      Sincronizar ahora
                    </s-button>
                  </createFetcher.Form>
                  <s-button variant="secondary" onClick={() => setShowWizard(false)}>
                    Omitir por ahora
                  </s-button>
                </s-stack>
              </s-stack>
            </s-box>
          )}

        </s-stack>
      )}

      {/* ── EXISTING UI (shown when wizard is dismissed or fully configured) ── */}
      {!showWizard && (
        <>
          {/* Status strip */}
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
                      fontSize:   "var(--p-font-size-350, 0.875rem)",
                      fontWeight: "var(--p-font-weight-semibold, 600)" as React.CSSProperties["fontWeight"],
                      color:      "var(--p-color-text, inherit)",
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

          {/* Config + Sync */}
          <s-section>
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">

              {/* Token + change config */}
              <s-box padding="large" borderWidth="small" borderRadius="base" background="base">
                <s-stack direction="block" gap="base">
                  <p style={HEADING_STYLE}>Configuración</p>
                  <s-stack direction="block" gap="small">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <s-text color="subdued">Token</s-text>
                      <s-badge tone="success">Guardado ✓</s-badge>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <s-text color="subdued">Lista de precios</s-text>
                      {hasPriceList
                        ? <s-badge tone="success">{priceLists.find((pl) => pl.id === priceListId)?.name ?? `ID ${priceListId}`}</s-badge>
                        : <s-badge tone="warning">Sin configurar</s-badge>}
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <s-text color="subdued">Sucursal online</s-text>
                      {hasOffice
                        ? <s-badge tone="success">{offices.find((o) => o.id === officeId)?.name ?? `ID ${officeId}`}</s-badge>
                        : <s-badge tone="warning">Sin configurar</s-badge>}
                    </div>
                  </s-stack>
                  <s-button
                    variant="secondary"
                    onClick={() => { setStep(1); setShowWizard(true); }}
                  >
                    Cambiar configuración
                  </s-button>
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
                </s-stack>
              </s-box>

              {/* Sync actions */}
              <s-box padding="large" borderWidth="small" borderRadius="base" background="base">
                <s-stack direction="block" gap="base">
                  <p style={HEADING_STYLE}>Sincronización manual</p>

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
                    <s-text color="subdued">Importa el catálogo de variantes desde Bsale con precios de la lista configurada.</s-text>
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
                        <s-button variant="secondary" onClick={() => navigate("/app/integrations/bsale/diff")}>
                          Revisar diff →
                        </s-button>
                      )}
                    </s-stack>
                  </s-stack>

                  <div style={{ height: "1px", background: "var(--p-color-border, #e1e3e5)" }} />

                  <s-stack direction="block" gap="small">
                    <s-text type="strong">Stock</s-text>
                    <s-text color="subdued">Actualiza los niveles de inventario por sucursal.</s-text>
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

          {/* Boleta electrónica */}
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
                            <a href={doc.url_pdf} target="_blank" rel="noreferrer"
                              style={{ color: "var(--p-color-text-emphasis, #005bd3)" }}>
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
        </>
      )}

    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
