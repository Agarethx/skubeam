import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  Form,
  useLoaderData,
  useNavigate,
  useNavigation,
  useFetcher,
  useRevalidator,
} from "react-router";
import { useEffect, useState } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useTranslation } from 'react-i18next';
import { authenticate } from "../shopify.server";
import { useShopifyParams } from "../lib/navigate";
import { listSkus, listUnpublishedSkus, getUnpublishedCount } from "../models/sku.server";
import type { SkuStatus, SkuDetail } from "../models/sku.server";
import { getActiveSyncJob, startBulkSync } from "../models/sync.server";
import type { BsaleSearchVariant } from "../integrations/bsale/products.server";
import type { Tables } from "../types/supabase";

type SyncJob = Tables<"sync_jobs">;

// ── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "import") {
    await startBulkSync(admin, session.shop);
  }

  return null;
};

// ── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const url    = new URL(request.url);
  const search = url.searchParams.get("search") ?? "";
  const status = (url.searchParams.get("status") ?? "") as SkuStatus | "";
  const page   = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
  const tab    = url.searchParams.get("tab") ?? "";

  const [result, activeSyncJob, unpublishedCount, unpublishedResult] = await Promise.all([
    tab === "unpublished" ? Promise.resolve({ skus: [], total: 0, page: 1, pageSize: 50, totalPages: 0 }) : listSkus(session.shop, { search, status, page }),
    getActiveSyncJob(session.shop),
    getUnpublishedCount(session.shop),
    tab === "unpublished"
      ? listUnpublishedSkus(session.shop, { search, page })
      : Promise.resolve({ skus: [] as SkuDetail[], total: 0 }),
  ]);

  const unpublishedSkus        = unpublishedResult.skus;
  const unpublishedTotal       = unpublishedResult.total;
  const unpublishedTotalPages  = Math.ceil(unpublishedTotal / 50);

  return {
    ...result, search, status, tab, activeSyncJob,
    unpublishedCount, unpublishedSkus, unpublishedTotal, unpublishedTotalPages,
  };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusTone(status: string | null) {
  switch (status) {
    case "active":   return "success";
    case "archived": return "neutral";
    case "draft":    return "caution";
    default:         return "neutral";
  }
}

