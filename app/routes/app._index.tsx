import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getShop } from "../models/shop.server";
import { getShopKpis, getAbcAnalysis } from "../models/analytics.server";
import { getForecastForShop } from "../models/forecast.server";
import { getLowestHealthScoreSkus } from "../models/sku.server";
import { useShopifyParams, useSkuBeamNavigate } from "../lib/navigate";
import type { DashboardAttentionSku } from "../models/sku.server";

// ── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  const [shop, kpis, abcRows, { rows: forecastRows }, attentionSkus] =
    await Promise.all([
      getShop(shopId).catch(() => null),
      getShopKpis(shopId),
      getAbcAnalysis(shopId),
      getForecastForShop(shopId),
      getLowestHealthScoreSkus(shopId, 10),
    ]);

  const criticalCount = forecastRows.filter((r) => r.status === "critical").length;

  const reorderMap = new Map(forecastRows.map((r) => [r.id, r.reorder_point]));

  const attentionWithReorder = attentionSkus.map((s) => ({
    ...s,
    reorder_point: reorderMap.get(s.id) ?? null,
  }));

  const abcCounts = {
    A: abcRows.filter((r) => r.abc_class === "A").length,
    B: abcRows.filter((r) => r.abc_class === "B").length,
    C: abcRows.filter((r) => r.abc_class === "C").length,
  };

  return { shopId, shop, kpis, abcCounts, criticalCount, attentionSkus: attentionWithReorder };
};

// ── Formatting helpers ────────────────────────────────────────────────────────

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "Nunca";
  return new Date(iso).toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" });
}

/** Returns "—" when there are no sales-cost data to avoid misleading $0 display */
function fmtCurrency(n: number): string {
  if (n <= 0) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtRatio(n: number): string {
  if (n <= 0) return "—";
  return n.toFixed(2);
}

function planLabel(plan: string | null | undefined): string {
  switch (plan) {
    case "starter": return "Starter";
    case "growth":  return "Growth";
    case "pro":     return "Pro";
    default:        return "Trial";
  }
}

// ── Health score ──────────────────────────────────────────────────────────────

/** Green >70 · Yellow 40–70 · Red <40 (as requested) */
function scoreColor(score: number): string {
  if (score > 70) return "#008060";
  if (score >= 40) return "#E3911C";
  return "#D82C0D";
}

// ── KPI card ─────────────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  badgeTone,
  badge,
}: {
  label: string;
  value: string;
  badgeTone?: "critical" | "caution" | "success" | "neutral" | "warning" | "info";
  badge?: string;
}) {
  return (
    <s-box padding="large" borderWidth="small" borderRadius="base" background="base">
      <s-stack direction="block" gap="small">
        {/* subdued label */}
        <s-text color="subdued">{label}</s-text>

        {/* Large metric number — no size variant on s-heading, use p + Polaris tokens */}
        <p
          style={{
            margin: 0,
            fontSize: "var(--p-font-size-750, 1.75rem)",
            fontWeight: "var(--p-font-weight-bold, 700)" as React.CSSProperties["fontWeight"],
            lineHeight: "var(--p-font-line-height-3, 1.2)",
            letterSpacing: "-0.01em",
            color: "var(--p-color-text, inherit)",
          }}
        >
          {value}
        </p>

        {/* badge — rendered only when provided */}
        {badge && badgeTone && (
          <s-badge tone={badgeTone}>{badge}</s-badge>
        )}
      </s-stack>
    </s-box>
  );
}

// ── Health progress bar ───────────────────────────────────────────────────────

function HealthBar({ score }: { score: number }) {
  const color = scoreColor(score);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
      <div
        style={{
          width: "64px",
          height: "6px",
          background: "var(--p-color-bg-surface-secondary, #E4E5E7)",
          borderRadius: "3px",
          overflow: "hidden",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            width: `${score}%`,
            height: "100%",
            background: color,
            borderRadius: "3px",
          }}
        />
      </div>
      <span
        style={{
          fontSize: "var(--p-font-size-300, 0.75rem)",
          fontWeight: 600,
          color,
          minWidth: "24px",
          tabularNums: "tabular-nums",
        } as React.CSSProperties}
      >
        {score}
      </span>
    </div>
  );
}

