import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate } from "react-router";
import { useShopifyParams } from "../lib/navigate";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  getShopKpis,
  getAbcAnalysis,
  getTopSkusByVelocity,
  getSalesByChannel,
} from "../models/analytics.server";
import type { VelocityRow } from "../models/analytics.server";
import { supabaseAdmin } from "../db.server";

const ABC_PAGE_SIZE = 50;
const ABC_GRID = "50px 140px 1fr 110px 90px 140px";
const VEL_GRID = "40px 140px 1fr 200px 90px 80px";

// ── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  const url = new URL(request.url);
  const abcPage = Math.max(1, Number(url.searchParams.get("abcPage") ?? "1"));

  const [kpis, allAbcRows, velocityRows, channelData, shopRow] = await Promise.all([
    getShopKpis(shopId),
    getAbcAnalysis(shopId),
    getTopSkusByVelocity(shopId, 20),
    getSalesByChannel(shopId, 30),
    supabaseAdmin.from("shops").select("bsale_token").eq("shop_id", shopId).maybeSingle(),
  ]);

  const hasBsale = !!(shopRow.data?.bsale_token);

  const abcCounts = {
    A: allAbcRows.filter((r) => r.abc_class === "A").length,
    B: allAbcRows.filter((r) => r.abc_class === "B").length,
    C: allAbcRows.filter((r) => r.abc_class === "C").length,
  };

  const abcTotal      = allAbcRows.length;
  const abcTotalPages = Math.ceil(abcTotal / ABC_PAGE_SIZE);
  const abcRows       = allAbcRows.slice((abcPage - 1) * ABC_PAGE_SIZE, abcPage * ABC_PAGE_SIZE);

  return { kpis, abcRows, abcTotal, abcPage, abcTotalPages, abcCounts, velocityRows, channelData, hasBsale };
};

// ── Helpers ──────────────────────────────────────────────────────────────────

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
  return n.toFixed(1) + "%";
}

const ABC_COLOR = { A: "#008060", B: "#E3911C", C: "#6D7175" } as const;
const ABC_TONE  = { A: "success", B: "caution", C: "neutral" } as const;

// ── KPI card ─────────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <s-box padding="large" borderWidth="small" borderRadius="base" background="base">
      <s-stack direction="block" gap="small">
        <s-text color="subdued">{label}</s-text>
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
        {sub && <s-text color="subdued">{sub}</s-text>}
      </s-stack>
    </s-box>
  );
}

// ── ABC count card ────────────────────────────────────────────────────────────

function AbcCountCard({ cls, count }: { cls: "A" | "B" | "C"; count: number }) {
  return (
    <s-box padding="large" borderWidth="small" borderRadius="base" background="base">
      <s-stack direction="block" gap="small">
        <s-badge tone={ABC_TONE[cls]}>Clase {cls}</s-badge>
        <p
          style={{
            margin: 0,
            fontSize: "var(--p-font-size-750, 1.75rem)",
            fontWeight: "var(--p-font-weight-bold, 700)" as React.CSSProperties["fontWeight"],
            lineHeight: 1.2,
            color: ABC_COLOR[cls],
          }}
        >
          {count}
        </p>
        <s-text color="subdued">
          {cls === "A" ? "80% del volumen" : cls === "B" ? "siguiente 15%" : "restante 5%"}
        </s-text>
      </s-stack>
    </s-box>
  );
}

// ── Shared table styles ───────────────────────────────────────────────────────

const HEADER_CELL: React.CSSProperties = {
  padding: "0 8px",
  fontSize: "var(--p-font-size-300, 0.75rem)",
  fontWeight: 600,
  color: "var(--p-color-text-subdued, #6d7175)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

function GridTable({
  cols,
  headers,
  isLoading,
  children,
}: {
  cols: string;
  headers: string[];
  isLoading?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--p-color-border, #e1e3e5)",
        borderRadius: "var(--p-border-radius-200, 8px)",
        overflow: "hidden",
        opacity: isLoading ? 0.6 : 1,
        transition: "opacity 0.15s",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: cols,
          padding: "8px 0",
          background: "var(--p-color-bg-surface-secondary, #f6f6f7)",
          borderBottom: "1px solid var(--p-color-border, #e1e3e5)",
        }}
      >
        {headers.map((h, i) => (
          <span key={i} style={HEADER_CELL}>{h}</span>
        ))}
      </div>
      {children}
    </div>
  );
}

