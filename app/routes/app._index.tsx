import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { useState } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useTranslation } from 'react-i18next';
import { authenticate } from "../shopify.server";
import { getShop } from "../models/shop.server";
import { getShopKpis, getAbcAnalysis } from "../models/analytics.server";
import { getForecastForShop } from "../models/forecast.server";
import { getLowestHealthScoreSkus } from "../models/sku.server";
import { supabaseAdmin } from "../db.server";
import { useShopifyParams, useSkuBeamNavigate } from "../lib/navigate";
import type { DashboardAttentionSku } from "../models/sku.server";

// ── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  const [shop, kpis, abcRows, { rows: forecastRows }, attentionSkus, skuCountResult, activeSkuResult, wooConn] =
    await Promise.all([
      getShop(shopId).catch(() => null),
      getShopKpis(shopId),
      getAbcAnalysis(shopId),
      getForecastForShop(shopId),
      getLowestHealthScoreSkus(shopId, 10),
      supabaseAdmin.from("skus").select("id", { count: "exact", head: true }).eq("shop_id", shopId),
      // Direct count of SKUs published to Shopify (shopify_variant_id IS NOT NULL)
      supabaseAdmin.from("skus").select("*", { count: "exact", head: true }).eq("shop_id", shopId).not("shopify_variant_id", "is", null),
      supabaseAdmin.from("woo_connections").select("id").eq("shop_id", shopId).limit(1).maybeSingle(),
    ]);

  const skuCount       = skuCountResult.count ?? 0;
  const activeSkuCount = activeSkuResult.count ?? 0;
  console.log("[dashboard] totalSkuCount (all skus):", skuCount);
  console.log("[dashboard] activeSkuCount (shopify_variant_id IS NOT NULL):", activeSkuCount);
  const hasBsale       = Boolean(shop?.bsale_token);
  const hasWooConn     = Boolean(wooConn.data);
  const showOnboarding = !(shop as { onboarding_done?: boolean } | null)?.onboarding_done && skuCount === 0;

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

  return {
    shopId, shop, kpis, abcCounts, criticalCount, attentionSkus: attentionWithReorder,
    showOnboarding, hasBsale, hasWooConn, skuCount, activeSkuCount,
  };
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
  const { t } = useTranslation();

  if (rows.length === 0) {
    return (
      <s-stack direction="block" gap="small">
        <s-badge tone="success">{t('dashboard.allGood')}</s-badge>
        <s-text color="subdued">
          {t('dashboard.noCriticalSkus')}
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

// ── OnboardingFlow ────────────────────────────────────────────────────────────

const CARD_BTN: React.CSSProperties = {
  width:        "100%",
  padding:      "20px",
  borderRadius: "var(--p-border-radius-200, 8px)",
  border:       "2px solid var(--p-color-border, #e1e3e5)",
  background:   "var(--p-color-bg-surface, #fff)",
  cursor:       "pointer",
  textAlign:    "left",
  transition:   "border-color 0.15s, box-shadow 0.15s",
};

function OnboardingFlow({
  navigate,
}: {
  navigate: (path: string) => void;
}) {
  const [screen, setScreen]     = useState<0 | 1 | 2>(0);
  const [visible, setVisible]   = useState(true);
  const completeFetcher         = useFetcher<{ ok?: boolean }>();
  const { t } = useTranslation();

  function closeAndComplete() {
    completeFetcher.submit({}, { method: "post", action: "/api/complete-onboarding" });
    setVisible(false);
  }

  if (!visible) return null;

  const OVERLAY: React.CSSProperties = {
    position:       "fixed",
    inset:          0,
    zIndex:         100,
    background:     "rgba(0,0,0,0.5)",
    display:        "flex",
    alignItems:     "center",
    justifyContent: "center",
    padding:        "24px",
  };

  const MODAL: React.CSSProperties = {
    background:    "var(--p-color-bg-surface, #fff)",
    borderRadius:  "var(--p-border-radius-300, 12px)",
    width:         "100%",
    maxWidth:      "560px",
    padding:       "32px",
    boxShadow:     "0 8px 40px rgba(0,0,0,0.22)",
    position:      "relative",
    display:       "flex",
    flexDirection: "column",
    gap:           "24px",
  };

  const CLOSE_BTN: React.CSSProperties = {
    position:   "absolute",
    top:        "16px",
    right:      "16px",
    background: "none",
    border:     "none",
    cursor:     "pointer",
    fontSize:   "20px",
    color:      "var(--p-color-text-subdued, #6d7175)",
    lineHeight: 1,
    padding:    "4px",
  };

  return (
    <div style={OVERLAY}>
      <div style={MODAL}>

        {/* X button — closes without marking done */}
        <button style={CLOSE_BTN} onClick={() => setVisible(false)} aria-label="Cerrar">✕</button>

        {/* ── Screen 0: Welcome ── */}
        {screen === 0 && (
          <>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "56px", lineHeight: 1, marginBottom: "16px" }}>📦</div>
              <s-stack direction="block" gap="small">
                <s-heading>{t('onboarding.welcome')}</s-heading>
                <s-text color="subdued">
                  {t('onboarding.description')}
                </s-text>
              </s-stack>
            </div>

            <s-stack direction="block" gap="small">
              {[
                "Sincronización bidireccional con Bsale",
                "Migración desde WooCommerce",
                "Alertas de stock crítico y forecasting",
              ].map((bullet) => (
                <div key={bullet} style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <span style={{ color: "var(--p-color-text-success, #008060)", fontWeight: 700, flexShrink: 0 }}>✓</span>
                  <s-text>{bullet}</s-text>
                </div>
              ))}
            </s-stack>

            <s-button variant="primary" onClick={() => setScreen(1)}>
              {t('onboarding.start')}
            </s-button>
          </>
        )}

        {/* ── Screen 1: WooCommerce ── */}
        {screen === 1 && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <s-text color="subdued">{t('onboarding.step', { current: 1, total: 2 })}</s-text>
              <div style={{ display: "flex", gap: "6px" }}>
                <div style={{ width: "32px", height: "4px", borderRadius: "2px", background: "var(--p-color-text-success, #008060)" }} />
                <div style={{ width: "32px", height: "4px", borderRadius: "2px", background: "var(--p-color-bg-surface-secondary, #e4e5e7)" }} />
              </div>
            </div>

            <s-stack direction="block" gap="small">
              <s-heading>{t('onboarding.wooQuestion')}</s-heading>
              <s-text color="subdued">
                Podemos importar todos tus productos, variantes, imágenes y órdenes automáticamente.
              </s-text>
            </s-stack>

            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <button
                style={CARD_BTN}
                onClick={() => { navigate("/app/integrations/woocommerce"); setVisible(false); }}
              >
                <s-stack direction="block" gap="small-200">
                  <s-text type="strong">🛒 {t('onboarding.wooYes')}</s-text>
                  <s-text color="subdued">Importa productos, variantes, imágenes y órdenes en minutos</s-text>
                </s-stack>
              </button>
              <button
                style={{ ...CARD_BTN, border: "2px solid transparent", background: "var(--p-color-bg-surface-secondary, #f6f6f7)" }}
                onClick={() => setScreen(2)}
              >
                <s-text type="strong">{t('onboarding.wooNo')}</s-text>
              </button>
            </div>
          </>
        )}

        {/* ── Screen 2: Bsale ── */}
        {screen === 2 && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <s-text color="subdued">{t('onboarding.step', { current: 2, total: 2 })}</s-text>
              <div style={{ display: "flex", gap: "6px" }}>
                <div style={{ width: "32px", height: "4px", borderRadius: "2px", background: "var(--p-color-text-success, #008060)" }} />
                <div style={{ width: "32px", height: "4px", borderRadius: "2px", background: "var(--p-color-text-success, #008060)" }} />
              </div>
            </div>

            <s-stack direction="block" gap="small">
              <s-heading>{t('onboarding.bsaleQuestion')}</s-heading>
              <s-text color="subdued">
                Conecta Bsale para sincronizar stock automáticamente en ambas direcciones.
              </s-text>
            </s-stack>

            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <button
                style={CARD_BTN}
                onClick={() => { navigate("/app/integrations/bsale"); setVisible(false); }}
              >
                <s-stack direction="block" gap="small-200">
                  <s-text type="strong">🔗 {t('onboarding.bsaleYes')}</s-text>
                  <s-text color="subdued">Sincronización bidireccional de stock entre Bsale y Shopify</s-text>
                </s-stack>
              </button>
              <button
                style={{ ...CARD_BTN, border: "2px solid transparent", background: "var(--p-color-bg-surface-secondary, #f6f6f7)" }}
                onClick={closeAndComplete}
              >
                <s-text type="strong">{t('onboarding.bsaleNo')}</s-text>
              </button>
            </div>

            <button
              onClick={() => setScreen(1)}
              style={{ background: "none", border: "none", cursor: "pointer", padding: 0, textAlign: "left" }}
            >
              <s-text color="subdued">← {t('common.back')}</s-text>
            </button>
          </>
        )}

      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { shopId, shop, kpis, abcCounts, criticalCount, attentionSkus, showOnboarding, skuCount, activeSkuCount } =
    useLoaderData<typeof loader>();

  const navigate       = useSkuBeamNavigate();
  const shopifyParams  = useShopifyParams();
  const { t } = useTranslation();
  const bsaleConnected = Boolean(shop?.bsale_token);

  // Short badge labels — avoid truncation inside narrow cards
  const criticalBadge   = criticalCount > 0 ? `${criticalCount} crítico${criticalCount > 1 ? "s" : ""}` : "OK";
  const publishedBadge  = activeSkuCount > 0 ? `${activeSkuCount.toLocaleString("es-CL")} en Shopify` : "Sin publicar";
  const rotBadge        = kpis.turnover_ratio > 0 ? "últ. 30d" : "—";

  return (
    <>
    <s-page heading={t('dashboard.title')}>

      {/* ── Fila 1: KPI strip — auto-fit grid, naturally responsive ── */}
      <s-section>
        <s-grid
          gridTemplateColumns="repeat(auto-fit, minmax(155px, 1fr))"
          gap="base"
        >
          <KpiCard
            label="SKUs sincronizados"
            value={skuCount.toLocaleString("es-CL")}
            badgeTone={activeSkuCount > 0 ? "success" : "neutral"}
            badge={publishedBadge}
          />
          <KpiCard
            label={t('dashboard.criticalSkus')}
            value={criticalCount.toLocaleString("es-CL")}
            badgeTone={criticalCount > 0 ? "critical" : "success"}
            badge={criticalBadge}
          />
          <KpiCard
            label={t('dashboard.inventoryValue')}
            value={fmtCurrency(kpis.estimated_stock_value)}
          />
          <KpiCard
            label={t('dashboard.unitsSold')}
            value={kpis.units_sold_30d.toLocaleString("es-CL")}
          />
          <KpiCard
            label={t('dashboard.rotation')}
            value={fmtRatio(kpis.turnover_ratio)}
            badgeTone={kpis.turnover_ratio > 0 ? "info" : "neutral"}
            badge={rotBadge}
          />
        </s-grid>
      </s-section>

      {/* ── Fila 2 left: SKUs que necesitan atención ── */}
      <s-section heading={t('dashboard.criticalSkusTitle')}>
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
      <s-section slot="aside" heading={t('dashboard.bsaleStatus')}>
        <s-stack direction="block" gap="base">
          {bsaleConnected ? (
            <>
              <s-badge tone="success">{t('integrations.bsale.connected')} ✓</s-badge>
              <s-stack direction="block" gap="small">
                <s-text color="subdued">{t('integrations.bsale.lastSync')}</s-text>
                <s-text>{fmtDate(shop?.bsale_last_sync)}</s-text>
              </s-stack>
              <s-text color="subdued">{shopId}</s-text>
              <s-button variant="secondary" onClick={() => navigate("/app/integrations")}>
                {t('dashboard.syncNow')}
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
                {t('dashboard.connectBsale')}
              </s-button>
            </>
          )}
        </s-stack>
      </s-section>

      {/* ── Fila 2 right: Resumen ABC (aside) ── */}
      <s-section slot="aside" heading={t('dashboard.abcSummary')}>
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

    {/* Onboarding overlay — rendered outside s-page so it covers everything */}
    {showOnboarding && <OnboardingFlow navigate={navigate} />}
  </>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
