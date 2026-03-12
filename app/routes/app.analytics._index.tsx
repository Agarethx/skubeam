import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { useShopifyParams } from "../lib/navigate";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  getShopKpis,
  getAbcAnalysis,
  getTopSkusByVelocity,
} from "../models/analytics.server";
import type { AbcRow, VelocityRow } from "../models/analytics.server";

// ── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  const [kpis, abcRows, velocityRows] = await Promise.all([
    getShopKpis(shopId),
    getAbcAnalysis(shopId),
    getTopSkusByVelocity(shopId, 20),
  ]);

  return { kpis, abcRows, velocityRows };
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function abcTone(cls: AbcRow["abc_class"]) {
  return cls === "A" ? "success" : cls === "B" ? "caution" : "neutral";
}

function fmtNum(n: number) {
  return new Intl.NumberFormat("es-MX").format(Math.round(n));
}

function fmtMoney(n: number) {
  return new Intl.NumberFormat("es-MX", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n);
}

function fmtPct(n: number) {
  return n.toFixed(1) + " %";
}

// ── KPI card ─────────────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <s-box
      padding="base"
      borderWidth="base"
      borderRadius="base"
      background="subdued"
    >
      <s-stack direction="block" gap="small">
        <s-text>{label}</s-text>
        <s-heading>{value}</s-heading>
        {sub && <s-text>{sub}</s-text>}
      </s-stack>
    </s-box>
  );
}

// ── Velocity bar ─────────────────────────────────────────────────────────────

