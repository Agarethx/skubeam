import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useFetcher, useLoaderData, useNavigate, useNavigation, useRevalidator } from "react-router";
import { useEffect } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  getForecastForShop,
  getSalesCount,
  saveForecastConfig,
} from "../models/forecast.server";
import { getActiveSyncJob } from "../models/sync.server";
import type { ForecastRow } from "../models/forecast.server";
import { useShopifyParams } from "../lib/navigate";

const PAGE_SIZE = 25;
const GRID_COLS = "180px 1fr 80px 100px 100px 120px 80px";

// ── Tone palette ──────────────────────────────────────────────────────────────

const TONE_COLOR = {
  critical: "#D82C0D",
  low:      "#E3911C",
  dead:     "#C05717",
  neutral:  "#6D7175",
} as const;

// ── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;
  const formData = await request.formData();

  if (formData.get("intent") === "saveConfig") {
    await saveForecastConfig(shopId, {
      reorder_lead_days:    Number(formData.get("lead_days"))    || 14,
      safety_stock_days:    Number(formData.get("safety_days"))  || 7,
      forecast_window_days: Number(formData.get("window_days"))  || 30,
    });
  }

  return null;
};

// ── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  const url = new URL(request.url);
  const statusFilter = url.searchParams.get("status") ?? "";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));

  const [{ rows: allRows, config }, salesCount, activeJob] = await Promise.all([
    getForecastForShop(shopId),
    getSalesCount(shopId),
    getActiveSyncJob(shopId),
  ]);

  const criticalCount = allRows.filter((r) => r.status === "critical").length;
  const lowCount      = allRows.filter((r) => r.status === "low").length;
  const deadCount     = allRows.filter((r) => r.status === "dead").length;

  const atRiskValue = allRows
    .filter((r) => r.status === "critical" || r.status === "low")
    .reduce((sum, r) => sum + r.total_stock * (r.sale_price ?? r.cost_price ?? 0), 0);

  const filtered   = statusFilter ? allRows.filter((r) => r.status === statusFilter) : allRows;
  const total      = filtered.length;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const rows       = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return {
    rows, total, page, totalPages,
    config, salesCount, activeJob,
    statusFilter,
    criticalCount, lowCount, deadCount, atRiskValue,
  };
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

function fmtUSD(n: number): string {
  if (n <= 0) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

// ── KPI filter card ───────────────────────────────────────────────────────────

function ForecastKpiCard({
  label,
  value,
  color,
  active,
  onClick,
}: {
  label: string;
  value: string | number;
  color: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => e.key === "Enter" && onClick()}
      style={{
        cursor: "pointer",
        border: `2px solid ${active ? color : "var(--p-color-border, #e1e3e5)"}`,
        borderRadius: "var(--p-border-radius-200, 8px)",
        padding: "16px",
        background: active ? `${color}12` : "var(--p-color-bg-surface, #fff)",
        transition: "border-color 0.15s, background 0.15s",
        userSelect: "none",
      }}
    >
      <s-stack direction="block" gap="small">
        <s-text color="subdued">{label}</s-text>
        <p
          style={{
            margin: 0,
            fontSize: "var(--p-font-size-750, 1.75rem)",
            fontWeight: "var(--p-font-weight-bold, 700)" as React.CSSProperties["fontWeight"],
            lineHeight: 1.2,
            color,
          }}
        >
          {value}
        </p>
      </s-stack>
    </div>
  );
}

// ── Shared input styles ───────────────────────────────────────────────────────

const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  padding: "6px 10px",
  fontSize: "var(--p-font-size-350, 0.875rem)",
  border: "1px solid var(--p-color-border, #e1e3e5)",
  borderRadius: "var(--p-border-radius-200, 8px)",
  background: "var(--p-color-bg-surface, #fff)",
  color: "var(--p-color-text, inherit)",
  boxSizing: "border-box",
};