function GridRow({
  cols,
  idx,
  total,
  children,
}: {
  cols: string;
  idx: number;
  total: number;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: cols,
        padding: "10px 0",
        alignItems: "center",
        background:
          idx % 2 === 0
            ? "var(--p-color-bg-surface, #ffffff)"
            : "var(--p-color-bg-surface-secondary, #f6f6f7)",
        borderBottom:
          idx < total - 1 ? "1px solid var(--p-color-border-subdued, #e1e3e5)" : "none",
      }}
    >
      {children}
    </div>
  );
}

const CELL: React.CSSProperties = { padding: "0 8px", fontSize: "var(--p-font-size-350, 0.875rem)" };
const CELL_NOWRAP: React.CSSProperties = { ...CELL, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

// ── Velocity row ──────────────────────────────────────────────────────────────

function VelocityRow_({
  row,
  maxVelocity,
  rank,
  idx,
  total,
}: {
  row: VelocityRow;
  maxVelocity: number;
  rank: number;
  idx: number;
  total: number;
}) {
  const barPct = maxVelocity > 0 ? (row.daily_velocity / maxVelocity) * 100 : 0;

  return (
    <GridRow cols={VEL_GRID} idx={idx} total={total}>
      <span style={{ ...CELL, color: "var(--p-color-text-subdued, #6d7175)" }}>{rank}</span>
      <span style={{ ...CELL, fontWeight: 600 }}>{row.sku_code}</span>
      <span style={CELL_NOWRAP}>{row.title ?? "—"}</span>
      <span style={CELL}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <div
            style={{
              width: `${Math.max(barPct, 2)}%`,
              maxWidth: "120px",
              minWidth: "4px",
              height: "8px",
              background: "var(--p-color-bg-fill-emphasis, #008060)",
              borderRadius: "3px",
              flexShrink: 0,
            }}
          />
          <span style={{ whiteSpace: "nowrap", fontSize: "var(--p-font-size-350, 0.875rem)" }}>
            {row.daily_velocity.toFixed(2)} u/día
          </span>
        </div>
      </span>
      <span style={CELL}>{row.sold_30d}</span>
      <span style={CELL}>
        <s-badge tone={row.total_stock > 0 ? "success" : "critical"}>{row.total_stock}</s-badge>
      </span>
    </GridRow>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AnalyticsPage() {
  const { kpis, abcRows, abcTotal, abcPage, abcTotalPages, abcCounts, velocityRows, channelData, hasBsale } =
    useLoaderData<typeof loader>();

  const navigate      = useNavigate();
  const shopifyParams = useShopifyParams();

  const maxVelocity = velocityRows.length > 0 ? velocityRows[0].daily_velocity : 1;

  function abcPageUrl(p: number): string {
    return p > 1 ? `?abcPage=${p}` : "?";
  }

  return (
    <s-page heading="Analytics">

      {/* Bsale channel breakdown */}
      {hasBsale && channelData.bsale_pos > 0 && (
        <s-banner tone="info">
          El forecast incluye ventas de tienda física via Bsale.
          Online: {fmtNum(channelData.shopify)} uds · Tienda: {fmtNum(channelData.bsale_pos)} uds (últimos 30 días)
        </s-banner>
      )}

      {/* Zero-state: SKUs exist but no stock synced yet */}
      {kpis.active_skus > 0 && kpis.total_stock === 0 && (
        <s-banner
          tone="info"
          heading="Sin datos de stock aún"
        >
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Sincroniza el stock desde Bsale para ver métricas completas de inventario.
            </s-paragraph>
            <s-button
              variant="secondary"
              onClick={() => navigate(`/app/integrations/bsale${shopifyParams}`)}
            >
              Sincronizar stock desde Bsale
            </s-button>
          </s-stack>
        </s-banner>
      )}

      {/* ── Fila 1: KPI strip ── */}
      <s-section heading="KPIs — Últimos 30 días">
        <s-grid gridTemplateColumns="repeat(3, 1fr)" gap="base">
          <KpiCard label="SKUs activos"               value={fmtNum(kpis.active_skus)} />
          <KpiCard label="Unidades vendidas (30d)"    value={fmtNum(kpis.units_sold_30d)} />
          <KpiCard label="Stock total"                value={fmtNum(kpis.total_stock)} />
          <KpiCard
            label="Rotación (30d)"
            value={kpis.turnover_ratio.toFixed(2) + "x"}
            sub="Unidades vendidas / stock"
          />
          <KpiCard label="Costo ventas est. (30d)"    value={"$" + fmtMoney(kpis.estimated_cogs_30d)} />
          <KpiCard label="Valor inventario est."      value={"$" + fmtMoney(kpis.estimated_stock_value)} />
        </s-grid>
      </s-section>

      {/* ── Fila 2: ABC summary cards ── */}
      <s-section>
        <s-grid gridTemplateColumns="repeat(3, 1fr)" gap="base">
          <AbcCountCard cls="A" count={abcCounts.A} />
          <AbcCountCard cls="B" count={abcCounts.B} />
          <AbcCountCard cls="C" count={abcCounts.C} />
        </s-grid>
      </s-section>

      {/* ── Fila 3: ABC table ── */}
      <s-section heading={`Análisis ABC (${abcTotal} SKUs activos)`}>
        {abcTotal === 0 ? (
          <s-paragraph>No hay SKUs activos. Importa productos para ver el análisis.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            <GridTable
              cols={ABC_GRID}
              headers={["Tipo", "SKU", "Producto", "Unidades 30d", "% Volumen", "% Acumulado"]}
            >
              {abcRows.map((row, idx) => (
                <GridRow key={row.id} cols={ABC_GRID} idx={idx} total={abcRows.length}>
                  <span style={{ padding: "0 8px" }}>
                    <s-badge tone={ABC_TONE[row.abc_class]}>{row.abc_class}</s-badge>
                  </span>
                  <span style={{ ...CELL, fontWeight: 600 }}>{row.sku_code}</span>
                  <span style={CELL_NOWRAP}>{row.title ?? "—"}</span>
                  <span style={CELL}>{row.sold_30d}</span>
                  <span style={CELL}>{fmtPct(row.pct_of_total)}</span>
                  <span style={CELL}>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      <div
                        style={{
                          width: `${Math.min(row.cumulative_pct, 100)}%`,
                          maxWidth: "60px",
                          minWidth: "2px",
                          height: "6px",
                          background: ABC_COLOR[row.abc_class],
                          borderRadius: "3px",
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ whiteSpace: "nowrap", fontSize: "var(--p-font-size-350, 0.875rem)" }}>
                        {fmtPct(row.cumulative_pct)}
                      </span>
                    </div>
                  </span>
                </GridRow>
              ))}
            </GridTable>

            {/* ABC pagination */}
            <s-stack direction="inline" justifyContent="space-between" alignItems="center">
              <s-text color="subdued">
                Página {abcPage} de {abcTotalPages} · {abcTotal} SKU{abcTotal !== 1 ? "s" : ""}
              </s-text>
              {abcTotalPages > 1 && (
                <s-stack direction="inline" gap="small">
                  <s-button
                    variant="tertiary"
                    {...(abcPage <= 1 ? { disabled: true } : {})}
                    onClick={() => navigate(abcPageUrl(abcPage - 1))}
                  >
                    ← Anterior
                  </s-button>
                  <s-button
                    variant="tertiary"
                    {...(abcPage >= abcTotalPages ? { disabled: true } : {})}
                    onClick={() => navigate(abcPageUrl(abcPage + 1))}
                  >
                    Siguiente →
                  </s-button>
                </s-stack>
              )}
            </s-stack>
          </s-stack>
        )}
      </s-section>

      {/* ── Velocity table ── */}
      <s-section heading={`Top ${velocityRows.length} SKUs por Velocidad de Ventas`}>
        {velocityRows.length === 0 ? (
          <s-paragraph>
            Sin datos de ventas. Importa el historial de órdenes desde la sección Forecast.
          </s-paragraph>
        ) : (
          <GridTable
            cols={VEL_GRID}
            headers={["#", "SKU", "Producto", "Velocidad (u/día)", "Vendido 30d", "Stock"]}
          >
            {velocityRows.map((row, i) => (
              <VelocityRow_
                key={row.id}
                row={row}
                maxVelocity={maxVelocity}
                rank={i + 1}
                idx={i}
                total={velocityRows.length}
              />
            ))}
          </GridTable>
        )}
      </s-section>

    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