function VelocityBar({
  row,
  maxVelocity,
  rank,
}: {
  row: VelocityRow;
  maxVelocity: number;
  rank: number;
}) {
  const barPct = maxVelocity > 0 ? (row.daily_velocity / maxVelocity) * 100 : 0;

  return (
    <s-table-row key={row.id}>
      <s-table-cell>
        <s-text>{rank}</s-text>
      </s-table-cell>
      <s-table-cell>
        <s-text>{row.sku_code}</s-text>
      </s-table-cell>
      <s-table-cell>
        <s-text>{row.title ?? "—"}</s-text>
      </s-table-cell>
      <s-table-cell>
        <div
          style={{
            display:    "flex",
            alignItems: "center",
            gap:        "8px",
          }}
        >
          <div
            style={{
              width:        `${Math.max(barPct, 2)}%`,
              maxWidth:     "140px",
              minWidth:     "4px",
              height:       "10px",
              background:   "var(--p-color-bg-fill-emphasis, #008060)",
              borderRadius: "3px",
              flexShrink:   0,
            }}
          />
          <span style={{ whiteSpace: "nowrap" }}>
            {row.daily_velocity.toFixed(2)} u/día
          </span>
        </div>
      </s-table-cell>
      <s-table-cell>{row.sold_30d}</s-table-cell>
      <s-table-cell>
        <s-badge tone={row.total_stock > 0 ? "success" : "critical"}>
          {row.total_stock}
        </s-badge>
      </s-table-cell>
    </s-table-row>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AnalyticsPage() {
  const { kpis, abcRows, velocityRows } = useLoaderData<typeof loader>();
  const shopifyParams = useShopifyParams();

  const maxVelocity =
    velocityRows.length > 0 ? velocityRows[0].daily_velocity : 1;

  const abcCounts = {
    A: abcRows.filter((r) => r.abc_class === "A").length,
    B: abcRows.filter((r) => r.abc_class === "B").length,
    C: abcRows.filter((r) => r.abc_class === "C").length,
  };

  const costCoveragePct =
    kpis.active_skus > 0
      ? Math.round((kpis.skus_with_cost / kpis.active_skus) * 100)
      : 100;
  const showCostWarning = costCoveragePct < 100;

  return (
    <s-page heading="Analytics">
      {/* ── Aside: distribution summary ── */}
      <s-section slot="aside" heading="Distribución ABC">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small">
            <s-badge tone="success">A: {abcCounts.A} SKUs</s-badge>
            <s-badge tone="caution">B: {abcCounts.B} SKUs</s-badge>
            <s-badge tone="neutral">C: {abcCounts.C} SKUs</s-badge>
          </s-stack>
          <s-text>
            Clasificación por unidades vendidas en 30d. A = top 80% del
            volumen, B = siguiente 15%, C = restante 5%.
          </s-text>
        </s-stack>
      </s-section>

      {/* ── Main: cost coverage warning ── */}
      {showCostWarning && (
        <s-banner
          tone="warning"
          heading={`Solo el ${costCoveragePct}% de tus SKUs tiene costo registrado — las métricas financieras son estimaciones parciales.`}
        >
          <s-link href={`/app/skus${shopifyParams}`}>
            Agrega el costo a tus SKUs para ver métricas financieras reales
          </s-link>
        </s-banner>
      )}

      {/* ── Main: KPI cards ── */}
      <s-section heading="KPIs — Últimos 30 días">
        <div
          style={{
            display:             "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
            gap:                 "12px",
          }}
        >
          <KpiCard
            label="SKUs activos"
            value={fmtNum(kpis.active_skus)}
          />
          <KpiCard
            label="Unidades vendidas (30d)"
            value={fmtNum(kpis.units_sold_30d)}
          />
          <KpiCard
            label="Stock total"
            value={fmtNum(kpis.total_stock)}
          />
          <KpiCard
            label="Rotación (30d)"
            value={kpis.turnover_ratio.toFixed(2) + "x"}
            sub="Unidades vendidas / stock total"
          />
          <KpiCard
            label="Costo de ventas est. (30d)"
            value={"$" + fmtMoney(kpis.estimated_cogs_30d)}
          />
          <KpiCard
            label="Valor de inventario est."
            value={"$" + fmtMoney(kpis.estimated_stock_value)}
          />
        </div>
      </s-section>

      {/* ── Main: ABC analysis ── */}
      <s-section heading={`Análisis ABC (${abcRows.length} SKUs activos)`}>
        {abcRows.length === 0 ? (
          <s-paragraph>
            No hay SKUs activos. Importa productos para ver el análisis.
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header>
              <s-table-header-row>
                <s-table-cell>Clase</s-table-cell>
                <s-table-cell>SKU</s-table-cell>
                <s-table-cell>Título</s-table-cell>
                <s-table-cell>Vendido (30d)</s-table-cell>
                <s-table-cell>% del total</s-table-cell>
                <s-table-cell>% acumulado</s-table-cell>
              </s-table-header-row>
            </s-table-header>
            <s-table-body>
              {abcRows.map((row) => (
                <s-table-row key={row.id}>
                  <s-table-cell>
                    <s-badge tone={abcTone(row.abc_class)}>
                      {row.abc_class}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    <s-text>{row.sku_code}</s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <s-text>{row.title ?? "—"}</s-text>
                  </s-table-cell>
                  <s-table-cell>{row.sold_30d}</s-table-cell>
                  <s-table-cell>{fmtPct(row.pct_of_total)}</s-table-cell>
                  <s-table-cell>
                    <div
                      style={{
                        display:    "flex",
                        alignItems: "center",
                        gap:        "6px",
                      }}
                    >
                      <div
                        style={{
                          width:        `${Math.min(row.cumulative_pct, 100)}%`,
                          maxWidth:     "80px",
                          minWidth:     "2px",
                          height:       "8px",
                          background:
                            row.abc_class === "A"
                              ? "var(--p-color-bg-fill-success, #008060)"
                              : row.abc_class === "B"
                                ? "var(--p-color-bg-fill-caution, #ffc453)"
                                : "var(--p-color-border, #aaa)",
                          borderRadius: "3px",
                        }}
                      />
                      <span>{fmtPct(row.cumulative_pct)}</span>
                    </div>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      {/* ── Main: velocity chart ── */}
      <s-section
        heading={`Top ${velocityRows.length} SKUs por Velocidad de Ventas`}
      >
        {velocityRows.length === 0 ? (
          <s-paragraph>
            Sin datos de ventas. Importa el historial de órdenes desde la
            sección Forecast.
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header>
              <s-table-header-row>
                <s-table-cell>#</s-table-cell>
                <s-table-cell>SKU</s-table-cell>
                <s-table-cell>Título</s-table-cell>
                <s-table-cell>Velocidad (u/día)</s-table-cell>
                <s-table-cell>Vendido (30d)</s-table-cell>
                <s-table-cell>Stock</s-table-cell>
              </s-table-header-row>
            </s-table-header>
            <s-table-body>
              {velocityRows.map((row, i) => (
                <VelocityBar
                  key={row.id}
                  row={row}
                  maxVelocity={maxVelocity}
                  rank={i + 1}
                />
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
