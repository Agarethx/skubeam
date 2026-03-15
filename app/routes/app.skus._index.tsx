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
import { authenticate } from "../shopify.server";
import { useShopifyParams } from "../lib/navigate";
import { listSkus, listUnpublishedSkus, getUnpublishedCount } from "../models/sku.server";
import type { SkuStatus, SkuDetail } from "../models/sku.server";
import { getActiveSyncJob, startBulkSync } from "../models/sync.server";
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

  const [result, activeSyncJob, unpublishedCount, unpublishedSkus] = await Promise.all([
    tab === "unpublished" ? Promise.resolve({ skus: [], total: 0, page: 1, pageSize: 50, totalPages: 0 }) : listSkus(session.shop, { search, status, page }),
    getActiveSyncJob(session.shop),
    getUnpublishedCount(session.shop),
    tab === "unpublished" ? listUnpublishedSkus(session.shop).then((r) => r.skus) : Promise.resolve([] as SkuDetail[]),
  ]);

  return { ...result, search, status, tab, activeSyncJob, unpublishedCount, unpublishedSkus };
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
  const fetcher = useFetcher<{ job: SyncJob | null }>();
  const { revalidate } = useRevalidator();

  useEffect(() => {
    if (job.status !== "running" && job.status !== "pending") return;
    const interval = setInterval(() => { fetcher.load("/api/sync"); }, 5000);
    return () => clearInterval(interval);
  }, [job.status]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (fetcher.data?.job?.status === "completed") revalidate();
  }, [fetcher.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const polledJob = fetcher.data?.job ?? job;
  const processed = polledJob.records_processed ?? 0;

  if (polledJob.status === "failed") {
    return (
      <s-banner tone="critical" heading="Error en la sincronización">
        <s-paragraph>
          {polledJob.error_message ?? "Se produjo un error desconocido."}
        </s-paragraph>
      </s-banner>
    );
  }

  return (
    <s-banner tone="info" heading="Sincronizando productos desde Shopify…">
      <s-paragraph>
        {processed > 0
          ? `${processed} objetos procesados. Esto puede tardar unos minutos.`
          : "Iniciando operación bulk… esto puede tardar unos minutos."}
      </s-paragraph>
    </s-banner>
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
      <span style={CELL}>{sku.cost_price != null ? `$${sku.cost_price}` : "—"}</span>
      <span style={{ ...CELL, color: "var(--p-color-text-subdued, #6d7175)" }}>
        {sku.created_at ? new Date(sku.created_at).toLocaleDateString("es-MX") : "—"}
      </span>
      <span>
        {published ? (
          <s-badge tone="success">✓ Publicado</s-badge>
        ) : fetcher.data?.error ? (
          <s-badge tone="critical">Error</s-badge>
        ) : (
          <fetcher.Form method="post" action="/api/publish-sku">
            <input type="hidden" name="sku_id" value={sku.id} />
            <s-button
              type="submit"
              variant="secondary"
              {...(isPublishing ? { loading: true } : {})}
            >
              Publicar
            </s-button>
          </fetcher.Form>
        )}
      </span>
    </div>
  );
}

// ── Page component ────────────────────────────────────────────────────────────

export default function SkusIndex() {
  const { skus, total, page, totalPages, search, status, tab, activeSyncJob, unpublishedCount, unpublishedSkus } =
    useLoaderData<typeof loader>();

  const navigation    = useNavigation();
  const navigate      = useNavigate();
  const shopifyParams = useShopifyParams();
  const [localSearch, setLocalSearch] = useState(search);
  const [hiddenIds, setHiddenIds]     = useState<Set<string>>(new Set());
  const { revalidate }                = useRevalidator();

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
    (activeSyncJob.status === "running" || activeSyncJob.status === "pending");

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
    <s-page heading="SKUs">
      {activeSyncJob && <SyncProgressBanner job={activeSyncJob as SyncJob} />}

      {/* ── Tab navigation ── */}
      <s-section>
        <div style={{ display: "flex", gap: "0", borderBottom: "1px solid var(--p-color-border, #e1e3e5)" }}>
          <button style={TAB_STYLE(tab !== "unpublished")} onClick={() => navigate("?")}>
            Todos los SKUs
          </button>
          <button
            style={TAB_STYLE(tab === "unpublished")}
            onClick={() => navigate("?tab=unpublished")}
          >
            Sin publicar{unpublishedCount > 0 ? ` (${unpublishedCount})` : ""}
          </button>
        </div>
      </s-section>

      {/* ── Unpublished tab ── */}
      {tab === "unpublished" && (
        <s-section>
          <s-stack direction="block" gap="base">
            <s-banner tone="info">
              <s-paragraph>
                Estos SKUs están en SkuBeam pero no en Shopify. Pueden venir de una migración
                WooCommerce o haber sido creados manualmente.
              </s-paragraph>
            </s-banner>

            {unpublishedSkus.length === 0 ? (
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
                  {(["SKU", "Nombre", "Vendor", "Costo", "Creado", ""] as const).map((label, i) => (
                    <span key={i} style={{ fontSize: "var(--p-font-size-300, 0.75rem)", fontWeight: 600, color: "var(--p-color-text-subdued, #6d7175)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                      {label}
                    </span>
                  ))}
                </div>
                {/* Rows */}
                {(unpublishedSkus as SkuDetail[])
                  .filter((s) => !hiddenIds.has(s.id))
                  .map((sku, idx) => (
                    <UnpublishedSkuRow
                      key={sku.id}
                      sku={sku}
                      idx={idx}
                      onPublished={handlePublished}
                    />
                  ))}
              </div>
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
              Exportar CSV
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