// ── Attention table ───────────────────────────────────────────────────────────

function AttentionTable({
  rows,
  shopifyParams,
}: {
  rows: (DashboardAttentionSku & { reorder_point: number | null })[];
  shopifyParams: string;
}) {
  if (rows.length === 0) {
    return (
      <s-stack direction="block" gap="small">
        <s-badge tone="success">Todo en orden</s-badge>
        <s-text color="subdued">
          No hay SKUs activos con datos incompletos o stock bajo.
        </s-text>
      </s-stack>
    );
  }

  return (
    <s-table>
      <s-table-header>
        <s-table-header-row>
          <s-table-cell>Producto</s-table-cell>
          <s-table-cell>Stock</s-table-cell>
          <s-table-cell>Reorder</s-table-cell>
          <s-table-cell>Health</s-table-cell>
          <s-table-cell>{/* Acción */}</s-table-cell>
        </s-table-header-row>
      </s-table-header>
      <s-table-body>
        {rows.map((row) => {
          const stockTone =
            row.total_stock === 0
              ? "critical"
              : row.total_stock <= (row.reorder_point ?? 0)
              ? "caution"
              : "neutral";

          return (
            <s-table-row key={row.id}>
              <s-table-cell>
                <s-stack direction="block" gap="none">
                  <s-text type="strong">{row.sku_code}</s-text>
                  {row.title && <s-text color="subdued">{row.title}</s-text>}
                </s-stack>
              </s-table-cell>
              <s-table-cell>
                <s-badge tone={stockTone}>{row.total_stock}</s-badge>
              </s-table-cell>
              <s-table-cell>
                {row.reorder_point != null ? row.reorder_point : "—"}
              </s-table-cell>
              <s-table-cell>
                <HealthBar score={row.health_score} />
              </s-table-cell>
              <s-table-cell>
                <s-link href={`/app/skus/${row.id}${shopifyParams}`}>Ver</s-link>
              </s-table-cell>
            </s-table-row>
          );
        })}
      </s-table-body>
    </s-table>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { shopId, shop, kpis, abcCounts, criticalCount, attentionSkus } =
    useLoaderData<typeof loader>();

  const navigate       = useSkuBeamNavigate();
  const shopifyParams  = useShopifyParams();
  const bsaleConnected = Boolean(shop?.bsale_token);

  // Short badge labels — avoid truncation inside narrow cards
  const criticalBadge  = criticalCount > 0 ? `${criticalCount} crítico${criticalCount > 1 ? "s" : ""}` : "OK";
  const costBadge      = kpis.skus_with_cost > 0 ? `${kpis.skus_with_cost} c/costo` : "Sin datos";
  const rotBadge       = kpis.turnover_ratio > 0 ? "últ. 30d" : "—";

  return (
    <s-page heading="Dashboard">

      {/* ── Fila 1: KPI strip — auto-fit grid, naturally responsive ── */}
      <s-section>
        <s-grid
          gridTemplateColumns="repeat(auto-fit, minmax(155px, 1fr))"
          gap="base"
        >
          <KpiCard
            label="SKUs activos"
            value={kpis.active_skus.toLocaleString("es-CL")}
          />
          <KpiCard
            label="SKUs críticos"
            value={criticalCount.toLocaleString("es-CL")}
            badgeTone={criticalCount > 0 ? "critical" : "success"}
            badge={criticalBadge}
          />
          <KpiCard
            label="Valor inventario"
            value={fmtCurrency(kpis.estimated_stock_value)}
            badgeTone={kpis.skus_with_cost > 0 ? "neutral" : "neutral"}
            badge={costBadge}
          />
          <KpiCard
            label="Unidades vend. 30d"
            value={kpis.units_sold_30d.toLocaleString("es-CL")}
          />
          <KpiCard
            label="Rotación"
            value={fmtRatio(kpis.turnover_ratio)}
            badgeTone={kpis.turnover_ratio > 0 ? "info" : "neutral"}
            badge={rotBadge}
          />
        </s-grid>
      </s-section>

      {/* ── Fila 2 left: SKUs que necesitan atención ── */}
      <s-section heading="SKUs que necesitan atención">
        <AttentionTable rows={attentionSkus} shopifyParams={shopifyParams} />
        {attentionSkus.length > 0 && (
          <s-button variant="tertiary" onClick={() => navigate("/app/skus")}>
            Ver todos los SKUs →
          </s-button>
        )}
      </s-section>

      {/* ── Fila 3: conditional banners ── */}
      {criticalCount > 0 && (
        <s-banner
          tone="critical"
          heading={`${criticalCount} SKU${criticalCount !== 1 ? "s" : ""} con stock crítico o agotado`}
        >
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Genera una orden de compra con los SKUs que necesitan reposición urgente.
            </s-paragraph>
            <s-button
              variant="primary"
              onClick={() => {
                const today = new Date().toISOString().slice(0, 10);
                fetch(`/api/po/generate${shopifyParams}`, { method: "POST" })
                  .then((res) => {
                    if (!res.ok) throw new Error(`${res.status}`);
                    return res.blob();
                  })
                  .then((blob) => {
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
              }}
            >
              Generar Orden de Compra
            </s-button>
          </s-stack>
        </s-banner>
      )}

      {!bsaleConnected && (
        <s-banner
          tone="warning"
          heading="Conecta tu Bsale para activar el sync bidireccional"
        >
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Sin la integración Bsale, los descuentos de stock entre tu POS y
              Shopify no se sincronizan automáticamente.
            </s-paragraph>
            <s-button variant="secondary" onClick={() => navigate("/app/integrations")}>
              Ir a Integraciones
            </s-button>
          </s-stack>
        </s-banner>
      )}

      {/* ── Fila 2 right: Estado Bsale (aside) ── */}
      <s-section slot="aside" heading="Estado Bsale">
        <s-stack direction="block" gap="base">
          {bsaleConnected ? (
            <>
              <s-badge tone="success">Conectado ✓</s-badge>
              <s-stack direction="block" gap="small">
                <s-text color="subdued">Último sync</s-text>
                <s-text>{fmtDate(shop?.bsale_last_sync)}</s-text>
              </s-stack>
              <s-text color="subdued">{shopId}</s-text>
              <s-button variant="secondary" onClick={() => navigate("/app/integrations")}>
                Sync ahora
              </s-button>
            </>
          ) : (
            <>
              <s-badge tone="warning">Sin conectar</s-badge>
              <s-text color="subdued">
                Plan: {planLabel(shop?.plan)} · {kpis.active_skus} /{" "}
                {shop?.sku_limit === -1 ? "∞" : (shop?.sku_limit ?? 500)} SKUs
              </s-text>
              <s-button variant="primary" onClick={() => navigate("/app/integrations")}>
                Conectar Bsale
              </s-button>
            </>
          )}
        </s-stack>
      </s-section>

      {/* ── Fila 2 right: Resumen ABC (aside) ── */}
      <s-section slot="aside" heading="Resumen ABC">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small">
            <s-badge tone="success">{abcCounts.A} tipo A</s-badge>
            <s-badge tone="caution">{abcCounts.B} tipo B</s-badge>
            <s-badge tone="neutral">{abcCounts.C} tipo C</s-badge>
          </s-stack>
          <s-text color="subdued">A = 80% ventas · B = 15% · C = 5%</s-text>
          <s-button variant="tertiary" onClick={() => navigate("/app/analytics")}>
            Ver análisis completo →
          </s-button>
        </s-stack>
      </s-section>

    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
