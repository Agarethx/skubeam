import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  Form,
  useLoaderData,
  useNavigation,
  useFetcher,
  useRevalidator,
} from "react-router";
import { useEffect } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { useShopifyParams } from "../lib/navigate";
import { listSkus } from "../models/sku.server";
import type { SkuStatus } from "../models/sku.server";
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

  const url = new URL(request.url);
  const search = url.searchParams.get("search") ?? "";
  const status = (url.searchParams.get("status") ?? "") as SkuStatus | "";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));

  const [result, activeSyncJob] = await Promise.all([
    listSkus(session.shop, { search, status, page }),
    getActiveSyncJob(session.shop),
  ]);

  return { ...result, search, status, activeSyncJob };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusTone(status: string | null) {
  switch (status) {
    case "active":
      return "success";
    case "archived":
      return "neutral";
    case "draft":
      return "caution";
    default:
      return "neutral";
  }
}

// ── Sync progress banner ─────────────────────────────────────────────────────

function SyncProgressBanner({ job }: { job: SyncJob }) {
  const fetcher = useFetcher<{ job: SyncJob | null }>();
  const { revalidate } = useRevalidator();

  useEffect(() => {
    if (job.status !== "running" && job.status !== "pending") return;

    const interval = setInterval(() => {
      fetcher.load("/api/sync");
    }, 5000);

    return () => clearInterval(interval);
  }, [job.status]);

  useEffect(() => {
    const polledJob = fetcher.data?.job;
    if (polledJob && polledJob.status === "completed") {
      revalidate();
    }
  }, [fetcher.data]);

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
    <s-banner
      tone="info"
      heading="Sincronizando productos desde Shopify…"
    >
      <s-paragraph>
        {processed > 0
          ? `${processed} objetos procesados. Esto puede tardar unos minutos.`
          : "Iniciando operación bulk… esto puede tardar unos minutos."}
      </s-paragraph>
    </s-banner>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

async function downloadBlob(url: string, filename: string, method = "GET") {
  const res = await fetch(url, { method });
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

export default function SkusIndex() {
  const { skus, total, page, totalPages, search, status, activeSyncJob } =
    useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const shopifyParams = useShopifyParams();
  const isLoading = navigation.state === "loading";
  const isImporting =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "import";

  const isSyncing =
    activeSyncJob !== null &&
    (activeSyncJob.status === "running" || activeSyncJob.status === "pending");

  return (
    <s-page heading="SKUs">
      {/* Sync progress banner */}
      {activeSyncJob && (
        <SyncProgressBanner job={activeSyncJob as SyncJob} />
      )}

      {/* Filters — hidden during initial import */}
      {total > 0 && (
        <s-section>
          <s-stack direction="inline" gap="base" align-items="end">
            <Form method="get" style={{ flex: 1 }}>
              <s-stack direction="inline" gap="base">
                <s-search-field
                  name="search"
                  label="Buscar SKU"
                  label-accessibility-visibility="hidden"
                  placeholder="Buscar por código SKU…"
                  value={search}
                />
                <s-select name="status" label="Estado" value={status}>
                  <s-option value="">Todos</s-option>
                  <s-option value="active">Activo</s-option>
                  <s-option value="draft">Borrador</s-option>
                  <s-option value="archived">Archivado</s-option>
                </s-select>
                <input type="hidden" name="page" value="1" />
                <s-button type="submit" {...(isLoading ? { loading: true } : {})}>
                  Filtrar
                </s-button>
              </s-stack>
            </Form>
            <s-button
              variant="secondary"
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

      <s-section>
        {isLoading ? (
          <s-stack direction="block" gap="base">
            <s-spinner />
          </s-stack>
        ) : skus.length === 0 ? (
          <s-stack direction="block" gap="base">
            {search || status ? (
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
          <>
            <s-table>
              <s-table-header>
                <s-table-header-row>
                  <s-table-cell>Código SKU</s-table-cell>
                  <s-table-cell>Título</s-table-cell>
                  <s-table-cell>Vendor</s-table-cell>
                  <s-table-cell>Estado</s-table-cell>
                  <s-table-cell>Stock total</s-table-cell>
                  <s-table-cell>Vendido 30d</s-table-cell>
                </s-table-header-row>
              </s-table-header>
              <s-table-body>
                {skus.map((sku) => (
                  <s-table-row key={sku.id ?? sku.sku_code}>
                    <s-table-cell>
                      <s-link href={`/app/skus/${sku.id}${shopifyParams}`}>
                        {sku.sku_code}
                      </s-link>
                    </s-table-cell>
                    <s-table-cell>{sku.title ?? "—"}</s-table-cell>
                    <s-table-cell>{sku.vendor ?? "—"}</s-table-cell>
                    <s-table-cell>
                      <s-badge tone={statusTone(sku.status)}>
                        {sku.status ?? "—"}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>{sku.total_stock ?? 0}</s-table-cell>
                    <s-table-cell>{sku.sold_30d ?? 0}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>

            <s-stack direction="inline" gap="base">
              <s-text>
                {total} SKU{total !== 1 ? "s" : ""} · Página {page} de{" "}
                {totalPages}
              </s-text>
              {page > 1 && (
                <Form method="get">
                  <input type="hidden" name="search" value={search} />
                  <input type="hidden" name="status" value={status} />
                  <input type="hidden" name="page" value={String(page - 1)} />
                  <s-button type="submit" variant="tertiary">
                    ← Anterior
                  </s-button>
                </Form>
              )}
              {page < totalPages && (
                <Form method="get">
                  <input type="hidden" name="search" value={search} />
                  <input type="hidden" name="status" value={status} />
                  <input type="hidden" name="page" value={String(page + 1)} />
                  <s-button type="submit" variant="tertiary">
                    Siguiente →
                  </s-button>
                </Form>
              )}
            </s-stack>
          </>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