async function downloadBlob(url: string, filename: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Export failed: ${res.status}`);
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(objectUrl);
}

// ── Sync progress banner ─────────────────────────────────────────────────────

function SyncProgressBanner({ job }: { job: SyncJob }) {
  const pollFetcher   = useFetcher<{ job: SyncJob | null }>();
  const cancelFetcher = useFetcher<{ ok: boolean }>();
  const { revalidate } = useRevalidator();

  useEffect(() => {
    if (!["running", "pending", "processing"].includes(job.status ?? "")) return;
    const interval = setInterval(() => { pollFetcher.load("/api/sync"); }, 5000);
    return () => clearInterval(interval);
  }, [job.status]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (pollFetcher.data === undefined) return;
    const polled = pollFetcher.data.job;
    // "job: null" means the active-job lookup no longer finds it — which, once we
    // were already tracking it, only happens because it just finished (completed
    // jobs are excluded from that lookup by design). Treat that as done too, or the
    // banner falls back to the stale `job` prop below and never clears.
    if (!polled || polled.status === "completed" || polled.status === "cancelled") {
      revalidate();
    }
  }, [pollFetcher.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const polledJob = pollFetcher.data !== undefined ? pollFetcher.data.job : job;
  if (!polledJob) return null; // finished — parent will revalidate and unmount us
  const processed  = polledJob.records_processed ?? 0;
  const isBulk     = polledJob.type === "bulk_publish";
  const total      = isBulk ? ((polledJob.payload as { total?: number } | null)?.total ?? 0) : 0;
  const isCancelling = cancelFetcher.state !== "idle";

  if (polledJob.status === "failed") {
    return (
      <s-banner tone="critical" heading="Error en la sincronización">
        <s-paragraph>{polledJob.error_message ?? "Se produjo un error desconocido."}</s-paragraph>
      </s-banner>
    );
  }

  if (polledJob.status === "cancelled") {
    return <s-banner tone="warning" heading="Publicación cancelada." />;
  }

  const heading = isBulk
    ? total > 0
      ? `Publicando ${processed} de ${total} SKUs en Shopify…`
      : `Publicando SKUs en Shopify… (${processed} listos)`
    : "Sincronizando productos desde Shopify…";

  const body = isBulk
    ? "Este proceso puede tardar varios minutos. Puedes cancelarlo en cualquier momento."
    : processed > 0
      ? `${processed} objetos procesados. Esto puede tardar unos minutos.`
      : "Iniciando operación bulk… esto puede tardar unos minutos.";

  return (
    <s-banner tone="info" heading={heading}>
      <s-stack direction="block" gap="base">
        <s-paragraph>{body}</s-paragraph>
        {isBulk && total > 0 && (
          <div style={{
            height: "8px", background: "var(--p-color-bg-surface-secondary, #e4e5e7)",
            borderRadius: "4px", overflow: "hidden",
          }}>
            <div style={{
              width: `${Math.min((processed / total) * 100, 100)}%`,
              height: "100%",
              background: "var(--p-color-bg-fill-emphasis, #008060)",
              borderRadius: "4px",
              transition: "width 0.5s ease",
            }} />
          </div>
        )}
        <cancelFetcher.Form method="post" action="/api/cancel-job">
          <input type="hidden" name="jobId" value={polledJob.id ?? ""} />
          <s-button
            type="submit"
            tone="critical"
            variant="secondary"
            {...(isCancelling ? { loading: true } : {})}
          >
            {isBulk ? "Cancelar publicación" : "Cancelar sincronización"}
          </s-button>
        </cancelFetcher.Form>
      </s-stack>
    </s-banner>
  );
}

// ── Bsale search-and-publish (on-demand, never a bulk import) ─────────────────

type PublishItemResult = { sku_code: string; success: boolean; error?: string };

function BsaleSearchPanel({ onPublished }: { onPublished: () => void }) {
  const [query,    setQuery]    = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [done,     setDone]     = useState<Set<string>>(new Set());
  const [errors,   setErrors]   = useState<Map<string, string>>(new Map());

  const searchFetcher  = useFetcher<{ results: BsaleSearchVariant[]; error?: string }>();
  const publishFetcher = useFetcher<{ results: PublishItemResult[] }>();

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) return;
    const t = setTimeout(() => {
      searchFetcher.load(`/api/bsale/search?q=${encodeURIComponent(trimmed)}`);
    }, 400);
    return () => clearTimeout(t);
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!publishFetcher.data?.results) return;
    setDone((prev) => {
      const next = new Set(prev);
      for (const r of publishFetcher.data!.results) if (r.success) next.add(r.sku_code);
      return next;
    });
    setErrors((prev) => {
      const next = new Map(prev);
      for (const r of publishFetcher.data!.results) {
        if (r.success) next.delete(r.sku_code);
        else next.set(r.sku_code, r.error ?? "Error desconocido");
      }
      return next;
    });
    setSelected(new Set());
    onPublished();
  }, [publishFetcher.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const results      = searchFetcher.data?.results ?? [];
  const isSearching  = searchFetcher.state !== "idle";
  const isPublishing = publishFetcher.state !== "idle";

  function toggle(code: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });
  }

  function publish(items: BsaleSearchVariant[]) {
    publishFetcher.submit(JSON.stringify({ items }), {
      method: "post", action: "/api/bsale/publish", encType: "application/json",
    });
  }

  return (
    <s-box padding="large" borderWidth="small" borderRadius="base" background="base">
      <s-stack direction="block" gap="base">
        <p style={{ margin: 0, fontSize: "var(--p-font-size-400, 1rem)", fontWeight: "var(--p-font-weight-bold, 700)" as React.CSSProperties["fontWeight"] }}>
          Buscar en Bsale
        </p>
        <s-text color="subdued">
          Busca por código SKU exacto o por nombre de producto (parcial). No importa todo el catálogo — solo trae lo que buscas, para crearlo en Shopify al instante.
        </s-text>
        <s-text color="subdued">
          El producto se crea como <strong>borrador (inactivo)</strong> con SKU, nombre, precio, código de barras y stock.
          Como Bsale no aporta imágenes ni descripción, no queda visible en la tienda: complétalo en Shopify y actívalo tú.
        </s-text>

        <div style={{ maxWidth: "400px" }}>
          <s-search-field
            label="Buscar en Bsale"
            label-accessibility-visibility="hidden"
            placeholder="Ej: ANZ410 o Mochila Doite…"
            value={query}
            onInput={(e: Event) => setQuery((e.target as HTMLInputElement).value)}
          />
        </div>

        {searchFetcher.data?.error && <s-banner tone="critical" heading={searchFetcher.data.error} />}
        {isSearching && <s-spinner />}

        {!isSearching && query.trim().length >= 2 && results.length === 0 && !searchFetcher.data?.error && (
          <s-text color="subdued">No se encontraron productos en Bsale para &quot;{query.trim()}&quot;.</s-text>
        )}

        {results.length > 0 && (
          <s-stack direction="block" gap="small">
            {selected.size > 0 && (
              <s-button
                variant="primary"
                onClick={() => publish(results.filter((r) => selected.has(r.sku_code)))}
                {...(isPublishing ? { loading: true } : {})}
              >
                Publicar {selected.size} seleccionado{selected.size !== 1 ? "s" : ""}
              </s-button>
            )}

            <div style={{ border: "1px solid var(--p-color-border, #e1e3e5)", borderRadius: "var(--p-border-radius-200, 8px)", overflow: "hidden" }}>
              <div style={{
                display: "grid", gridTemplateColumns: "32px 140px 1fr 100px 130px",
                padding: "8px 16px", background: "var(--p-color-bg-surface-secondary, #f6f6f7)",
                borderBottom: "1px solid var(--p-color-border, #e1e3e5)",
              }}>
                {(["", "SKU", "Producto", "Precio", ""] as const).map((label, i) => (
                  <span key={i} style={{ fontSize: "var(--p-font-size-300, 0.75rem)", fontWeight: 600, color: "var(--p-color-text-subdued, #6d7175)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    {label}
                  </span>
                ))}
              </div>
              {results.map((r, idx) => {
                const isDone = done.has(r.sku_code);
                const err    = errors.get(r.sku_code);
                return (
                  <div
                    key={r.bsale_variant_id}
                    style={{
                      display: "grid", gridTemplateColumns: "32px 140px 1fr 100px 130px",
                      padding: "10px 16px", alignItems: "center",
                      background: idx % 2 === 0 ? "var(--p-color-bg-surface, #ffffff)" : "var(--p-color-bg-surface-secondary, #f6f6f7)",
                      borderBottom: idx < results.length - 1 ? "1px solid var(--p-color-border-subdued, #e1e3e5)" : "none",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(r.sku_code)}
                      disabled={isDone}
                      onChange={() => toggle(r.sku_code)}
                    />
                    <span style={{ fontWeight: 600, fontFamily: "monospace", fontSize: "var(--p-font-size-350, 0.875rem)" }}>{r.sku_code}</span>
                    <span style={{ fontSize: "var(--p-font-size-350, 0.875rem)" }}>
                      {r.product_name}{r.variant_description ? ` - ${r.variant_description}` : ""}
                    </span>
                    <span style={{ fontSize: "var(--p-font-size-350, 0.875rem)" }}>
                      {r.price != null ? `$${r.price.toLocaleString("es-CL")}` : <s-badge tone="warning">Sin precio</s-badge>}
                    </span>
                    <span>
                      {isDone ? (
                        <s-badge tone="success">Borrador creado ✓</s-badge>
                      ) : err ? (
                        <s-badge tone="critical">{err}</s-badge>
                      ) : (
                        <s-button variant="secondary" onClick={() => publish([r])} {...(isPublishing ? { loading: true } : {})}>
                          Publicar
                        </s-button>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </s-stack>
        )}
      </s-stack>
    </s-box>
  );
}

// ── Unpublished SKU row (per-row publish fetcher) ─────────────────────────────

const CELL = { fontSize: "var(--p-font-size-350, 0.875rem)" } as React.CSSProperties;
const CELL_TRUNCATE: React.CSSProperties = { ...CELL, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

function UnpublishedSkuRow({
  sku,
  idx,
  onPublished,
}: {
  sku:         SkuDetail;
  idx:         number;
  onPublished: (id: string) => void;
}) {
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const { t } = useTranslation();

  useEffect(() => {
    if (fetcher.data?.success) onPublished(sku.id);
  }, [fetcher.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const isPublishing = fetcher.state !== "idle";
  const published    = fetcher.data?.success === true;

  return (
    <div
      style={{
        display:       "grid",
        gridTemplateColumns: "200px 1fr 120px 90px 130px 100px",
        padding:       "12px 16px",
        alignItems:    "center",
        background:    idx % 2 === 0
          ? "var(--p-color-bg-surface, #ffffff)"
          : "var(--p-color-bg-surface-secondary, #f6f6f7)",
        opacity:       published ? 0.4 : 1,
        transition:    "opacity 0.3s",
      }}
    >
      <span style={{ fontWeight: 600, ...CELL }}>{sku.sku_code}</span>
      <span style={CELL_TRUNCATE}>{sku.title ?? "—"}</span>
      <span style={CELL_TRUNCATE}>{sku.vendor ?? "—"}</span>
      <span style={CELL}>
        {sku.sale_price != null
          ? `$${Number(sku.sale_price).toLocaleString("es-CL")}`
          : <s-badge tone="warning">Sin precio</s-badge>}
      </span>
      <span style={{ ...CELL, color: "var(--p-color-text-subdued, #6d7175)" }}>
        {sku.created_at ? new Date(sku.created_at).toLocaleDateString("es-MX") : "—"}
      </span>
      <span>
        {published ? (
          <s-badge tone="success">{t('skus.published')}</s-badge>
        ) : fetcher.data?.error ? (
          <s-badge tone="critical">{t('common.error')}</s-badge>
        ) : (
          <fetcher.Form method="post" action="/api/publish-sku">
            <input type="hidden" name="sku_id" value={sku.id} />
            <s-button
              type="submit"
              variant="secondary"
              {...(isPublishing ? { loading: true } : {})}
            >
              {t('skus.publish')}
            </s-button>
          </fetcher.Form>
        )}
      </span>
    </div>
  );
}

// ── Page component ────────────────────────────────────────────────────────────

export default function SkusIndex() {
  const {
    skus, total, page, totalPages, search, status, tab, activeSyncJob,
    unpublishedCount, unpublishedSkus, unpublishedTotal, unpublishedTotalPages,
  } = useLoaderData<typeof loader>();

  const navigation    = useNavigation();
  const navigate      = useNavigate();
  const shopifyParams = useShopifyParams();
  const { t } = useTranslation();
  const [localSearch, setLocalSearch] = useState(search);
  const [hiddenIds, setHiddenIds]     = useState<Set<string>>(new Set());
  const { revalidate }                = useRevalidator();

  const visibleUnpublished = (unpublishedSkus as SkuDetail[]).filter((s) => !hiddenIds.has(s.id));

  function handlePublished(id: string) {
    setHiddenIds((prev) => new Set([...prev, id]));
    revalidate();
  }

  const isLoading = navigation.state === "loading";
  const isImporting =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "import";

  const isSyncing =
    activeSyncJob !== null &&
    ["running", "pending", "processing"].includes(activeSyncJob.status ?? "");

  // Build a filtered URL, preserving current search/status/tab params
  function pageUrl(newPage: number, s = search, st: string = status, t = tab): string {
    const p = new URLSearchParams();
    if (s) p.set("search", s);
    if (st) p.set("status", st);
    if (t) p.set("tab", t);
    if (newPage > 1) p.set("page", String(newPage));
    return `?${p.toString()}`;
  }

  // Debounced navigate when search changes
  useEffect(() => {
    const t = setTimeout(() => {
      navigate(pageUrl(1, localSearch, status));
    }, 350);
    return () => clearTimeout(t);
  }, [localSearch]); // eslint-disable-line react-hooks/exhaustive-deps

  // Immediate navigate when status changes
  function handleStatusChange(e: Event) {
    const newStatus = (e.target as HTMLSelectElement).value;
    navigate(pageUrl(1, localSearch, newStatus));
  }

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

  return (
    <s-page heading={t('skus.title')}>
      {activeSyncJob && <SyncProgressBanner job={activeSyncJob as SyncJob} />}

      {/* ── Tab navigation ── */}
      <s-section>
        <div style={{ display: "flex", gap: "0", borderBottom: "1px solid var(--p-color-border, #e1e3e5)" }}>
          <button style={TAB_STYLE(tab !== "unpublished")} onClick={() => navigate("?")}>
            {t('skus.all')}
          </button>
          <button
            style={TAB_STYLE(tab === "unpublished")}
            onClick={() => navigate("?tab=unpublished")}
          >
            {t('skus.unpublished')}{unpublishedCount > 0 ? ` (${unpublishedCount})` : ""}
          </button>
        </div>
      </s-section>

      {/* ── Unpublished tab ── */}
      {tab === "unpublished" && (
        <s-section>
          <s-stack direction="block" gap="base">
            <s-banner tone="info">
              <s-paragraph>
                {t('skus.unpublishedBanner')}
              </s-paragraph>
            </s-banner>

            <BsaleSearchPanel onPublished={() => revalidate()} />

            {unpublishedCount === 0 ? null : (
              <s-stack direction="block" gap="base">
                <p style={{ margin: 0, fontSize: "var(--p-font-size-400, 1rem)", fontWeight: "var(--p-font-weight-bold, 700)" as React.CSSProperties["fontWeight"] }}>
                  Pendientes en SkuBeam
                </p>
                {/* Search — reuses localSearch + debounced navigate (tab preserved in URL) */}
                <div style={{ maxWidth: "320px" }}>
                  <s-search-field
                    label="Buscar SKU"
                    label-accessibility-visibility="hidden"
                    placeholder="Buscar por código o título…"
                    value={localSearch}
                    onInput={(e: Event) =>
                      setLocalSearch((e.target as HTMLInputElement).value)
                    }
                  />
                </div>

                {visibleUnpublished.length === 0 && search ? (
                  <s-paragraph>No se encontraron SKUs con esa búsqueda.</s-paragraph>
                ) : visibleUnpublished.length === 0 ? (
                  <s-paragraph>No hay SKUs sin publicar. ✓</s-paragraph>
                ) : (
                  <div style={{ border: "1px solid var(--p-color-border, #e1e3e5)", borderRadius: "var(--p-border-radius-200, 8px)", overflow: "hidden" }}>
                    {/* Header */}
                    <div style={{
                      display: "grid",
                      gridTemplateColumns: "200px 1fr 120px 90px 130px 100px",
                      padding: "8px 16px",
                      background: "var(--p-color-bg-surface-secondary, #f6f6f7)",
                      borderBottom: "1px solid var(--p-color-border, #e1e3e5)",
                    }}>
                      {(["SKU", "Nombre", "Vendor", "Precio", "Creado", ""] as const).map((label, i) => (
                        <span key={i} style={{ fontSize: "var(--p-font-size-300, 0.75rem)", fontWeight: 600, color: "var(--p-color-text-subdued, #6d7175)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                          {label}
                        </span>
                      ))}
                    </div>
                    {/* Rows */}
                    {visibleUnpublished.map((sku, idx) => (
                      <UnpublishedSkuRow
                        key={sku.id}
                        sku={sku}
                        idx={idx}
                        onPublished={handlePublished}
                      />
                    ))}
                  </div>
                )}

                {/* Server-side pagination */}
                {unpublishedTotalPages > 1 && (
                  <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                    <s-text color="subdued">
                      Página {page} de {unpublishedTotalPages} · {unpublishedTotal} SKU{unpublishedTotal !== 1 ? "s" : ""}
                    </s-text>
                    <s-stack direction="inline" gap="small">
                      <s-button
                        variant="tertiary"
                        {...(page <= 1 ? { disabled: true } : {})}
                        onClick={() => navigate(pageUrl(page - 1))}
                      >
                        ← Anterior
                      </s-button>
                      <s-button
                        variant="tertiary"
                        {...(page >= unpublishedTotalPages ? { disabled: true } : {})}
                        onClick={() => navigate(pageUrl(page + 1))}
                      >
                        Siguiente →
                      </s-button>
                    </s-stack>
                  </s-stack>
                )}
              </s-stack>
            )}
          </s-stack>
        </s-section>
      )}

      {/* ── Main tab content (Todos) ── */}
      {tab !== "unpublished" && (
      <>
      {/* ── Toolbar: search + status left, export right ── */}
      {total > 0 && (
        <s-section>
          <s-stack
            direction="inline"
            justifyContent="space-between"
            alignItems="center"
            gap="base"
          >
            {/* Left: search + status select */}
            <s-stack direction="inline" gap="base" alignItems="center">
              <div style={{ width: "280px" }}>
                <s-search-field
                  label="Buscar SKU"
                  label-accessibility-visibility="hidden"
                  placeholder="Buscar por código o título…"
                  value={localSearch}
                  onInput={(e: Event) =>
                    setLocalSearch((e.target as HTMLInputElement).value)
                  }
                />
              </div>
              <div style={{ width: "160px" }}>
                <s-select
                  label="Estado"
                  label-accessibility-visibility="hidden"
                  value={status}
                  onChange={handleStatusChange}
                >
                  <s-option value="">Todos</s-option>
                  <s-option value="active">Activo</s-option>
                  <s-option value="draft">Borrador</s-option>
                  <s-option value="archived">Archivado</s-option>
                </s-select>
              </div>
            </s-stack>

            {/* Right: export */}
            <s-button
              variant="tertiary"
              icon="export"
              onClick={() =>
                downloadBlob(
                  `/api/skus/export${shopifyParams}`,
                  "skus-export.csv",
                )
              }
            >
              {t('skus.exportCsv')}
            </s-button>
          </s-stack>
        </s-section>
      )}

      {/* ── Main content ── */}
      <s-section>
        {skus.length === 0 ? (
          /* ── Empty states ── */
          <s-stack direction="block" gap="base">
            {isLoading ? (
              <s-spinner />
            ) : search || status ? (
              <s-paragraph>
                No se encontraron SKUs con esos filtros.
              </s-paragraph>
            ) : isSyncing ? (
              <s-paragraph>
                La importación está en curso. Los SKUs aparecerán aquí cuando
                termine.
              </s-paragraph>
            ) : (
              <>
                <s-paragraph>
                  No hay SKUs sincronizados todavía. Importa tu catálogo desde
                  Shopify para empezar.
                </s-paragraph>
                <Form method="post">
                  <input type="hidden" name="intent" value="import" />
                  <s-button
                    type="submit"
                    {...(isImporting ? { loading: true } : {})}
                  >
                    Importar desde Shopify
                  </s-button>
                </Form>
              </>
            )}
          </s-stack>
        ) : (
          <s-stack direction="block" gap="base">
            {/* ── Grid table ── */}
            <div
              style={{
                border: "1px solid var(--p-color-border, #e1e3e5)",
                borderRadius: "var(--p-border-radius-200, 8px)",
                overflow: "hidden",
                opacity: isLoading ? 0.6 : 1,
                transition: "opacity 0.15s",
              }}
            >
              {/* Header row */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "200px 1fr 120px 100px 70px 70px 56px",
                  padding: "8px 16px",
                  background: "var(--p-color-bg-surface-secondary, #f6f6f7)",
                  borderBottom: "1px solid var(--p-color-border, #e1e3e5)",
                }}
              >
                {(["SKU", "Producto", "Vendor", "Estado", "Stock", "Vend. 30d", ""] as const).map(
                  (label, i) => (
                    <span
                      key={i}
                      style={{
                        fontSize: "var(--p-font-size-300, 0.75rem)",
                        fontWeight: 600,
                        color: "var(--p-color-text-subdued, #6d7175)",
                        textTransform: "uppercase",
                        letterSpacing: "0.04em",
                      }}
                    >
                      {label}
                    </span>
                  ),
                )}
              </div>

              {/* Data rows */}
              {skus.map((sku, idx) => (
                <div
                  key={sku.id ?? sku.sku_code}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "200px 1fr 120px 100px 70px 70px 56px",
                    padding: "12px 16px",
                    alignItems: "center",
                    background:
                      idx % 2 === 0
                        ? "var(--p-color-bg-surface, #ffffff)"
                        : "var(--p-color-bg-surface-secondary, #f6f6f7)",
                    borderBottom:
                      idx < skus.length - 1
                        ? "1px solid var(--p-color-border-subdued, #e1e3e5)"
                        : "none",
                  }}
                >
                  <span style={{ fontWeight: 600, fontSize: "var(--p-font-size-350, 0.875rem)" }}>
                    {sku.sku_code}
                  </span>
                  <span
                    style={{
                      fontSize: "var(--p-font-size-350, 0.875rem)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {sku.title ?? "—"}
                  </span>
                  <span
                    style={{
                      fontSize: "var(--p-font-size-350, 0.875rem)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {sku.vendor ?? "—"}
                  </span>
                  <span>
                    <s-badge tone={statusTone(sku.status)}>
                      {sku.status ?? "—"}
                    </s-badge>
                  </span>
                  <span style={{ fontSize: "var(--p-font-size-350, 0.875rem)" }}>
                    {sku.total_stock ?? 0}
                  </span>
                  <span style={{ fontSize: "var(--p-font-size-350, 0.875rem)" }}>
                    {sku.sold_30d ?? 0}
                  </span>
                  <span>
                    <s-link href={`/app/skus/${sku.id}${shopifyParams}`}>
                      Ver
                    </s-link>
                  </span>
                </div>
              ))}
            </div>

            {/* ── Pagination + page info ── */}
            <s-stack direction="inline" justifyContent="space-between" alignItems="center">
              <s-text color="subdued">
                Página {page} de {totalPages} · {total} SKU
                {total !== 1 ? "s" : ""}
              </s-text>
              {totalPages > 1 && (
                <s-stack direction="inline" gap="small">
                  <s-button
                    variant="tertiary"
                    {...(page <= 1 ? { disabled: true } : {})}
                    onClick={() => navigate(pageUrl(page - 1))}
                  >
                    ← Anterior
                  </s-button>
                  <s-button
                    variant="tertiary"
                    {...(page >= totalPages ? { disabled: true } : {})}
                    onClick={() => navigate(pageUrl(page + 1))}
                  >
                    Siguiente →
                  </s-button>
                </s-stack>
              )}
            </s-stack>
          </s-stack>
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
