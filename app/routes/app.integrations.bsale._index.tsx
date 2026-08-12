import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import type { StockSyncResult, StockSyncItemDetail } from "../integrations/bsale/stocks.server";
import type { PriceSyncResult, PriceSyncItemDetail, PriceSyncDiscountSkip } from "../integrations/bsale/products.server";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useEffect, useRef, useState } from "react";

type StockSyncPayload = StockSyncResult;
type PriceSyncPayload = PriceSyncResult;
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
import { getBsaleDocumentsPage } from "../integrations/bsale/documents.server";
import type { BsaleDocumentsPage, BsaleDocumentRow } from "../integrations/bsale/documents.server";
import type { ProductSyncSummary } from "../models/sync.server";
import type { Tables } from "../types/supabase";

type SyncJob = Tables<"sync_jobs">;

/** Una vista previa está "pendiente" mientras no haya un sync aplicado posterior. */
function pricePreviewIsPending(
  previewAt: string | null | undefined,
  appliedAt: string | null | undefined,
): boolean {
  if (!previewAt) return false;
  if (!appliedAt) return true;
  return new Date(previewAt).getTime() > new Date(appliedAt).getTime();
}

// ── Loader ────────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  const [shopRow, activeJob, initialDocuments, lastStockJob, lastPriceJob, lastPricePreviewJob, activeProductSyncJob, lastProductSyncJob] = await Promise.all([
    supabaseAdmin
      .from("shops")
      .select("bsale_token, bsale_last_sync, active_addons, bsale_price_list_id, bsale_office_id, bsale_document_type_id, bsale_document_code_sii")
      .eq("shop_id", shopId)
      .single()
      .then(({ data }) => data),
    getActiveBsaleJob(shopId),
    getBsaleDocumentsPage(shopId),
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
    supabaseAdmin
      .from("sync_jobs")
      .select("id, records_processed, completed_at, payload")
      .eq("shop_id", shopId)
      .eq("type", "bsale_prices")
      .eq("status", "completed")
      .order("completed_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => data),
    supabaseAdmin
      .from("sync_jobs")
      .select("id, records_processed, completed_at, payload")
      .eq("shop_id", shopId)
      .eq("type", "bsale_prices_preview")
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
    initialDocuments,
    priceLists,
    offices,
    documentTypes,
    lastStockSync:  lastStockJob?.payload as StockSyncPayload | null ?? null,
    lastStockSyncAt: lastStockJob?.completed_at ?? null,
    lastPriceSync:  lastPriceJob?.payload as PriceSyncPayload | null ?? null,
    lastPriceSyncAt: lastPriceJob?.completed_at ?? null,
    // La vista previa solo se muestra mientras sea más reciente que el último sync
    // aplicado — al aplicar, el job de "apply" queda arriba y la tarjeta desaparece.
    lastPricePreview: pricePreviewIsPending(lastPricePreviewJob?.completed_at, lastPriceJob?.completed_at)
      ? (lastPricePreviewJob!.payload as PriceSyncPayload | null) ?? null
      : null,
    lastPricePreviewAt: lastPricePreviewJob?.completed_at ?? null,
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

  if (intent === "preview_prices") {
    const job = await createBsaleJob(shopId, "bsale_prices_preview");
    return { jobId: job.id, jobType: "bsale_prices_preview" as const };
  }
  if (intent === "sync_prices") {
    const job = await createBsaleJob(shopId, "bsale_prices");
    return { jobId: job.id, jobType: "bsale_prices" as const };
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
  if (type === "bsale_prices")         return "precios (Bsale)";
  if (type === "bsale_prices_preview") return "vista previa de precios (Bsale)";
  if (type === "bsale_stock")          return "stock (Bsale)";
  return "datos";
}

type BsaleTab = "config" | "productos" | "stock" | "precios" | "documentos";

const TABS: Array<{ id: BsaleTab; label: string }> = [
  { id: "config",     label: "Configuración" },
  { id: "productos",  label: "Última sincronización" },
  { id: "stock",      label: "Stock" },
  { id: "precios",    label: "Precios" },
  { id: "documentos", label: "Notas emitidas" },
];

const TAB_STYLE = (active: boolean): React.CSSProperties => ({
  padding:      "8px 16px",
  cursor:       "pointer",
  fontWeight:   active ? 600 : 400,
  borderBottom: active ? "2px solid var(--p-color-text, #202223)" : "2px solid transparent",
  borderTop:    "none",
  borderLeft:   "none",
  borderRight:  "none",
  color:        active ? "var(--p-color-text, #202223)" : "var(--p-color-text-subdued, #6d7175)",
  background:   "none",
  fontSize:     "var(--p-font-size-350, 0.875rem)",
});

function formatCLP(value: number | null | undefined) {
  if (value == null) return "—";
  return `$${Math.round(value).toLocaleString("es-CL")}`;
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

/**
 * Variantes con oferta activa en Shopify (compareAtPrice > price). El sync de
 * precios nunca las toca — escribir el precio de lista de Bsale encima las sacaría
 * de oferta — así que se listan aquí para que el merchant decida caso a caso.
 */
function DiscountSkippedTable({ items }: { items: PriceSyncDiscountSkip[] }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const totalPages      = Math.ceil(items.length / PAGE_SIZE_SKIPPED);
  const slice           = items.slice((page - 1) * PAGE_SIZE_SKIPPED, page * PAGE_SIZE_SKIPPED);

  return (
    <div style={{ marginBottom: 16 }}>
      <s-box padding="base" borderWidth="small" borderRadius="base" background="base">
        <s-stack direction="block" gap="small">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <p style={{ ...HEADING_STYLE, color: "var(--p-color-text-caution, #b98900)" }}>
                Con descuento activo — precio no modificado
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
                Estos productos están en oferta en Shopify (precio rebajado con precio de comparación tachado).
                El sync no los toca para no cancelar la promoción. Si quieres aplicarles el precio de Bsale,
                quita la oferta en Shopify y vuelve a sincronizar.
              </s-text>

              <SimpleTable
                cols={["SKU", "Título", "Precio oferta", "Precio tachado", "Precio Bsale"]}
                rows={slice.map((item) => [
                  <span key="sku"   style={{ fontFamily: "monospace", fontWeight: 600 }}>{item.sku_code}</span>,
                  <span key="title" style={{ color: "var(--p-color-text-subdued, #6d7175)" }}>{item.title ?? "—"}</span>,
                  <span key="price" style={{ textAlign: "right" as const, display: "block", fontWeight: 600 }}>
                    {formatCLP(item.price_shopify)}
                  </span>,
                  <span key="compare" style={{ textAlign: "right" as const, display: "block", textDecoration: "line-through", color: "var(--p-color-text-subdued, #6d7175)" }}>
                    {formatCLP(item.compare_at_price)}
                  </span>,
                  <span key="bsale" style={{ textAlign: "right" as const, display: "block", color: "var(--p-color-text-subdued, #6d7175)" }}>
                    {formatCLP(item.price_bsale)}
                  </span>,
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
    </div>
  );
}

/**
 * Listado completo de documentos emitidos, con búsqueda por orden / nº de documento
 * y paginación server-side (`/api/bsale/documents`). La primera página llega en el
 * loader; a partir de ahí manda el fetcher, para no re-ejecutar el loader de la
 * página completa (que además consulta listas de precios y sucursales en Bsale).
 */
function BsaleDocumentsTable({ initial }: { initial: BsaleDocumentsPage }) {
  const fetcher = useFetcher<BsaleDocumentsPage>();

  const [search, setSearch]   = useState("");
  const [page, setPage]       = useState(1);
  const [touched, setTouched] = useState(false);

  // Debounce: escribir en el buscador no dispara una request por tecla.
  useEffect(() => {
    if (!touched) return;
    const id = setTimeout(() => {
      const params = new URLSearchParams({ page: String(page) });
      if (search.trim()) params.set("q", search.trim());
      fetcher.load(`/api/bsale/documents?${params}`);
    }, 300);
    return () => clearTimeout(id);
  }, [search, page, touched]); // eslint-disable-line react-hooks/exhaustive-deps

  const data      = touched && fetcher.data ? fetcher.data : initial;
  const items     = data.items;
  const total     = data.total;
  const pageSize  = data.pageSize;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const isLoading = fetcher.state !== "idle";

  const changeSearch = (value: string) => { setTouched(true); setPage(1); setSearch(value); };
  const changePage   = (next: number) => { setTouched(true); setPage(next); };

  const GRID = "110px 1fr 110px 110px 90px 50px";

  return (
    <s-stack direction="block" gap="base">
      <p style={HEADING_STYLE}>Documentos emitidos</p>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
        <div style={{ maxWidth: 320, flex: "1 1 240px" }}>
          <label style={{ display: "block" }}>
            <span style={LABEL_STYLE}>Buscar por orden o nº de documento</span>
            <input
              type="text"
              value={search}
              onChange={(e) => changeSearch(e.target.value)}
              placeholder="Ej: 7180507807893 o 7718"
              style={INPUT_STYLE}
            />
          </label>
        </div>
        <s-text color="subdued">
          {isLoading
            ? "Buscando…"
            : total === 0
            ? "Sin resultados"
            : `${total.toLocaleString("es-CL")} ${total === 1 ? "documento" : "documentos"}`}
        </s-text>
      </div>

      {items.length === 0 ? (
        <s-text color="subdued">
          {search.trim()
            ? `No hay documentos que coincidan con "${search.trim()}".`
            : "Aún no hay Notas de Venta emitidas."}
        </s-text>
      ) : (
        <div
          style={{
            border:       "1px solid var(--p-color-border, #e1e3e5)",
            borderRadius: "var(--p-border-radius-200, 8px)",
            overflow:     "hidden",
            opacity:      isLoading ? 0.6 : 1,
          }}
        >
          <div
            style={{
              display:             "grid",
              gridTemplateColumns: GRID,
              gap:                 8,
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
            <span>Fecha</span>
            <span>Orden Shopify</span>
            <span>Nº documento</span>
            <span>Total</span>
            <span>Estado</span>
            <span>PDF</span>
          </div>

          {items.map((doc, idx) => (
            <div
              key={doc.shopify_order_id}
              style={{
                display:             "grid",
                gridTemplateColumns: GRID,
                gap:                 8,
                padding:             "10px 12px",
                alignItems:          "center",
                background:          idx % 2 === 0
                  ? "var(--p-color-bg-surface, #fff)"
                  : "var(--p-color-bg-surface-secondary, #f6f6f7)",
                borderBottom: idx < items.length - 1
                  ? "1px solid var(--p-color-border-subdued, #e1e3e5)"
                  : "none",
                fontSize: "var(--p-font-size-350, 0.875rem)",
              }}
            >
              <span style={{ color: "var(--p-color-text-subdued, #6d7175)" }}>
                {doc.created_at
                  ? new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "2-digit", year: "2-digit" }).format(new Date(doc.created_at))
                  : "—"}
              </span>
              <span style={{ fontWeight: 600 }}>#{doc.shopify_order_id}</span>
              {/* El correlativo impreso en el PDF; el ID interno de la API solo
                  aparece como fallback si Bsale todavía no devolvió el número. */}
              <span style={{ fontFamily: "monospace", fontWeight: 600 }}>
                {doc.bsale_document_number != null
                  ? `Nº ${doc.bsale_document_number}`
                  : doc.bsale_document_id != null
                    ? <span title="Documento sin número correlativo devuelto por Bsale" style={{ fontWeight: 400, color: "var(--p-color-text-subdued, #6d7175)" }}>
                        ID {doc.bsale_document_id}
                      </span>
                    : "—"}
              </span>
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

      {totalPages > 1 && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <s-text color="subdued">
            {(data.page - 1) * pageSize + 1}–{Math.min(data.page * pageSize, total)} de {total.toLocaleString("es-CL")}
          </s-text>
          <div style={{ display: "flex", gap: 8 }}>
            <s-button
              variant="tertiary"
              {...(data.page <= 1 || isLoading ? { disabled: true } : {})}
              onClick={() => changePage(data.page - 1)}
            >
              ← Anterior
            </s-button>
            <s-button
              variant="tertiary"
              {...(data.page >= totalPages || isLoading ? { disabled: true } : {})}
              onClick={() => changePage(data.page + 1)}
            >
              Siguiente →
            </s-button>
          </div>
        </div>
      )}

      {/* Errores de emisión: el detalle vive solo acá, así que se muestra completo. */}
      {items.some((d) => d.status === "error" && d.error_message) && (
        <s-box padding="base" borderWidth="small" borderRadius="base" background="base">
          <s-stack direction="block" gap="small">
            <p style={{ ...HEADING_STYLE, color: "var(--p-color-text-critical, #d72c0d)" }}>
              Detalle de errores en esta página
            </p>
            <SimpleTable
              cols={["Orden", "Error"]}
              rows={items
                .filter((d): d is BsaleDocumentRow & { error_message: string } => d.status === "error" && !!d.error_message)
                .map((d) => [
                  <span key="order" style={{ fontWeight: 600 }}>#{d.shopify_order_id}</span>,
                  <span key="err" style={{ color: "var(--p-color-text-critical, #d72c0d)", fontSize: "var(--p-font-size-300, 0.75rem)" }}>{d.error_message}</span>,
                ])}
            />
          </s-stack>
        </s-box>
      )}
    </s-stack>
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

function PriceDetailTable({
  items,
  page,
  onPageChange,
  mode = "apply",
}: {
  items:        PriceSyncItemDetail[];
  page:         number;
  onPageChange: (p: number) => void;
  mode?:        "preview" | "apply";
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
              {changedCount > 0   && <s-badge tone="success">{changedCount} {mode === "preview" ? "por actualizar" : "actualizados"}</s-badge>}
              {unchangedCount > 0 && <s-badge tone="neutral">{unchangedCount} sin cambio</s-badge>}
            </div>
          </div>

          <SimpleTable
            cols={["SKU", "Título", "Precio Shopify", "Precio Bsale", mode === "preview" ? "Cambio propuesto" : "Cambio"]}
            rows={slice.map((item) => {
              const before  = item.price_before;
              const diff    = before != null ? item.price_after - before : null;
              const diffColor = diff && diff > 0
                ? "var(--p-color-text-success, #008060)"
                : diff && diff < 0
                ? "var(--p-color-text-critical, #d72c0d)"
                : "var(--p-color-text-subdued, #6d7175)";

              return [
                <span key="sku"    style={{ fontFamily: "monospace", fontWeight: 600 }}>{item.sku_code}</span>,
                <span key="title"  style={{ color: "var(--p-color-text-subdued, #6d7175)" }}>{item.title ?? "—"}</span>,
                <span key="before" style={{ textAlign: "right" as const, display: "block" }}>
                  {before != null ? `$${before.toLocaleString("es-CL")}` : "—"}
                </span>,
                <span key="after"  style={{ textAlign: "right" as const, display: "block", fontWeight: item.changed ? 600 : 400 }}>
                  ${item.price_after.toLocaleString("es-CL")}
                </span>,
                <span key="diff"   style={{ color: diffColor, fontWeight: 600, textAlign: "right" as const, display: "block" }}>
                  {diff == null || diff === 0 ? "—" : diff > 0 ? `+$${diff.toLocaleString("es-CL")}` : `-$${Math.abs(diff).toLocaleString("es-CL")}`}
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
    bsaleLastSync, activeJob, hasAddon, initialDocuments,
    priceLists, offices, documentTypes,
    lastStockSync, lastStockSyncAt,
    lastPriceSync, lastPriceSyncAt,
    lastPricePreview, lastPricePreviewAt,
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
  const [priceDetailPage,      setPriceDetailPage]      = useState(1);
  const [priceSearch,          setPriceSearch]          = useState("");
  const [previewDetailPage,    setPreviewDetailPage]    = useState(1);
  const [previewSearch,        setPreviewSearch]        = useState("");
  const [showOldPriceReport,   setShowOldPriceReport]   = useState(false);
  const [tab,                  setTab]                  = useState<BsaleTab>("config");

  // Fetchers
  const tokenFetcher   = useFetcher<{ success?: string; error?: string; tokenSaved?: boolean }>();
  const webhookFetcher = useFetcher<{ success?: string; error?: string }>();
  const setupFetcher   = useFetcher<{ ok?: boolean }>();
  const createFetcher  = useFetcher<{ jobId?: string; jobType?: "bsale_prices" | "bsale_prices_preview" | "bsale_stock"; error?: string; success?: string }>();
  const triggerFetcher = useFetcher();
  const statusFetcher  = useFetcher<{ status: string | null; records_processed: number; type: string | null; error_message: string | null }>();
  const cancelFetcher  = useFetcher<{ ok?: boolean; error?: string }>();

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

  // Sync polling. "cancelled" también es terminal: sin él, cancelar un job dejaba
  // los tres botones girando para siempre.
  const TERMINAL_STATUSES = ["completed", "failed", "cancelled"];
  const pendingJobId = createFetcher.data?.jobId ?? null;
  const jobId        = pendingJobId ?? activeJob?.id ?? null;
  const polledStatus = statusFetcher.data?.status;
  const isRunning    = !!jobId && !TERMINAL_STATUSES.includes(polledStatus ?? "");

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
    if (TERMINAL_STATUSES.includes(polledStatus ?? "")) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      revalidator.revalidate();
      // After first sync completes from step 4, exit wizard
      if (step === 4) setShowWizard(false);

      // Llevar al tab con el resultado recién generado — si no, el reporte queda
      // en un tab que el merchant no está mirando.
      if (polledStatus === "completed") {
        const finished = statusFetcher.data?.type;
        if (finished === "bsale_stock") setTab("stock");
        else if (finished === "bsale_prices" || finished === "bsale_prices_preview") setTab("precios");
      }
    }
  }, [polledStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cancelar un job colgado: devuelve el control sin esperar el corte por antigüedad.
  useEffect(() => {
    if (cancelFetcher.data?.ok) revalidator.revalidate();
  }, [cancelFetcher.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cronómetro del job en curso — un spinner sin tiempo ni avance no permite
  // distinguir "va lento" de "murió", que es exactamente lo que confunde acá.
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [tick, setTick]                 = useState(0);

  useEffect(() => {
    if (!isRunning) { setRunStartedAt(null); setTick(0); return; }
    setRunStartedAt((prev) => prev ?? (activeJob?.started_at ? new Date(activeJob.started_at).getTime() : Date.now()));
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isRunning]); // eslint-disable-line react-hooks/exhaustive-deps

  // Badges de los tabs: solo lo accionable (cambios de precio esperando confirmación)
  // y el total de documentos, para no llenar la barra de números sin uso.
  const pendingPriceChanges = lastPricePreview?.items.filter((i) => i.changed).length ?? 0;
  const tabBadges: Partial<Record<BsaleTab, { value: number | string; tone?: "attention" }>> = {
    ...(pendingPriceChanges > 0 ? { precios: { value: pendingPriceChanges, tone: "attention" as const } } : {}),
    ...(initialDocuments.total > 0 ? { documentos: { value: initialDocuments.total } } : {}),
  };

  const elapsedLabel = runStartedAt && tick
    ? (() => {
        const s = Math.max(0, Math.floor((tick - runStartedAt) / 1000));
        return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
      })()
    : null;

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

  // /api/sync returns { job: null } once nothing is active anymore — including right
  // after OUR job just finished, since "completed" jobs are (by design) excluded from
  // the active-job lookup. `null ?? fallback` treated that as "no info yet" and fell
  // back to the stale activeProductSyncJob from page load, so the spinner never
  // cleared even though the server had long since finished. A poll response having
  // arrived at all — job or no job — is itself authoritative.
  const pollReceived        = productSyncPollFetcher.data !== undefined;
  const polledProductSyncJob = pollReceived
    ? productSyncPollFetcher.data!.job
    : (trackedJobId ? null : activeProductSyncJob);

  const isProductSyncRunning = pollReceived
    ? !!polledProductSyncJob && ["running", "pending", "processing"].includes(polledProductSyncJob.status ?? "")
    : trackedJobId
      ? true
      : !!activeProductSyncJob && ["running", "pending", "processing"].includes(activeProductSyncJob.status ?? "");

  useEffect(() => {
    if (!isProductSyncRunning) return;
    productSyncPollRef.current = setInterval(() => productSyncPollFetcher.load("/api/sync"), 5000);
    return () => { if (productSyncPollRef.current) { clearInterval(productSyncPollRef.current); productSyncPollRef.current = null; } };
  }, [isProductSyncRunning]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!pollReceived) return;
    const job = productSyncPollFetcher.data!.job;
    const isDone = !job || job.status === "completed" || job.status === "failed" || job.status === "cancelled";
    if (isDone) {
      if (productSyncPollRef.current) { clearInterval(productSyncPollRef.current); productSyncPollRef.current = null; }
      if (trackedJobId && job?.status === "completed") setTab("productos");
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
    (polledStatus === "failed"
      ? statusFetcher.data?.error_message ?? "La sincronización falló. Revisa los logs."
      : null) ??
    (polledStatus === "cancelled" ? "Sincronización cancelada." : null) ??
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

          {/* ── Step 4: Confirm ─────────────────────────────────────────── */}
          {step === 4 && (
            <s-box padding="large" borderWidth="small" borderRadius="base" background="base">
              <s-stack direction="block" gap="base">
                <p style={HEADING_STYLE}>¡Todo listo!</p>

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

                <s-text color="subdued">
                  Bsale ya está conectado. Usa los botones de &quot;Sincronización manual&quot; abajo para traer precios y stock
                  hacia los productos que ya tengas publicados en Shopify.
                </s-text>

                <s-button variant="primary" onClick={() => setShowWizard(false)}>
                  Finalizar
                </s-button>
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

          {/* Sync en curso — fuera de los tabs para que se vea desde cualquiera */}
          {(isRunning || isProductSyncRunning) && (
            <s-section>
              <s-stack direction="block" gap="base">
                {isRunning && (
                  <s-banner tone="info">
                    <s-stack direction="block" gap="small">
                      <s-stack direction="inline" gap="small">
                        <s-spinner />
                        <s-text>
                          Sincronizando {jobTypeLabel(runningType)}{progressLabel}
                          {elapsedLabel ? ` — ${elapsedLabel}` : ""}…
                        </s-text>
                      </s-stack>
                      <s-text color="subdued">
                        Solo puede correr un sync de Bsale a la vez, por eso los botones están
                        deshabilitados. El contador de registros avanza mientras lee la lista de
                        precios de Bsale; si se queda pegado en 0 más de un minuto, cancela y reintenta.
                      </s-text>
                      {jobId && (
                        <s-button
                          variant="tertiary"
                          {...(cancelFetcher.state !== "idle" ? { loading: true } : {})}
                          onClick={() =>
                            cancelFetcher.submit({ jobId }, { method: "post", action: "/api/cancel-job" })
                          }
                        >
                          Cancelar
                        </s-button>
                      )}
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
              </s-stack>
            </s-section>
          )}

          {/* Tabs */}
          <s-section>
            <div style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--p-color-border, #e1e3e5)", flexWrap: "wrap" }}>
              {TABS.map(({ id, label }) => {
                const badge = tabBadges[id];
                return (
                  <button key={id} style={TAB_STYLE(tab === id)} onClick={() => setTab(id)}>
                    {label}
                    {badge != null && (
                      <span style={{
                        marginLeft: 6,
                        padding:      "1px 6px",
                        borderRadius: 10,
                        fontSize:     "var(--p-font-size-300, 0.75rem)",
                        background:   badge.tone === "attention"
                          ? "var(--p-color-bg-fill-caution, #ffd79d)"
                          : "var(--p-color-bg-surface-secondary, #f1f1f1)",
                        color: "var(--p-color-text, #202223)",
                      }}>
                        {badge.value}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </s-section>

          {/* Config + Sync */}
          {tab === "config" && (
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
                    <s-text color="subdued">
                      Trae los precios de la lista configurada en Bsale y los escribe en Shopify — solo precio,
                      nunca stock, y solo para productos ya publicados. Los productos con descuento activo
                      (precio de comparación tachado) se omiten para no cancelar la promoción.
                    </s-text>
                    <s-text color="subdued">
                      Primero calcula los cambios y te los muestra; nada se escribe en Shopify hasta que confirmes.
                    </s-text>
                    <createFetcher.Form method="post">
                      <input type="hidden" name="intent" value="preview_prices" />
                      <s-button
                        type="submit"
                        {...(isRunning || createFetcher.state !== "idle" ? { loading: true } : {})}
                        {...(!hasToken ? { disabled: true } : {})}
                      >
                        Revisar cambios de precio
                      </s-button>
                    </createFetcher.Form>
                  </s-stack>

                  <div style={{ height: "1px", background: "var(--p-color-border, #e1e3e5)" }} />

                  <s-stack direction="block" gap="small">
                    <s-text type="strong">Stock (Bsale)</s-text>
                    <s-text color="subdued">Actualiza los niveles de inventario por sucursal. No modifica precios.</s-text>
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
          )}

          {/* ── Tab: última sincronización de productos (Shopify) ─────────── */}
          {tab === "productos" && !lastProductSync && (
            <s-section heading="Última sincronización de productos (Shopify)">
              <s-text color="subdued">
                Todavía no has sincronizado el catálogo desde Shopify. Hazlo desde Configuración → Sincronización manual.
              </s-text>
            </s-section>
          )}
          {tab === "productos" && lastProductSync && (() => {
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
                        { label: "Archivados",             value: summary?.archived ?? 0, tone: (summary?.archived ?? 0) > 0 ? "warning" as const : undefined },
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

          {/* ── Tab: stock ───────────────────────────────────────────────── */}
          {tab === "stock" && !lastStockSync && (
            <s-section heading="Stock (Bsale)">
              <s-text color="subdued">
                Todavía no has sincronizado stock desde Bsale. Hazlo desde Configuración → Sincronización manual.
              </s-text>
            </s-section>
          )}
          {tab === "stock" && lastStockSync && (
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

          {/* ── Tab: precios ─────────────────────────────────────────────── */}
          {tab === "precios" && (
            <s-section>
              <s-box padding="large" borderWidth="small" borderRadius="base" background="base">
                <s-stack direction="block" gap="small">
                  <p style={HEADING_STYLE}>Cómo funciona</p>
                  <s-text color="subdued">
                    <strong>1. Revisar</strong> (botón en Configuración) → compara Bsale con Shopify y te muestra
                    abajo qué cambiaría. <strong>No escribe nada.</strong>
                  </s-text>
                  <s-text color="subdued">
                    <strong>2. Aplicar</strong> (botón al final de la tarjeta de revisión, aquí abajo) → recién ahí se
                    escriben los precios en Shopify. Se habilita solo si la revisión encontró diferencias.
                  </s-text>
                  <s-text color="subdued">
                    Por eso las dos tarjetas de abajo tienen fechas distintas: la primera es la última
                    <strong> revisión</strong> (simulación), la segunda es la última vez que se
                    <strong> aplicó</strong> algo de verdad.
                  </s-text>
                </s-stack>
              </s-box>
            </s-section>
          )}

          {tab === "precios" && !lastPricePreview && !lastPriceSync && (
            <s-section heading="Precios (Bsale)">
              <s-text color="subdued">
                Todavía no has revisado precios. Anda a Configuración → Sincronización manual y dale a
                &quot;Revisar cambios de precio&quot;: te mostramos el diff acá antes de escribir nada en Shopify.
              </s-text>
            </s-section>
          )}

          {/* Vista previa de precios (pendiente de confirmar) */}
          {tab === "precios" && lastPricePreview && (() => {
            const changed    = lastPricePreview.items.filter((i) => i.changed);
            const discounted = lastPricePreview.discounted_skipped ?? [];

            return (
              <s-section heading="Última revisión (simulación) — nada escrito en Shopify">
                <s-stack direction="block" gap="base">
                  {/* Con `heading` suelto el banner no se renderiza en algunos casos;
                      con children siempre sale. */}
                  {changed.length === 0 ? (
                    <s-banner tone="success">
                      <s-paragraph>
                        <strong>Todo alineado: ningún precio cambiaría.</strong> Shopify ya coincide con la
                        lista de precios de Bsale, así que no hay nada que aplicar.
                      </s-paragraph>
                    </s-banner>
                  ) : (
                    <s-banner tone="info">
                      <s-paragraph>
                        <strong>{changed.length} {changed.length === 1 ? "producto cambiaría" : "productos cambiarían"} de precio.</strong>{" "}
                        Nada se ha escrito todavía en Shopify — revisa la tabla y confirma abajo.
                      </s-paragraph>
                    </s-banner>
                  )}

                  {/* Una oferta puesta bajando el precio SIN llenar el precio de
                      comparación es indistinguible de "Bsale subió el precio", así
                      que no se puede omitir automáticamente — se avisa acá. */}
                  {(() => {
                    const subirian = changed.filter((i) => i.price_before != null && i.price_before < i.price_after);
                    if (subirian.length === 0) return null;
                    return (
                      <s-banner tone="warning">
                        <s-paragraph>
                          <strong>{subirian.length} {subirian.length === 1 ? "producto tiene" : "productos tienen"} en Shopify un precio menor al de Bsale</strong> y
                          el sync se lo subiría ({subirian.slice(0, 5).map((i) => i.sku_code).join(", ")}
                          {subirian.length > 5 ? `, +${subirian.length - 5} más` : ""}).
                          Si son ofertas que pusiste bajando el precio sin llenar el &quot;precio de comparación&quot;,
                          aplicar el sync las va a cancelar. Para que SkuBeam las respete automáticamente,
                          carga el precio normal en el campo de comparación de Shopify.
                        </s-paragraph>
                      </s-banner>
                    );
                  })()}

                  <s-grid gridTemplateColumns="repeat(auto-fit, minmax(140px, 1fr))" gap="base">
                    {(
                      [
                        { label: "Matcheados con Bsale", value: lastPricePreview.shopify_matched, tone: undefined },
                        { label: "Cambiarían de precio", value: changed.length, tone: changed.length > 0 ? "success" as const : undefined },
                        { label: "En oferta (omitidos)", value: discounted.length, tone: discounted.length > 0 ? "warning" as const : undefined },
                        { label: "No en Bsale",          value: lastPricePreview.skipped, tone: lastPricePreview.skipped > 0 ? "warning" as const : undefined },
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

                  <s-text color="subdued">
                    Revisado el {formatDate(lastPricePreviewAt)} — refleja los precios de Shopify y Bsale en ese momento.
                  </s-text>

                  {/* Buscador sobre TODO el resultado, no solo sobre lo que cambia:
                      buscar un SKU y no encontrarlo no distingue "sin cambio" de
                      "en oferta" o "no está en Bsale", que es justo lo que se
                      necesita saber. */}
                  <div style={{ maxWidth: 320 }}>
                    <label style={{ display: "block" }}>
                      <span style={LABEL_STYLE}>Buscar SKU en esta vista previa</span>
                      <input
                        type="text"
                        value={previewSearch}
                        onChange={(e) => { setPreviewSearch(e.target.value); setPreviewDetailPage(1); }}
                        placeholder="Ej: ANZ411"
                        style={INPUT_STYLE}
                      />
                    </label>
                  </div>

                  {(() => {
                    const q = previewSearch.trim().toLowerCase();
                    const match = (code: string) => code.toLowerCase().includes(q);

                    // Sin búsqueda se muestra solo lo que cambiaría; con búsqueda se
                    // busca en todo (incluidos los que quedan igual).
                    const shownItems      = q ? lastPricePreview.items.filter((i) => match(i.sku_code)) : changed;
                    const shownDiscounted = q ? discounted.filter((d) => match(d.sku_code)) : discounted;
                    const shownNotInBsale = q ? (lastPricePreview.skipped_items ?? []).filter((i) => match(i.sku_code)) : [];
                    const nothing = q && shownItems.length === 0 && shownDiscounted.length === 0 && shownNotInBsale.length === 0;

                    return (
                      <>
                        {shownItems.length > 0 && (
                          <PriceDetailTable
                            items={shownItems}
                            page={previewDetailPage}
                            onPageChange={setPreviewDetailPage}
                            mode="preview"
                          />
                        )}

                        {shownDiscounted.length > 0 && <DiscountSkippedTable items={shownDiscounted} />}

                        {shownNotInBsale.length > 0 && (
                          <s-banner tone="warning">
                            <s-paragraph>
                              {shownNotInBsale.map((i) => i.sku_code).join(", ")} no {shownNotInBsale.length === 1 ? "tiene" : "tienen"} código
                              coincidente en la lista de precios de Bsale, así que el sync no {shownNotInBsale.length === 1 ? "lo" : "los"} toca.
                            </s-paragraph>
                          </s-banner>
                        )}

                        {nothing && (
                          <s-banner tone="info" heading={`"${previewSearch.trim()}" no aparece en esta vista previa — no es un SKU publicado en Shopify, o está archivado.`} />
                        )}
                      </>
                    );
                  })()}

                  {/* El botón se muestra siempre — deshabilitado cuando no hay nada que
                      aplicar. Esconderlo dejaba al merchant buscando un botón inexistente. */}
                  <div style={{ borderTop: "1px solid var(--p-color-border, #e1e3e5)", paddingTop: 16 }}>
                    <createFetcher.Form method="post">
                      <input type="hidden" name="intent" value="sync_prices" />
                      <s-stack direction="block" gap="small">
                        <s-text color="subdued">
                          {changed.length > 0
                            ? "Al aplicar, los precios se recalculan contra Bsale en ese momento y se escriben en Shopify. Los productos en oferta se seguirán omitiendo."
                            : "No hay cambios que aplicar: Shopify ya coincide con Bsale. El botón se habilita cuando una revisión encuentre diferencias."}
                        </s-text>
                        <s-button
                          type="submit"
                          variant="primary"
                          {...(changed.length === 0 ? { disabled: true } : {})}
                          {...(isRunning || createFetcher.state !== "idle" ? { loading: true } : {})}
                        >
                          {changed.length > 0
                            ? `Aplicar ${changed.length} ${changed.length === 1 ? "cambio" : "cambios"} en Shopify`
                            : "Aplicar cambios en Shopify"}
                        </s-button>
                      </s-stack>
                    </createFetcher.Form>
                  </div>
                </s-stack>
              </s-section>
            );
          })()}

          {/* Último sync de precios aplicado */}
          {tab === "precios" && lastPriceSync && (() => {
            // Los payloads anteriores a la protección de descuentos no traen el
            // campo: mostrar 0 haría creer que se revisó y no había ninguno.
            const hasDiscountData = lastPriceSync.mode !== undefined;
            const discountedCount = (lastPriceSync.discounted_skipped ?? []).length;
            const ageMs = lastPriceSyncAt ? Date.now() - new Date(lastPriceSyncAt).getTime() : 0;
            const isStale = ageMs > 24 * 60 * 60 * 1000;

            const collapsed = isStale && !showOldPriceReport;

            return (
            <s-section heading="Historial: último cambio aplicado en Shopify">
              <div style={{ marginBottom: collapsed ? 0 : 16 }}>
                <s-stack direction="block" gap="small">
                  <s-text color="subdued">
                    La última vez que SkuBeam <strong>escribió</strong> precios en Shopify fue el {formatDate(lastPriceSyncAt)}.
                    Esto es historial: no dice nada de los precios de hoy.
                  </s-text>
                  <s-button variant="tertiary" onClick={() => setShowOldPriceReport((v) => !v)}>
                    {showOldPriceReport ? "Ocultar ese reporte ▲" : "Ver ese reporte ▼"}
                  </s-button>
                </s-stack>
              </div>

              {collapsed ? null : (
              <>
              {/* Stats row */}
              <s-grid gridTemplateColumns="repeat(auto-fit, minmax(140px, 1fr))" gap="base">
                {(
                  [
                    { label: "SKUs publicados",     value: lastPriceSync.total_bsale_codes, tone: undefined },
                    { label: "Matcheados con Bsale", value: lastPriceSync.shopify_matched,  tone: "success" as const },
                    { label: "En oferta (omitidos)", value: hasDiscountData ? discountedCount : "—", tone: discountedCount > 0 ? "warning" as const : undefined },
                    { label: "No en Bsale",         value: lastPriceSync.skipped,           tone: lastPriceSync.skipped > 0 ? "warning" as const : undefined },
                    { label: "Sync Shopify",        value: lastPriceSync.shopify_updated ?? 0, tone: (lastPriceSync.shopify_updated ?? 0) > 0 ? "success" as const : undefined },
                    { label: "Con error",           value: lastPriceSync.errors,            tone: lastPriceSync.errors > 0 ? "critical" as const : undefined },
                    { label: "Error en Shopify",    value: (lastPriceSync.shopify_push_errors ?? []).length, tone: (lastPriceSync.shopify_push_errors ?? []).length > 0 ? "critical" as const : undefined },
                  ] as Array<{ label: string; value: number | string; tone?: "success" | "warning" | "critical" }>
                ).map(({ label, value, tone }) => {
                  const shown = typeof value === "number" ? value.toLocaleString("es-CL") : value;
                  return (
                    <s-box key={label} padding="base" borderWidth="small" borderRadius="base" background="base">
                      <s-stack direction="block" gap="small">
                        <s-text color="subdued">{label}</s-text>
                        {tone
                          ? <s-badge tone={tone}>{shown}</s-badge>
                          : <p style={{ margin: 0, fontWeight: 600, fontSize: "var(--p-font-size-500, 1.25rem)" }}>{shown}</p>
                        }
                      </s-stack>
                    </s-box>
                  );
                })}
              </s-grid>

              <div style={{ marginTop: 16, marginBottom: 16 }}>
                <s-banner tone={isStale ? "warning" : "info"}>
                  <s-paragraph>
                    Esta es una <strong>foto del {formatDate(lastPriceSyncAt)}</strong>: la columna
                    &quot;Precio Shopify&quot; es el precio que tenía Shopify ese día, no el actual.
                    {!hasDiscountData && " Además es anterior a la protección de descuentos, así que pudo haber pisado precios de oferta."}
                  </s-paragraph>
                </s-banner>
              </div>

              {/* Buscar un SKU específico en el resultado del último sync */}
              <div style={{ marginBottom: 16, maxWidth: 320 }}>
                <label style={{ display: "block" }}>
                  <span style={LABEL_STYLE}>Buscar SKU en el último sync</span>
                  <input
                    type="text"
                    value={priceSearch}
                    onChange={(e) => { setPriceSearch(e.target.value); setPriceDetailPage(1); }}
                    placeholder="Ej: DEF111"
                    style={INPUT_STYLE}
                  />
                </label>
              </div>

              {/* ── Detalle por SKU ── */}
              {lastPriceSync.items && lastPriceSync.items.length > 0 && (() => {
                const filtered = priceSearch.trim()
                  ? lastPriceSync.items.filter((i) => i.sku_code.toLowerCase().includes(priceSearch.trim().toLowerCase()))
                  : lastPriceSync.items;
                return filtered.length > 0 ? (
                  <PriceDetailTable
                    items={filtered}
                    page={priceDetailPage}
                    onPageChange={setPriceDetailPage}
                  />
                ) : (
                  <s-banner tone="info" heading={`"${priceSearch}" no aparece en el detalle de este sync.`} />
                );
              })()}

              {/* Productos en oferta — precio deliberadamente no modificado */}
              {(() => {
                const discountFiltered = (lastPriceSync.discounted_skipped ?? []).filter(
                  (i) => !priceSearch.trim() || i.sku_code.toLowerCase().includes(priceSearch.trim().toLowerCase()),
                );
                return discountFiltered.length > 0 && <DiscountSkippedTable items={discountFiltered} />;
              })()}

              {/* SKUs no encontrados en Bsale */}
              {(() => {
                const skippedFiltered = (lastPriceSync.skipped_items ?? []).filter(
                  (i) => !priceSearch.trim() || i.sku_code.toLowerCase().includes(priceSearch.trim().toLowerCase()),
                );
                return skippedFiltered.length > 0 && <SkippedTable items={skippedFiltered} />;
              })()}

              {/* Error details — Supabase write errors */}
              {lastPriceSync.error_details.length > 0 && (
                <s-box padding="base" borderWidth="small" borderRadius="base" background="base">
                  <s-stack direction="block" gap="small">
                    <p style={{ ...HEADING_STYLE, color: "var(--p-color-text-critical, #d72c0d)" }}>
                      SKUs con error ({lastPriceSync.error_details.length})
                    </p>
                    <SimpleTable
                      cols={["SKU", "Título", "Error"]}
                      rows={lastPriceSync.error_details.map((d) => [
                        <span key="sku"   style={{ fontFamily: "monospace", fontWeight: 600 }}>{d.sku_code}</span>,
                        d.title ?? "—",
                        <span key="error" style={{ color: "var(--p-color-text-critical, #d72c0d)", fontSize: "var(--p-font-size-300, 0.75rem)" }}>{d.error}</span>,
                      ])}
                    />
                  </s-stack>
                </s-box>
              )}

              {/* Shopify push errors */}
              {(lastPriceSync.shopify_push_errors ?? []).length > 0 && (
                <s-box padding="base" borderWidth="small" borderRadius="base" background="base">
                  <s-stack direction="block" gap="small">
                    <p style={{ ...HEADING_STYLE, color: "var(--p-color-text-critical, #d72c0d)" }}>
                      SKUs no actualizados en Shopify ({lastPriceSync.shopify_push_errors.length})
                    </p>
                    <s-text color="subdued">
                      El precio de Bsale para estos SKUs sí se guardó en SkuBeam, pero Shopify rechazó la actualización.
                    </s-text>
                    <SimpleTable
                      cols={["SKU", "Título", "Error"]}
                      rows={lastPriceSync.shopify_push_errors.map((d) => [
                        <span key="sku"   style={{ fontFamily: "monospace", fontWeight: 600 }}>{d.sku_code}</span>,
                        d.title ?? "—",
                        <span key="error" style={{ color: "var(--p-color-text-critical, #d72c0d)", fontSize: "var(--p-font-size-300, 0.75rem)" }}>{d.error}</span>,
                      ])}
                    />
                  </s-stack>
                </s-box>
              )}
              </>
              )}
            </s-section>
            );
          })()}

          {/* Boleta electrónica */}
          {tab === "documentos" && (
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

            {/* El historial sigue accesible aunque el add-on se desactive: los PDF
                ya emitidos se siguen necesitando. */}
            {(hasAddon || initialDocuments.total > 0) && (
              <BsaleDocumentsTable initial={initialDocuments} />
            )}
          </s-section>
          )}
        </>
      )}

    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
