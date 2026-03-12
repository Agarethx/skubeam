import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useEffect, useRef } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getForecastForShop, hasSalesData } from "../models/forecast.server";
import { getActiveSyncJob } from "../models/sync.server";
import type { ForecastRow } from "../models/forecast.server";

// ── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  const [{ rows, config }, salesData, activeJob] = await Promise.all([
    getForecastForShop(shopId),
    hasSalesData(shopId),
    getActiveSyncJob(shopId),
  ]);

  return { rows, config, salesData, activeJob };
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function statusTone(status: ForecastRow["status"]) {
  switch (status) {
    case "critical": return "critical";
    case "low":      return "caution";
    case "dead":     return "warning";
    default:         return "success";
  }
}

function statusLabel(status: ForecastRow["status"]) {
  switch (status) {
    case "critical": return "Crítico";
    case "low":      return "Bajo";
    case "dead":     return "Sin rotación";
    default:         return "OK";
  }
}

function fmt(n: number) {
  return n.toFixed(n % 1 === 0 ? 0 : 2);
}

// ── UI ───────────────────────────────────────────────────────────────────────

export default function ForecastPage() {
  const { rows, config, salesData, activeJob } =
    useLoaderData<typeof loader>();

  // Starts the orders sync job
  const startFetcher = useFetcher<{
    job: { id: string; status: string; type: string };
  }>();

  // Polls /api/sync/status (no auth required — no ?shop=&host= needed)
  const statusFetcher = useFetcher<{
    status: string | null;
    records_processed: number;
  }>();

  const revalidator = useRevalidator();
  const pollRef     = useRef<ReturnType<typeof setInterval> | null>(null);

  // Resolve the job ID: prefer a freshly-started job, fall back to loader
  const jobId =
    (startFetcher.data?.job?.type === "orders_sync"
      ? startFetcher.data.job.id
      : null) ?? activeJob?.id;

  const polledStatus = statusFetcher.data?.status;
  const isRunning =
    !!jobId &&
    polledStatus !== "completed" &&
    polledStatus !== "failed";

  // Start polling when we have a jobId
  useEffect(() => {
    if (!jobId) return;

    pollRef.current = setInterval(() => {
      statusFetcher.load(`/api/sync/status?jobId=${jobId}`);
    }, 3000);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [jobId]); // eslint-disable-line react-hooks/exhaustive-deps

  // When job finishes, stop polling and reload the forecast data
  useEffect(() => {
    if (polledStatus === "completed" || polledStatus === "failed") {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      revalidator.revalidate();
    }
  }, [polledStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  const criticalCount = rows.filter((r) => r.status === "critical").length;
  const lowCount      = rows.filter((r) => r.status === "low").length;
  const deadCount     = rows.filter((r) => r.status === "dead").length;

  return (
    <s-page heading="Forecast & Reposición">
      {/* ── Aside: summary ── */}
      <s-section slot="aside" heading="Resumen">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small">
            <s-badge tone="critical">{criticalCount} críticos</s-badge>
            <s-badge tone="caution">{lowCount} bajos</s-badge>
            <s-badge tone="warning">{deadCount} sin rotación</s-badge>
          </s-stack>
          <s-text>
            Config: lead {config.reorder_lead_days}d · safety{" "}
            {config.safety_stock_days}d · ventana {config.forecast_window_days}d
          </s-text>
        </s-stack>
      </s-section>

      {/* ── Aside: import orders ── */}
      <s-section slot="aside" heading="Historial de ventas">
        {isRunning ? (
          <s-stack direction="block" gap="small">
            <s-spinner />
            <s-text>
              Importando órdenes…
              {(statusFetcher.data?.records_processed ?? 0) > 0
                ? ` (${statusFetcher.data!.records_processed} líneas)`
                : ""}
            </s-text>
          </s-stack>
        ) : (
          <s-stack direction="block" gap="small">
            {salesData ? (
              <s-badge tone="success">Datos importados</s-badge>
            ) : (
              <s-text>
                Sin historial de ventas. Importa para calcular velocidad y
                reorder points.
              </s-text>
            )}

            <startFetcher.Form method="post" action="/api/sync">
              <input type="hidden" name="type" value="orders" />
              <s-button
                type="submit"
                variant="secondary"
                {...(startFetcher.state !== "idle" ? { loading: true } : {})}
              >
                {salesData ? "Re-importar historial" : "Importar historial de ventas"}
              </s-button>
            </startFetcher.Form>

            {polledStatus === "failed" && (
              <s-banner
                tone="critical"
                heading="La importación falló. Intenta de nuevo."
              />
            )}
          </s-stack>
        )}
      </s-section>

      {/* ── Main: forecast table ── */}
      <s-section heading={`Forecast por SKU (${rows.length} activos)`}>
        {rows.length === 0 ? (
          <s-paragraph>No hay SKUs activos.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header>
              <s-table-header-row>
                <s-table-cell>SKU</s-table-cell>
                <s-table-cell>Título</s-table-cell>
                <s-table-cell>Stock</s-table-cell>
                <s-table-cell>Vel. diaria</s-table-cell>
                <s-table-cell>Reorder point</s-table-cell>
                <s-table-cell>Días restantes</s-table-cell>
                <s-table-cell>Estado</s-table-cell>
              </s-table-header-row>
            </s-table-header>
            <s-table-body>
              {rows.map((row) => (
                <s-table-row key={row.id}>
                  <s-table-cell>
                    <s-text>{row.sku_code}</s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <s-text>{row.title ?? "—"}</s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={row.total_stock > 0 ? "success" : "critical"}>
                      {row.total_stock}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    {row.daily_velocity > 0 ? fmt(row.daily_velocity) : "—"}
                  </s-table-cell>
                  <s-table-cell>
                    {row.daily_velocity > 0 ? row.reorder_point : "—"}
                  </s-table-cell>
                  <s-table-cell>
                    {row.days_left !== null ? `${row.days_left}d` : "—"}
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={statusTone(row.status)}>
                      {statusLabel(row.status)}
                    </s-badge>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