const LABEL_STYLE: React.CSSProperties = {
  fontSize: "var(--p-font-size-300, 0.75rem)",
  color: "var(--p-color-text-subdued, #6d7175)",
  display: "block",
  marginBottom: "4px",
};

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ForecastPage() {
  const {
    rows, total, page, totalPages,
    config, salesCount,
    statusFilter,
    criticalCount, lowCount, deadCount, atRiskValue,
  } = useLoaderData<typeof loader>();

  const navigate      = useNavigate();
  const navigation    = useNavigation();
  const shopifyParams = useShopifyParams();
  const shopify       = useAppBridge();

  const startFetcher = useFetcher<{ ok: boolean; imported: number; needsReinstall?: boolean; error?: string | null }>();
  const revalidator  = useRevalidator();

  const isRunning = startFetcher.state !== "idle";
  const isLoading = navigation.state === "loading";

  useEffect(() => {
    if (startFetcher.state !== "idle") return;
    const d = startFetcher.data;
    if (!d) return;
    if (d.ok) {
      revalidator.revalidate();
      shopify.toast.show(`Se importaron ${d.imported} registros de ventas`);
    } else if (d.needsReinstall) {
      shopify.toast.show("Necesitas reinstalar la app para activar esta función", { isError: true });
    }
  }, [startFetcher.state, startFetcher.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasReplenishmentItems = criticalCount + lowCount > 0;

  function filterUrl(s: string): string {
    return statusFilter === s ? "?" : `?status=${s}`;
  }

  function pageUrl(newPage: number): string {
    const p = new URLSearchParams();
    if (statusFilter) p.set("status", statusFilter);
    if (newPage > 1) p.set("page", String(newPage));
    return `?${p.toString()}`;
  }

  function handleGeneratePO() {
    fetch(`/api/po/generate${shopifyParams}`, { method: "POST" })
      .then((res) => { if (!res.ok) throw new Error(`${res.status}`); return res.blob(); })
      .then((blob) => {
        const today = new Date().toISOString().slice(0, 10);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `purchase-order-${today}.pdf`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      })
      .catch((err) => console.error("[PO generate]", err));
  }

  const filterBannerLabel: Record<string, string> = {
    critical: "críticos",
    low:      "bajos (bajo reorden)",
    dead:     "sin rotación",
  };

  return (
    <s-page heading="Forecast & Reposición">

      {/* ── Fila 1: KPI cards ── */}
      <s-section>
        <s-grid gridTemplateColumns="repeat(4, 1fr)" gap="base">
          <ForecastKpiCard
            label="SKUs críticos"
            value={criticalCount}
            color={TONE_COLOR.critical}
            active={statusFilter === "critical"}
            onClick={() => navigate(filterUrl("critical"))}
          />
          <ForecastKpiCard
            label="SKUs bajos"
            value={lowCount}
            color={TONE_COLOR.low}
            active={statusFilter === "low"}
            onClick={() => navigate(filterUrl("low"))}
          />
          <ForecastKpiCard
            label="Sin rotación"
            value={deadCount}
            color={TONE_COLOR.dead}
            active={statusFilter === "dead"}
            onClick={() => navigate(filterUrl("dead"))}
          />
          <ForecastKpiCard
            label="Valor en riesgo"
            value={fmtUSD(atRiskValue)}
            color={hasReplenishmentItems ? TONE_COLOR.critical : TONE_COLOR.neutral}
            active={false}
            onClick={() => navigate(filterUrl("critical"))}
          />
        </s-grid>
      </s-section>

      {/* ── Fila 2: Tabla full width ── */}
      <s-section heading={`Forecast (${total} SKU${total !== 1 ? "s" : ""})`}>

        {/* Active filter banner */}
        {statusFilter && filterBannerLabel[statusFilter] && (
          <s-banner
            tone="info"
            heading={`Mostrando solo SKUs ${filterBannerLabel[statusFilter]}`}
          >
            <s-button variant="tertiary" onClick={() => navigate("?")}>
              Limpiar filtro ×
            </s-button>
          </s-banner>
        )}

        {total === 0 ? (
          <s-paragraph>
            {statusFilter ? "No hay SKUs con ese estado." : "No hay SKUs activos."}
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            <div
              style={{
                border: "1px solid var(--p-color-border, #e1e3e5)",
                borderRadius: "var(--p-border-radius-200, 8px)",
                overflow: "hidden",
                opacity: isLoading ? 0.6 : 1,
                transition: "opacity 0.15s",
              }}
            >
              {/* Header */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: GRID_COLS,
                  padding: "8px 0",
                  background: "var(--p-color-bg-surface-secondary, #f6f6f7)",
                  borderBottom: "1px solid var(--p-color-border, #e1e3e5)",
                }}
              >
                {(["SKU", "Producto", "Stock", "Velocidad", "Reorden", "Días restantes", "Estado"] as const).map(
                  (label, i) => (
                    <span
                      key={i}
                      style={{
                        padding: "0 8px",
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

              {/* Rows */}
              {rows.map((row, idx) => (
                <div
                  key={row.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: GRID_COLS,
                    padding: "10px 0",
                    alignItems: "center",
                    background:
                      idx % 2 === 0
                        ? "var(--p-color-bg-surface, #ffffff)"
                        : "var(--p-color-bg-surface-secondary, #f6f6f7)",
                    borderBottom:
                      idx < rows.length - 1
                        ? "1px solid var(--p-color-border-subdued, #e1e3e5)"
                        : "none",
                  }}
                >
                  <span style={{ padding: "0 8px", fontWeight: 600, fontSize: "var(--p-font-size-350, 0.875rem)" }}>
                    {row.sku_code}
                  </span>
                  <span style={{ padding: "0 8px", fontSize: "var(--p-font-size-350, 0.875rem)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {row.title ?? "—"}
                  </span>
                  <span style={{ padding: "0 8px" }}>
                    <s-badge tone={row.total_stock > 0 ? "success" : "critical"}>
                      {row.total_stock}
                    </s-badge>
                  </span>
                  <span style={{ padding: "0 8px", fontSize: "var(--p-font-size-350, 0.875rem)" }}>
                    {row.daily_velocity > 0 ? fmt(row.daily_velocity) : "—"}
                  </span>
                  <span style={{ padding: "0 8px", fontSize: "var(--p-font-size-350, 0.875rem)" }}>
                    {row.daily_velocity > 0 ? row.reorder_point : "—"}
                  </span>
                  <span style={{ padding: "0 8px", fontSize: "var(--p-font-size-350, 0.875rem)" }}>
                    {row.days_left !== null && row.days_left > 0 ? `${row.days_left}d` : "—"}
                  </span>
                  <span style={{ padding: "0 8px" }}>
                    <s-badge tone={statusTone(row.status)}>
                      {statusLabel(row.status)}
                    </s-badge>
                  </span>
                </div>
              ))}
            </div>

            {/* Pagination */}
            <s-stack direction="inline" justifyContent="space-between" alignItems="center">
              <s-text color="subdued">
                Página {page} de {totalPages} · {total} SKU{total !== 1 ? "s" : ""}
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

      {/* ── Fila 3: Config + Historial en dos columnas ── */}
      <s-section>
        <s-grid gridTemplateColumns="1fr 1fr" gap="base">

          {/* Card Configuración */}
          <s-box padding="large" borderWidth="small" borderRadius="base" background="base">
            <s-stack direction="block" gap="base">
              <s-text type="strong">Configuración de forecast</s-text>
              <Form method="post">
                <input type="hidden" name="intent" value="saveConfig" />
                <s-stack direction="block" gap="small">
                  <label style={{ display: "block" }}>
                    <span style={LABEL_STYLE}>Lead time (días)</span>
                    <input
                      type="number"
                      name="lead_days"
                      defaultValue={config.reorder_lead_days}
                      min={1}
                      max={365}
                      style={INPUT_STYLE}
                    />
                  </label>
                  <label style={{ display: "block" }}>
                    <span style={LABEL_STYLE}>Safety stock (días)</span>
                    <input
                      type="number"
                      name="safety_days"
                      defaultValue={config.safety_stock_days}
                      min={0}
                      max={90}
                      style={INPUT_STYLE}
                    />
                  </label>
                  <label style={{ display: "block" }}>
                    <span style={LABEL_STYLE}>Ventana forecast (días)</span>
                    <input
                      type="number"
                      name="window_days"
                      defaultValue={config.forecast_window_days}
                      min={7}
                      max={365}
                      style={INPUT_STYLE}
                    />
                  </label>
                  <s-button type="submit" variant="secondary">Guardar config</s-button>
                </s-stack>
              </Form>
            </s-stack>
          </s-box>

          {/* Card Historial de ventas + PO */}
          <s-box padding="large" borderWidth="small" borderRadius="base" background="base">
            <s-stack direction="block" gap="base">
              <s-text type="strong">Historial de ventas</s-text>

              {isRunning ? (
                <s-stack direction="block" gap="small">
                  <s-spinner />
                  <s-text>Importando órdenes…</s-text>
                </s-stack>
              ) : (
                <s-stack direction="block" gap="small">
                  {salesCount > 0 ? (
                    <s-badge tone="success">{salesCount.toLocaleString()} registros importados</s-badge>
                  ) : (
                    <s-text color="subdued">
                      Sin historial de ventas. Importa para calcular velocidad y reorder points.
                    </s-text>
                  )}
                  {salesCount === 0 && (
                    <s-text color="subdued">
                      Paso 1: sincroniza SKUs desde Bsale → Paso 2: importa el historial de ventas aquí.
                    </s-text>
                  )}
                  <s-button
                    variant={salesCount > 0 ? "secondary" : "primary"}
                    {...(startFetcher.state !== "idle" ? { loading: true } : {})}
                    onClick={() =>
                      startFetcher.submit(
                        {},
                        { method: "post", action: "/api/sync/sales-history" },
                      )
                    }
                  >
                    {startFetcher.state !== "idle"
                      ? "Importando…"
                      : salesCount > 0 ? "Re-importar historial" : "Importar historial de ventas (último año)"}
                  </s-button>
                  {startFetcher.data?.ok === false && (
                    <s-banner
                      tone="critical"
                      heading={startFetcher.data.needsReinstall
                        ? "Permiso faltante: reinstala la app"
                        : "La importación falló. Intenta de nuevo."}
                    >
                      {startFetcher.data.needsReinstall
                        ? "Ve a la App Store de Shopify, desinstala y vuelve a instalar SkuBeam para autorizar el permiso read_orders."
                        : (startFetcher.data.error ?? "")}
                    </s-banner>
                  )}
                </s-stack>
              )}

              {hasReplenishmentItems && (
                <>
                  <div style={{ height: "1px", background: "var(--p-color-border, #e1e3e5)" }} />
                  <s-stack direction="block" gap="small">
                    <s-text color="subdued">
                      {criticalCount + lowCount} SKU{criticalCount + lowCount !== 1 ? "s" : ""} necesitan reposición
                    </s-text>
                    <s-button variant="primary" onClick={handleGeneratePO}>
                      Generar Orden de Compra
                    </s-button>
                  </s-stack>
                </>
              )}
            </s-stack>
          </s-box>

        </s-grid>
      </s-section>

    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
