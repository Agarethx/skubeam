import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import type { StockSyncResult, StockSyncItemDetail } from "../integrations/bsale/stocks.server";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useEffect, useRef, useState } from "react";

type StockSyncPayload = StockSyncResult;
import { useSkuBeamNavigate } from "../lib/navigate";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate, registerWebhooks } from "../shopify.server";
import { supabaseAdmin } from "../db.server";
import {
  createBsaleJob,
  getActiveBsaleJob,
} from "../integrations/bsale/jobs.server";
import {
  registerBsaleWebhook,
  getPriceLists,
  getOffices,
  getDocumentTypes,
  type BsalePriceListOption,
  type BsaleOfficeOption,
  type BsaleDocumentTypeOption,
} from "../integrations/bsale/client.server";
import {
  getActiveSyncJobByType,
  getLastCompletedSyncJob,
  startBulkSync,
} from "../models/sync.server";
import type { ProductSyncSummary } from "../models/sync.server";
import type { Tables } from "../types/supabase";

type SyncJob = Tables<"sync_jobs">;

// ── Loader ────────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  const [shopRow, activeJob, recentBoletas, lastStockJob, activeProductSyncJob, lastProductSyncJob] = await Promise.all([
    supabaseAdmin
      .from("shops")
      .select("bsale_token, bsale_last_sync, active_addons, bsale_price_list_id, bsale_office_id, bsale_document_type_id, bsale_document_code_sii")
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
    supabaseAdmin
      .from("sync_jobs")
      .select("id, records_processed, completed_at, payload")
      .eq("shop_id", shopId)
      .eq("type", "bsale_stock")
      .eq("status", "completed")
      .order("completed_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => data),
    getActiveSyncJobByType(shopId, "full_product_sync"),
    getLastCompletedSyncJob(shopId, "full_product_sync"),
  ]);

  const hasToken     = !!shopRow?.bsale_token;
  const hasPriceList = !!shopRow?.bsale_price_list_id;
  const hasOffice    = !!shopRow?.bsale_office_id;
  const hasAddon     = shopRow?.active_addons?.includes("bsale_documents") ?? false;

  // Always load price lists + offices when the token exists
  // (needed both for wizard and for "Cambiar configuración" flow)
  const [priceLists, offices, documentTypes]: [BsalePriceListOption[], BsaleOfficeOption[], BsaleDocumentTypeOption[]] = hasToken
    ? await Promise.all([
        getPriceLists(shopRow!.bsale_token!),
        getOffices(shopRow!.bsale_token!),
        getDocumentTypes(shopRow!.bsale_token!),
      ])
    : [[], [], []];

  const isFullyConfigured = hasToken && hasPriceList && hasOffice;

  return {
    hasToken,
    hasPriceList,
    hasOffice,
    isFullyConfigured,
    priceListId:    shopRow?.bsale_price_list_id ?? null,
    officeId:       shopRow?.bsale_office_id ?? null,
    documentTypeId: shopRow?.bsale_document_type_id ?? null,
    documentCodeSii: shopRow?.bsale_document_code_sii ?? null,
    bsaleLastSync:  shopRow?.bsale_last_sync ?? null,
    activeJob,
    hasAddon,
    recentBoletas,
    priceLists,
    offices,
    documentTypes,
    lastStockSync:  lastStockJob?.payload as StockSyncPayload | null ?? null,
    lastStockSyncAt: lastStockJob?.completed_at ?? null,
    activeProductSyncJob: activeProductSyncJob as SyncJob | null,
    lastProductSync: lastProductSyncJob
      ? {
          completedAt:      lastProductSyncJob.completed_at,
          recordsProcessed: lastProductSyncJob.records_processed ?? 0,
          summary: (lastProductSyncJob.payload as ProductSyncSummary | null) ?? null,
        }
      : null,
  };
};

