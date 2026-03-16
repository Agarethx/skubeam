import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useTranslation } from 'react-i18next';
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../db.server";
import { useSkuBeamNavigate } from "../lib/navigate";

// ── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  const { data: shop } = await supabaseAdmin
    .from("shops")
    .select("bsale_token")
    .eq("shop_id", shopId)
    .single();

  return { bsaleConnected: !!shop?.bsale_token };
};

// ── Types ─────────────────────────────────────────────────────────────────────

type Status = "connected" | "disconnected" | "available" | "soon";

interface IntegrationDef {
  key: string;
  name: string;
  category: string;
  description: string;
  color: string;
  initial: string;
  route: string | null;
  status: Status;
}

// ── Card ─────────────────────────────────────────────────────────────────────

const STATUS_TONE: Record<Status, "success" | "warning" | "neutral" | "caution"> = {
  connected:    "success",
  disconnected: "warning",
  available:    "neutral",
  soon:         "caution",
};

// STATUS_LABEL is now handled dynamically via i18n in IntegrationCard

function IntegrationCard({
  def,
  onConfigure,
}: {
  def: IntegrationDef;
  onConfigure: () => void;
}) {
  const { t } = useTranslation();
  const canConnect = def.status === "connected" || def.status === "available" || def.status === "disconnected";
  const btnLabel = def.status === "connected" ? "Configurar" : def.status === "soon" ? "Próximamente" : t('integrations.bsale.connect');

  const STATUS_LABEL: Record<Status, string> = {
    connected:    t('integrations.bsale.connected'),
    disconnected: "No conectado",
    available:    "Disponible",
    soon:         "Próximamente",
  };

  return (
    <div
      style={{
        border: `1px solid ${def.status === "connected" ? "var(--p-color-border-success, #008060)" : "var(--p-color-border, #e1e3e5)"}`,
        borderRadius: "var(--p-border-radius-300, 12px)",
        padding: "20px",
        background: "var(--p-color-bg-surface, #fff)",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
      }}
    >
      {/* Icon */}
      <div
        style={{
          width: "48px",
          height: "48px",
          borderRadius: "10px",
          background: def.color,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "20px",
          fontWeight: 700,
          color: "#fff",
          flexShrink: 0,
          letterSpacing: "-0.01em",
        }}
      >
        {def.initial}
      </div>

      {/* Name + category */}
      <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
        <p
          style={{
            margin: 0,
            fontSize: "var(--p-font-size-400, 1rem)",
            fontWeight: "var(--p-font-weight-bold, 700)" as React.CSSProperties["fontWeight"],
            color: "var(--p-color-text, inherit)",
          }}
        >
          {def.name}
        </p>
        <span
          style={{
            fontSize: "var(--p-font-size-300, 0.75rem)",
            color: "var(--p-color-text-subdued, #6d7175)",
          }}
        >
          {def.category}
        </span>
      </div>

      {/* Description */}
      <p
        style={{
          margin: 0,
          fontSize: "var(--p-font-size-350, 0.875rem)",
          color: "var(--p-color-text-subdued, #6d7175)",
          lineHeight: 1.5,
          flex: 1,
        }}
      >
        {def.description}
      </p>

      {/* Badge */}
      <div>
        <s-badge tone={STATUS_TONE[def.status]}>{STATUS_LABEL[def.status]}</s-badge>
      </div>

      {/* Action button */}
      <s-button
        variant={def.status === "connected" ? "secondary" : "primary"}
        {...(!canConnect ? { disabled: true } : {})}
        onClick={canConnect ? onConfigure : undefined}
      >
        {btnLabel}
      </s-button>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function IntegrationsIndex() {
  const { bsaleConnected } = useLoaderData<typeof loader>();
  const navigate = useSkuBeamNavigate();
  const { t } = useTranslation();

  const integrations: IntegrationDef[] = [
    {
      key:         "bsale",
      name:        t('integrations.bsale.title'),
      category:    "ERP y facturación · Chile",
      description: t('integrations.bsale.description'),
      color:       "#1B72BE",
      initial:     "B",
      route:       "/app/integrations/bsale",
      status:      bsaleConnected ? "connected" : "disconnected",
    },
    {
      key:         "woocommerce",
      name:        t('integrations.woocommerce.title'),
      category:    "Migración desde WordPress",
      description: t('integrations.woocommerce.description'),
      color:       "#7F54B3",
      initial:     "W",
      route:       "/app/integrations/woocommerce",
      status:      "available",
    },
    {
      key:         "defontana",
      name:        "Defontana",
      category:    "ERP · Chile",
      description: "Conector para el ERP Defontana. Sincroniza órdenes de compra, ajustes de stock y catálogo de productos automáticamente.",
      color:       "#2563EB",
      initial:     "D",
      route:       null,
      status:      "soon",
    },
    {
      key:         "facturaclub",
      name:        "Factura.cl",
      category:    "Facturación electrónica · Chile",
      description: "Emite documentos tributarios electrónicos (DTE) directamente desde SkuBeam al generar órdenes de compra o ajustes de inventario.",
      color:       "#059669",
      initial:     "F",
      route:       null,
      status:      "soon",
    },
    {
      key:         "contpaqi",
      name:        "CONTPAQi",
      category:    "ERP · México",
      description: "Integración con el sistema contable y ERP más usado en México. Sincroniza catálogo, movimientos de stock y documentos fiscales.",
      color:       "#DC2626",
      initial:     "C",
      route:       null,
      status:      "soon",
    },
  ];

  return (
    <s-page heading={t('integrations.title')}>
      <s-section heading="Conecta tus sistemas">
        <s-stack direction="block" gap="small">
          <s-text color="subdued">
            Conecta SkuBeam con tu ERP, sistema de facturación o tienda
            existente para mantener el inventario sincronizado en tiempo real.
          </s-text>
        </s-stack>
      </s-section>

      <s-section>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
            gap: "16px",
          }}
        >
          {integrations.map((def) => (
            <IntegrationCard
              key={def.key}
              def={def}
              onConfigure={() => def.route && navigate(def.route)}
            />
          ))}
        </div>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