// ── Action ────────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shopId = session.shop;

  const formData = await request.formData();
  const intent   = formData.get("intent") as string;

  if (intent === "sync_shopify_products") {
    try {
      const job = await startBulkSync(admin, shopId);
      return { jobId: job.id, jobType: "full_product_sync" as const };
    } catch (err) {
      return { error: `No se pudo iniciar la sincronización con Shopify: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

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
      if (reg.skipped) {
        return { success: "Token guardado. Webhook Bsale ya estaba registrado.", tokenSaved: true };
      }
      if (!reg.ok) {
        const manualUrl = `${appUrl}/webhooks/bsale/document?shop=${shopId}`;
        return { success: `Token guardado. Registro automático no disponible — registra manualmente en Bsale → Configuración → Webhooks: ${manualUrl}`, tokenSaved: true };
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
    const appUrl = process.env.APP_URL ?? process.env.SHOPIFY_APP_URL ?? "";
    if (!appUrl) return { error: "APP_URL no está configurado en el entorno." };
    const webhookUrl = `${appUrl}/webhooks/bsale/document?shop=${shopId}`;
    const reg = await registerBsaleWebhook(token, webhookUrl);
    if (!reg.ok) return { error: `Registro automático no disponible en este plan de Bsale. Regístralo manualmente en Bsale → Configuración → Webhooks apuntando a: ${webhookUrl}` };
    if (reg.skipped) return { success: "El webhook ya estaba registrado." };
    return { success: `Webhook registrado (id: ${reg.id}). URL: ${webhookUrl}` };
  }

  if (intent === "reregister_shopify_webhooks") {
    try {
      const { session } = await authenticate.admin(request);
      console.log("[bsale-ui] Re-registrando webhooks Shopify para session:", session.shop);
      await registerWebhooks({ session });
      console.log("[bsale-ui] Webhooks Shopify re-registrados OK");
      const appUrl = process.env.SHOPIFY_APP_URL ?? process.env.APP_URL ?? "(desconocida)";
      return { success: `Webhooks Shopify re-registrados. URL activa: ${appUrl}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[bsale-ui] Error re-registrando webhooks:", msg);
      return { error: `Error re-registrando webhooks: ${msg}` };
    }
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

  if (intent === "toggle_addon") {
    const { data: currentShop } = await supabaseAdmin
      .from("shops")
      .select("active_addons")
      .eq("shop_id", shopId)
      .single();

    const current = currentShop?.active_addons ?? [];
    const hasIt   = current.includes("bsale_documents");
    const updated = hasIt
      ? current.filter((a: string) => a !== "bsale_documents")
      : [...current, "bsale_documents"];

    await supabaseAdmin
      .from("shops")
      .update({ active_addons: updated })
      .eq("shop_id", shopId);

    return { success: hasIt ? "Nota de Venta automática desactivada." : "Nota de Venta automática activada." };
  }

  if (intent === "save_document_type") {
    const documentTypeId = formData.get("documentTypeId");
    const codeSii        = formData.get("codeSii");

    await supabaseAdmin
      .from("shops")
      .update({
        bsale_document_type_id:  documentTypeId ? Number(documentTypeId) : null,
        bsale_document_code_sii: codeSii ? Number(codeSii) : null,
      })
      .eq("shop_id", shopId);

    return { success: "Tipo de documento guardado." };
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
  if (type === "bsale_products") return "precios (Bsale)";
  if (type === "bsale_stock")    return "stock (Bsale)";
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

// ── Shared table primitives ───────────────────────────────────────────────────

const TH_STYLE: React.CSSProperties = {
  padding:       "8px 12px",
  background:    "var(--p-color-bg-surface-secondary, #f6f6f7)",
  borderBottom:  "1px solid var(--p-color-border, #e1e3e5)",
  fontSize:      "var(--p-font-size-300, 0.75rem)",
  fontWeight:    600,
  color:         "var(--p-color-text-subdued, #6d7175)",
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
  textAlign:     "left" as const,
};

const TD_STYLE: React.CSSProperties = {
  padding:  "10px 12px",
  fontSize: "var(--p-font-size-350, 0.875rem)",
  verticalAlign: "middle",
};

function SimpleTable({ cols, rows }: { cols: string[]; rows: React.ReactNode[][] }) {
  return (
    <div style={{ border: "1px solid var(--p-color-border, #e1e3e5)", borderRadius: "var(--p-border-radius-200, 8px)", overflow: "hidden" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>{cols.map((c) => <th key={c} style={TH_STYLE}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} style={{ background: ri % 2 === 0 ? "var(--p-color-bg-surface, #fff)" : "var(--p-color-bg-surface-secondary, #f6f6f7)" }}>
              {row.map((cell, ci) => (
                <td key={ci} style={{ ...TD_STYLE, borderBottom: ri < rows.length - 1 ? "1px solid var(--p-color-border-subdued, #e1e3e5)" : "none" }}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const PAGE_SIZE_DETAIL  = 20;
const PAGE_SIZE_SKIPPED = 25;

function SkippedTable({
  items,
}: {
  items: Array<{ sku_code: string; title: string | null }>;
}) {
  const [open, setOpen]   = useState(false);
  const [page, setPage]   = useState(1);
  const totalPages        = Math.ceil(items.length / PAGE_SIZE_SKIPPED);
  const slice             = items.slice((page - 1) * PAGE_SIZE_SKIPPED, page * PAGE_SIZE_SKIPPED);

  return (
    <s-box padding="base" borderWidth="small" borderRadius="base" background="base">
      <s-stack direction="block" gap="small">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <p style={{ ...HEADING_STYLE, color: "var(--p-color-text-caution, #b98900)" }}>
              SKUs no encontrados en Bsale
            </p>
            <s-badge tone="warning">{items.length}</s-badge>
          </div>
          <s-button variant="tertiary" onClick={() => setOpen((v) => !v)}>
            {open ? "Ocultar ▲" : "Ver listado ▼"}
          </s-button>
        </div>

        {open && (
          <>
            <s-text color="subdued">
              Estos productos existen en Shopify pero no tienen un código coincidente en Bsale.
              Su stock no fue actualizado. Revisa que el SKU en Shopify coincida exactamente con el código de variante en Bsale.
            </s-text>

            <SimpleTable
              cols={["SKU (Shopify)", "Título"]}
              rows={slice.map((item) => [
                <span key="sku" style={{ fontFamily: "monospace", fontWeight: 600 }}>{item.sku_code}</span>,
                <span key="title" style={{ color: "var(--p-color-text-subdued, #6d7175)" }}>{item.title ?? "—"}</span>,
              ])}
            />

            {totalPages > 1 && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 8 }}>
                <s-text color="subdued">
                  {(page - 1) * PAGE_SIZE_SKIPPED + 1}–{Math.min(page * PAGE_SIZE_SKIPPED, items.length)} de {items.length}
                </s-text>
                <div style={{ display: "flex", gap: 8 }}>
                  <s-button
                    variant="tertiary"
                    {...(page <= 1 ? { disabled: true } : {})}
                    onClick={(e: Event) => { e.stopPropagation(); setPage(page - 1); }}
                  >
                    ← Anterior
                  </s-button>
                  <s-button
                    variant="tertiary"
                    {...(page >= totalPages ? { disabled: true } : {})}
                    onClick={(e: Event) => { e.stopPropagation(); setPage(page + 1); }}
                  >
                    Siguiente →
                  </s-button>
                </div>
              </div>
            )}
          </>
        )}
      </s-stack>
    </s-box>
  );
}

function StockDetailTable({
  items,
  page,
  onPageChange,
}: {
  items:        StockSyncItemDetail[];
  page:         number;
  onPageChange: (p: number) => void;
}) {
  const totalPages = Math.ceil(items.length / PAGE_SIZE_DETAIL);
  const slice      = items.slice((page - 1) * PAGE_SIZE_DETAIL, page * PAGE_SIZE_DETAIL);

  const changedCount   = items.filter((i) => i.changed).length;
  const unchangedCount = items.length - changedCount;

  return (
    <div style={{ marginBottom: 16 }}>
      <s-box padding="base" borderWidth="small" borderRadius="base" background="base">
        <s-stack direction="block" gap="small">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <p style={HEADING_STYLE}>Detalle por SKU</p>
            <div style={{ display: "flex", gap: 8 }}>
              {changedCount > 0   && <s-badge tone="success">{changedCount} actualizados</s-badge>}
              {unchangedCount > 0 && <s-badge tone="neutral">{unchangedCount} sin cambio</s-badge>}
            </div>
          </div>

          <SimpleTable
            cols={["SKU", "Título", "Stock Shopify", "Stock Bsale", "Cambio"]}
            rows={slice.map((item) => {
              const diff    = item.qty_after - item.qty_before;
              const diffStr = diff > 0 ? `+${diff}` : String(diff);
              const diffColor = diff > 0
                ? "var(--p-color-text-success, #008060)"
                : diff < 0
                ? "var(--p-color-text-critical, #d72c0d)"
                : "var(--p-color-text-subdued, #6d7175)";

              return [
                <span key="sku"    style={{ fontFamily: "monospace", fontWeight: 600 }}>{item.sku_code}</span>,
                <span key="title"  style={{ color: "var(--p-color-text-subdued, #6d7175)" }}>{item.title ?? "—"}</span>,
                <span key="before" style={{ textAlign: "right" as const, display: "block" }}>{item.qty_before.toLocaleString("es-CL")}</span>,
                <span key="after"  style={{ textAlign: "right" as const, display: "block", fontWeight: item.changed ? 600 : 400 }}>
                  {item.qty_after.toLocaleString("es-CL")}
                </span>,
                <span key="diff"   style={{ color: diffColor, fontWeight: 600, textAlign: "right" as const, display: "block" }}>
                  {diff === 0 ? "—" : diffStr}
                </span>,
              ];
            })}
          />

          {/* Pagination */}
          {totalPages > 1 && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 8 }}>
              <s-text color="subdued">
                {(page - 1) * PAGE_SIZE_DETAIL + 1}–{Math.min(page * PAGE_SIZE_DETAIL, items.length)} de {items.length} SKUs
              </s-text>
              <div style={{ display: "flex", gap: 8 }}>
                <s-button
                  variant="tertiary"
                  {...(page <= 1 ? { disabled: true } : {})}
                  onClick={() => onPageChange(page - 1)}
                >
                  ← Anterior
                </s-button>
                <s-button
                  variant="tertiary"
                  {...(page >= totalPages ? { disabled: true } : {})}
                  onClick={() => onPageChange(page + 1)}
                >
                  Siguiente →
                </s-button>
              </div>
            </div>
          )}
        </s-stack>
      </s-box>
    </div>
  );
}

// ── Product-sync issue tables (duplicados / sin SKU / otros errores) ─────────

type SkuSyncIssue = {
  shopify_variant_id: number;
  product_title: string;
  variant_title: string | null;
  sku_code?: string;
  reason: "no_sku" | "duplicate_sku" | "other_error";
  detail?: string;
  conflicts_with_title?: string;
};

function ProductSyncIssuesTable({
  heading,
  helpText,
  tone,
  items,
  cols,
  rowOf,
}: {
  heading:  string;
  helpText: string;
  tone:     "warning" | "critical";
  items:    SkuSyncIssue[];
  cols:     string[];
  rowOf:    (item: SkuSyncIssue) => React.ReactNode[];
}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const totalPages       = Math.ceil(items.length / PAGE_SIZE_SKIPPED);
  const slice            = items.slice((page - 1) * PAGE_SIZE_SKIPPED, page * PAGE_SIZE_SKIPPED);
  const color = tone === "critical" ? "var(--p-color-text-critical, #d72c0d)" : "var(--p-color-text-caution, #b98900)";

  return (
    <s-box padding="base" borderWidth="small" borderRadius="base" background="base">
      <s-stack direction="block" gap="small">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <p style={{ ...HEADING_STYLE, color }}>{heading}</p>
            <s-badge tone={tone}>{items.length}</s-badge>
          </div>
          <s-button variant="tertiary" onClick={() => setOpen((v) => !v)}>
            {open ? "Ocultar ▲" : "Ver listado ▼"}
          </s-button>
        </div>

        {open && (
          <>
            <s-text color="subdued">{helpText}</s-text>
            <SimpleTable cols={cols} rows={slice.map(rowOf)} />
            {totalPages > 1 && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 8 }}>
                <s-text color="subdued">
                  {(page - 1) * PAGE_SIZE_SKIPPED + 1}–{Math.min(page * PAGE_SIZE_SKIPPED, items.length)} de {items.length}
                </s-text>
                <div style={{ display: "flex", gap: 8 }}>
                  <s-button variant="tertiary" {...(page <= 1 ? { disabled: true } : {})} onClick={() => setPage(page - 1)}>← Anterior</s-button>
                  <s-button variant="tertiary" {...(page >= totalPages ? { disabled: true } : {})} onClick={() => setPage(page + 1)}>Siguiente →</s-button>
                </div>
              </div>
            )}
          </>
        )}
      </s-stack>
    </s-box>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function BsaleIntegrationPage() {
  const {
    hasToken, hasPriceList, hasOffice, isFullyConfigured,
    priceListId, officeId, documentTypeId, documentCodeSii,
    bsaleLastSync, activeJob, hasAddon, recentBoletas,
    priceLists, offices, documentTypes,
    lastStockSync, lastStockSyncAt,
    activeProductSyncJob, lastProductSync,
  } = useLoaderData<typeof loader>();

  const revalidator = useRevalidator();
  const navigate    = useSkuBeamNavigate();

  // Wizard state — start from DB state; "Cambiar configuración" resets to 1
  const initialStep: 1 | 2 | 3 | 4 = !hasToken ? 1 : !hasPriceList ? 2 : !hasOffice ? 3 : 4;
  const [showWizard, setShowWizard] = useState(!isFullyConfigured);
  const [step, setStep]             = useState<1 | 2 | 3 | 4>(initialStep);

  // Local selections for steps 2 + 3 and document type
  const [selectedPriceListId,  setSelectedPriceListId]  = useState<number | "">(priceListId ?? "");
  const [selectedOfficeId,     setSelectedOfficeId]     = useState<number | "">(officeId ?? "");
  const [selectedDocTypeId,    setSelectedDocTypeId]    = useState<number | "">(documentTypeId ?? "");
  const [stockDetailPage,      setStockDetailPage]      = useState(1);
  const [stockSearch,          setStockSearch]          = useState("");

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

  // ── Shopify product sync (bulk operation) — separate poll target: /api/sync
  // advances Shopify's own async bulk op, unlike the jobId-based Bsale polling above.
  const productSyncFetcher     = useFetcher<{ jobId?: string; jobType?: "full_product_sync"; error?: string }>();
  const productSyncPollFetcher = useFetcher<{ job: SyncJob | null }>();
  const productSyncPollRef     = useRef<ReturnType<typeof setInterval> | null>(null);

  // trackedJobId is the only source of truth for "we just kicked off a sync and
  // haven't yet confirmed it finished" — it's explicitly cleared on a terminal
  // status so the spinner can't get stuck forever (fetcher.data persists across
  // revalidations, so ORing against it directly never turns back false).
  const [trackedJobId, setTrackedJobId] = useState<string | null>(null);

  useEffect(() => {
    if (productSyncFetcher.data?.jobId) setTrackedJobId(productSyncFetcher.data.jobId);
  }, [productSyncFetcher.data]);

  const polledProductSyncJob = productSyncPollFetcher.data?.job ?? (trackedJobId ? null : activeProductSyncJob);
  const isProductSyncRunning = trackedJobId
    ? !polledProductSyncJob || polledProductSyncJob.status === "running" || polledProductSyncJob.status === "pending"
    : !!activeProductSyncJob && (activeProductSyncJob.status === "running" || activeProductSyncJob.status === "pending");

  useEffect(() => {
    if (!isProductSyncRunning) return;
    productSyncPollRef.current = setInterval(() => productSyncPollFetcher.load("/api/sync"), 5000);
    return () => { if (productSyncPollRef.current) { clearInterval(productSyncPollRef.current); productSyncPollRef.current = null; } };
  }, [isProductSyncRunning]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const s = productSyncPollFetcher.data?.job?.status;
    if (s === "completed" || s === "failed" || s === "cancelled") {
      if (productSyncPollRef.current) { clearInterval(productSyncPollRef.current); productSyncPollRef.current = null; }
      setTrackedJobId(null);
      revalidator.revalidate();
    }
  }, [productSyncPollFetcher.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const productSyncProgress = polledProductSyncJob?.records_processed
    ? ` (${polledProductSyncJob.records_processed} procesados)`
    : "";

  const isSavingToken = tokenFetcher.state !== "idle";
  const isSavingSetup = setupFetcher.state !== "idle";

  const errorMsg =
    tokenFetcher.data?.error ??
    webhookFetcher.data?.error ??
    createFetcher.data?.error ??
    productSyncFetcher.data?.error ??
    (polledStatus === "failed" ? "La sincronización falló. Revisa los logs." : null) ??
    (polledProductSyncJob?.status === "failed"
      ? `Sincronización de productos Shopify falló: ${polledProductSyncJob.error_message ?? "error desconocido"}`
      : null);

  const successMsg =
    tokenFetcher.data?.success ??
    webhookFetcher.data?.success ??
    createFetcher.data?.success;

  const progressLabel = statusFetcher.data?.records_processed
    ? ` — ${statusFetcher.data.records_processed} registros`
    : "";
  const runningType = statusFetcher.data?.type ?? activeJob?.type ?? null;

  // ── Handlers ──────────────────────────────────────────────────────────────

  function saveSetup(payload: { priceListId?: number; officeId?: number; documentTypeId?: number | null; codeSii?: number | null }) {
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
                      Re-registrar webhook Bsale
                    </s-button>
                  </webhookFetcher.Form>
                  <webhookFetcher.Form method="post">
                    <input type="hidden" name="intent" value="reregister_shopify_webhooks" />
                    <s-button
                      type="submit"
                      variant="tertiary"
                      {...(webhookFetcher.state !== "idle" ? { loading: true } : {})}
                    >
                      Re-registrar webhooks Shopify
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

                  {isProductSyncRunning && (
                    <s-banner tone="info">
                      <s-stack direction="inline" gap="small">
                        <s-spinner />
                        <s-text>Sincronizando catálogo desde Shopify{productSyncProgress}… puede tardar varios minutos.</s-text>
                      </s-stack>
                    </s-banner>
                  )}

                  <s-stack direction="block" gap="small">
                    <s-text type="strong">Productos (Shopify)</s-text>
                    <s-text color="subdued">
                      Trae el catálogo completo desde Shopify — SKU, título, vendor, costo. Ejecuta esto primero:
                      el conteo de SkuBeam debe cuadrar con el total de variantes de Shopify antes de sincronizar precios/stock con Bsale.
                    </s-text>
                    <productSyncFetcher.Form method="post">
                      <input type="hidden" name="intent" value="sync_shopify_products" />
                      <s-button
                        type="submit"
                        variant="primary"
                        {...(isProductSyncRunning || productSyncFetcher.state !== "idle" ? { loading: true, disabled: true } : {})}
                      >
                        Sincronizar productos
                      </s-button>
                    </productSyncFetcher.Form>
                  </s-stack>

                  <div style={{ height: "1px", background: "var(--p-color-border, #e1e3e5)" }} />

                  <s-stack direction="block" gap="small">
                    <s-text type="strong">Precios (Bsale)</s-text>
                    <s-text color="subdued">Importa el catálogo de variantes desde Bsale con precios de la lista configurada.</s-text>
                    <s-stack direction="inline" gap="small">
                      <createFetcher.Form method="post">
                        <input type="hidden" name="intent" value="sync_products" />
                        <s-button
                          type="submit"
                          {...(isRunning || createFetcher.state !== "idle" ? { loading: true } : {})}
                          {...(!hasToken ? { disabled: true } : {})}
                        >
                          Sincronizar precios
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
                    <s-text type="strong">Stock (Bsale)</s-text>
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

          {/* ── Última sincronización de productos (Shopify) ─────────────── */}
          {lastProductSync && (() => {
            const summary   = lastProductSync.summary;
            const total     = summary?.records_total ?? lastProductSync.recordsProcessed;
            const skipped   = (summary?.skipped ?? []) as SkuSyncIssue[];
            const duplicates = skipped.filter((s) => s.reason === "duplicate_sku");
            const noSku      = skipped.filter((s) => s.reason === "no_sku");
            const others     = skipped.filter((s) => s.reason === "other_error");
            const allSquare  = skipped.length === 0 && total === lastProductSync.recordsProcessed;

            return (
              <s-section heading="Última sincronización de productos (Shopify)">
                <s-stack direction="block" gap="base">
                  <s-grid gridTemplateColumns="repeat(auto-fit, minmax(140px, 1fr))" gap="base">
                    {(
                      [
                        { label: "Variantes en Shopify", value: total, tone: undefined },
                        { label: "Sincronizados",         value: lastProductSync.recordsProcessed, tone: "success" as const },
                        { label: "Duplicados",            value: duplicates.length, tone: duplicates.length > 0 ? "warning" as const : undefined },
                        { label: "Sin SKU",                value: noSku.length,      tone: noSku.length > 0 ? "warning" as const : undefined },
                        { label: "Otros errores",         value: others.length,     tone: others.length > 0 ? "critical" as const : undefined },
                      ] as Array<{ label: string; value: number; tone?: "success" | "warning" | "critical" }>
                    ).map(({ label, value, tone }) => (
                      <s-box key={label} padding="base" borderWidth="small" borderRadius="base" background="base">
                        <s-stack direction="block" gap="small">
                          <s-text color="subdued">{label}</s-text>
                          {tone
                            ? <s-badge tone={tone}>{value.toLocaleString("es-CL")}</s-badge>
                            : <p style={{ margin: 0, fontWeight: 600, fontSize: "var(--p-font-size-500, 1.25rem)" }}>{value.toLocaleString("es-CL")}</p>
                          }
                        </s-stack>
                      </s-box>
                    ))}
                  </s-grid>

                  <s-text color="subdued">Ejecutado: {formatDate(lastProductSync.completedAt)}</s-text>

                  {allSquare ? (
                    <s-banner tone="success" heading={`Todo cuadra: ${total} de ${total} variantes de Shopify están en SkuBeam.`} />
                  ) : (
                    <s-banner
                      tone="warning"
                      heading={`${lastProductSync.recordsProcessed} de ${total} variantes sincronizadas — ${skipped.length} quedaron fuera, revisa el detalle abajo.`}
                    />
                  )}

                  {duplicates.length > 0 && (
                    <ProductSyncIssuesTable
                      heading="SKUs duplicados en Shopify"
                      tone="warning"
                      helpText="Dos o más variantes de productos distintos comparten el mismo código SKU. SkuBeam solo puede guardar una — corrige el código duplicado en Shopify (asigna uno único a cada variante) y vuelve a sincronizar."
                      items={duplicates}
                      cols={["SKU", "Producto sin sincronizar", "Ya sincronizado como"]}
                      rowOf={(item) => [
                        <span key="sku" style={{ fontFamily: "monospace", fontWeight: 600 }}>{item.sku_code}</span>,
                        <span key="p">{item.product_title}</span>,
                        <span key="c" style={{ color: "var(--p-color-text-subdued, #6d7175)" }}>{item.conflicts_with_title ?? "—"}</span>,
                      ]}
                    />
                  )}

                  {noSku.length > 0 && (
                    <ProductSyncIssuesTable
                      heading="Productos sin SKU en Shopify"
                      tone="warning"
                      helpText="Estas variantes existen en Shopify pero no tienen ningún código SKU asignado, así que SkuBeam no puede sincronizarlas. Asígnales un código en Shopify y vuelve a sincronizar."
                      items={noSku}
                      cols={["Producto", "Variante"]}
                      rowOf={(item) => [
                        <span key="p">{item.product_title}</span>,
                        <span key="v" style={{ color: "var(--p-color-text-subdued, #6d7175)" }}>{item.variant_title ?? "—"}</span>,
                      ]}
                    />
                  )}

                  {others.length > 0 && (
                    <ProductSyncIssuesTable
                      heading="Errores inesperados al guardar"
                      tone="critical"
                      helpText="Estas variantes tienen SKU en Shopify pero SkuBeam no pudo guardarlas por un error de base de datos. Revisa el detalle o contacta soporte si persiste."
                      items={others}
                      cols={["SKU", "Producto", "Error"]}
                      rowOf={(item) => [
                        <span key="sku" style={{ fontFamily: "monospace", fontWeight: 600 }}>{item.sku_code ?? "—"}</span>,
                        <span key="p">{item.product_title}</span>,
                        <span key="e" style={{ color: "var(--p-color-text-critical, #d72c0d)", fontSize: "var(--p-font-size-300, 0.75rem)" }}>{item.detail}</span>,
                      ]}
                    />
                  )}
                </s-stack>
              </s-section>
            );
          })()}

          {/* ── Último sync de stock ─────────────────────────────────────── */}
          {lastStockSync && (
            <s-section heading="Último sync de stock">
              {/* Stats row */}
              <s-grid gridTemplateColumns="repeat(auto-fit, minmax(140px, 1fr))" gap="base">
                {(
                  [
                    { label: "SKUs en SkuBeam",    value: lastStockSync.total_bsale_sku_codes, tone: undefined },
                    { label: "Matcheados con Bsale", value: lastStockSync.shopify_matched,     tone: "success" as const },
                    { label: "No en Bsale",        value: lastStockSync.skipped,               tone: lastStockSync.skipped > 0 ? "warning" as const : undefined },
                    { label: "Sync Shopify",       value: lastStockSync.shopify_updated ?? 0,  tone: (lastStockSync.shopify_updated ?? 0) > 0 ? "success" as const : undefined },
                    { label: "Con error",          value: lastStockSync.errors,                tone: lastStockSync.errors > 0 ? "critical" as const : undefined },
                    { label: "Error en Shopify",   value: (lastStockSync.shopify_push_errors ?? []).length, tone: (lastStockSync.shopify_push_errors ?? []).length > 0 ? "critical" as const : undefined },
                  ] as Array<{ label: string; value: number; tone?: "success" | "warning" | "critical" }>
                ).map(({ label, value, tone }) => (
                  <s-box key={label} padding="base" borderWidth="small" borderRadius="base" background="base">
                    <s-stack direction="block" gap="small">
                      <s-text color="subdued">{label}</s-text>
                      {tone
                        ? <s-badge tone={tone}>{value.toLocaleString("es-CL")}</s-badge>
                        : <p style={{ margin: 0, fontWeight: 600, fontSize: "var(--p-font-size-500, 1.25rem)" }}>{value.toLocaleString("es-CL")}</p>
                      }
                    </s-stack>
                  </s-box>
                ))}
              </s-grid>

              <div style={{ marginTop: 16, marginBottom: 16 }}>
                <s-text color="subdued">Ejecutado: {formatDate(lastStockSyncAt)}</s-text>
              </div>

              {/* Buscar un SKU específico en el resultado del último sync */}
              <div style={{ marginBottom: 16, maxWidth: 320 }}>
                <label style={{ display: "block" }}>
                  <span style={LABEL_STYLE}>Buscar SKU en el último sync</span>
                  <input
                    type="text"
                    value={stockSearch}
                    onChange={(e) => { setStockSearch(e.target.value); setStockDetailPage(1); }}
                    placeholder="Ej: DEF111"
                    style={INPUT_STYLE}
                  />
                </label>
              </div>

              {/* ── Detalle por SKU ── */}
              {lastStockSync.items && lastStockSync.items.length > 0 && (() => {
                const filtered = stockSearch.trim()
                  ? lastStockSync.items.filter((i) => i.sku_code.toLowerCase().includes(stockSearch.trim().toLowerCase()))
                  : lastStockSync.items;
                return filtered.length > 0 ? (
                  <StockDetailTable
                    items={filtered}
                    page={stockDetailPage}
                    onPageChange={setStockDetailPage}
                  />
                ) : (
                  <s-banner tone="info" heading={`"${stockSearch}" no aparece en el detalle de este sync (ni actualizado ni sin cambio).`} />
                );
              })()}

              {/* SKUs no encontrados en Bsale */}
              {(() => {
                const skippedFiltered = (lastStockSync.skipped_items ?? []).filter(
                  (i) => !stockSearch.trim() || i.sku_code.toLowerCase().includes(stockSearch.trim().toLowerCase()),
                );
                return skippedFiltered.length > 0 && <SkippedTable items={skippedFiltered} />;
              })()}

              {/* Error details — Supabase write errors */}
              {lastStockSync.error_details.length > 0 && (
                <s-box padding="base" borderWidth="small" borderRadius="base" background="base">
                  <s-stack direction="block" gap="small">
                    <p style={{ ...HEADING_STYLE, color: "var(--p-color-text-critical, #d72c0d)" }}>
                      SKUs con error ({lastStockSync.error_details.length})
                    </p>
                    <SimpleTable
                      cols={["SKU", "Título", "Error"]}
                      rows={lastStockSync.error_details.map((d) => [
                        <span key="sku"   style={{ fontFamily: "monospace", fontWeight: 600 }}>{d.sku_code}</span>,
                        d.title ?? "—",
                        <span key="error" style={{ color: "var(--p-color-text-critical, #d72c0d)", fontSize: "var(--p-font-size-300, 0.75rem)" }}>{d.error}</span>,
                      ])}
                    />
                  </s-stack>
                </s-box>
              )}

              {/* Shopify push errors — matched + saved in SkuBeam, but the Shopify update itself failed */}
              {(lastStockSync.shopify_push_errors ?? []).length > 0 && (
                <s-box padding="base" borderWidth="small" borderRadius="base" background="base">
                  <s-stack direction="block" gap="small">
                    <p style={{ ...HEADING_STYLE, color: "var(--p-color-text-critical, #d72c0d)" }}>
                      SKUs no actualizados en Shopify ({lastStockSync.shopify_push_errors.length})
                    </p>
                    <s-text color="subdued">
                      El stock de Bsale para estos SKUs sí se guardó en SkuBeam, pero Shopify rechazó el ajuste de inventario.
                      La causa más común es que el ítem nunca fue activado en la ubicación usada para el sync.
                    </s-text>
                    <SimpleTable
                      cols={["SKU", "Título", "Error"]}
                      rows={lastStockSync.shopify_push_errors.map((d) => [
                        <span key="sku"   style={{ fontFamily: "monospace", fontWeight: 600 }}>{d.sku_code}</span>,
                        d.title ?? "—",
                        <span key="error" style={{ color: "var(--p-color-text-critical, #d72c0d)", fontSize: "var(--p-font-size-300, 0.75rem)" }}>{d.error}</span>,
                      ])}
                    />
                  </s-stack>
                </s-box>
              )}
            </s-section>
          )}

          {/* Boleta electrónica */}
          <s-section heading="Nota de Venta automática">
            {hasAddon ? (
              <s-stack direction="block" gap="base">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <s-banner tone="success" heading="Add-on activo — se crea una Nota de Venta en Bsale por cada venta en Shopify. El admin la aprueba en Bsale para generar el documento final." />
                  <webhookFetcher.Form method="post">
                    <input type="hidden" name="intent" value="toggle_addon" />
                    <s-button
                      type="submit"
                      variant="tertiary"
                      tone="critical"
                      {...(webhookFetcher.state !== "idle" ? { loading: true } : {})}
                    >
                      Desactivar
                    </s-button>
                  </webhookFetcher.Form>
                </div>

                {/* Document type selector */}
                <s-box padding="large" borderWidth="small" borderRadius="base" background="base">
                  <s-stack direction="block" gap="small">
                    <p style={HEADING_STYLE}>Tipo de documento Bsale</p>
                    {documentTypeId == null && (
                      <s-banner tone="warning" heading="Selecciona el tipo de documento para emitir Notas de Venta automáticas." />
                    )}
                    {documentTypes.length === 0 ? (
                      <s-text color="subdued">No se encontraron tipos de documento activos en Bsale.</s-text>
                    ) : (
                      <webhookFetcher.Form method="post" style={{ display: "contents" }}>
                        <input type="hidden" name="intent" value="save_document_type" />
                        <s-stack direction="block" gap="small">
                          <label style={{ display: "block" }}>
                            <span style={LABEL_STYLE}>Tipo de documento</span>
                            <select
                              name="documentTypeId"
                              defaultValue={documentTypeId ?? ""}
                              style={SELECT_STYLE}
                              onChange={(e) => {
                                const val = e.target.value ? Number(e.target.value) : "";
                                setSelectedDocTypeId(val);
                              }}
                            >
                              <option value="">Seleccionar tipo…</option>
                              {documentTypes.map((dt) => (
                                <option key={dt.id} value={dt.id}>
                                  {dt.name}{dt.codeSii ? ` (SII: ${dt.codeSii})` : " (sin SII — Nota de Venta)"}
                                </option>
                              ))}
                            </select>
                          </label>
                          {/* Hidden codeSii — populated from selected option */}
                          <input
                            type="hidden"
                            name="codeSii"
                            value={
                              selectedDocTypeId
                                ? (documentTypes.find((dt) => dt.id === selectedDocTypeId)?.codeSii ?? "")
                                : (documentCodeSii ?? "")
                            }
                          />
                          <s-button
                            type="submit"
                            variant="primary"
                            {...(webhookFetcher.state !== "idle" ? { loading: true } : {})}
                          >
                            Guardar tipo de documento
                          </s-button>
                        </s-stack>
                      </webhookFetcher.Form>
                    )}
                    {documentTypeId != null && (
                      <s-text color="subdued">
                        Configurado: <strong>{documentTypes.find((dt) => dt.id === documentTypeId)?.name ?? `ID ${documentTypeId}`}</strong>
                        {documentCodeSii
                          ? ` — declarado al SII (codeSii ${documentCodeSii})`
                          : " — Nota de Venta (borrador interno, no va al SII)"}
                      </s-text>
                    )}
                  </s-stack>
                </s-box>
                {recentBoletas.length === 0 ? (
                  <s-text color="subdued">Aún no hay Notas de Venta emitidas.</s-text>
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
                    Crea una Nota de Venta en Bsale automáticamente por cada venta en Shopify.
                    El admin la revisa en el dashboard de Bsale y la aprueba para generar el documento fiscal final.
                  </s-text>
                  <webhookFetcher.Form method="post">
                    <input type="hidden" name="intent" value="toggle_addon" />
                    <s-button
                      type="submit"
                      variant="primary"
                      {...(!hasToken ? { disabled: true } : {})}
                      {...(webhookFetcher.state !== "idle" ? { loading: true } : {})}
                    >
                      Activar Nota de Venta automática
                    </s-button>
                  </webhookFetcher.Form>
                  {!hasToken && (
                    <s-text color="subdued">Configura el token de Bsale antes de activar.</s-text>
                  )}
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
