import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import { safeRedirect } from "../lib/server";
import { PLANS, PLAN_FEATURES } from "../lib/plans";
import { checkBilling, createSubscription } from "../lib/billing.server";

// ── Loader ────────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const billing   = await checkBilling(admin);

  const url        = new URL(request.url);
  const success    = url.searchParams.get("success") === "1";
  const errorParam = url.searchParams.get("error");

  return {
    currentPlan: billing?.plan ?? "trial",
    features:    billing?.features ?? null,
    success,
    errorParam,
  };
};

// ── Action ────────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const formData = await request.formData();
  const planKey  = formData.get("planKey") as string;

  if (!planKey || !(planKey in PLANS)) {
    return { error: "Plan inválido" };
  }

  try {
    const url       = new URL(request.url);
    const returnUrl =
      `${url.origin}/app/billing/callback?shop=${session.shop}&host=${url.searchParams.get("host") ?? ""}`;

    const confirmationUrl = await createSubscription(
      admin,
      planKey as keyof typeof PLANS,
      returnUrl,
    );

    return safeRedirect(request, confirmationUrl as unknown as string);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message };
  }
};

// ── Icons ─────────────────────────────────────────────────────────────────────

function CheckIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0, marginTop: "1px" }}
    >
      <path
        d="M4 10l4.5 4.5L16 6"
        stroke="var(--p-color-icon-success, #008060)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function XIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0, marginTop: "1px" }}
    >
      <path
        d="M5 5l10 10M15 5L5 15"
        stroke="var(--p-color-icon-subdued, #8c9196)"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ── Plan card ─────────────────────────────────────────────────────────────────

function PlanCard({
  planKey,
  isCurrentPlan,
  isPopular,
  isBsaleEntry,
  submitting,
}: {
  planKey:       keyof typeof PLANS;
  isCurrentPlan: boolean;
  isPopular:     boolean;
  isBsaleEntry:  boolean;
  submitting:    boolean;
}) {
  const plan     = PLANS[planKey];
  const features = PLAN_FEATURES[planKey] ?? [];

  return (
    <s-box
      padding="base"
      borderWidth={isCurrentPlan ? "large" : "base"}
      borderColor={isCurrentPlan ? "strong" : "base"}
      borderRadius="base"
      background={isCurrentPlan ? "subdued" : "base"}
    >
      <s-stack direction="block" gap="base">

        {/* Plan name + badges */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <s-heading>{plan.name}</s-heading>
          {isCurrentPlan && <s-badge tone="success">Tu plan actual</s-badge>}
          {isBsaleEntry && !isCurrentPlan && <s-badge tone="success">Integración Bsale</s-badge>}
          {isPopular && !isCurrentPlan && <s-badge tone="warning">Más popular</s-badge>}
        </div>

        {/* Trial badge */}
        <div>
          <s-badge tone="info">14 días gratis</s-badge>
        </div>

        {/* Price */}
        <div style={{ display: "flex", alignItems: "baseline", gap: "6px" }}>
          <span
            style={{
              fontSize:   "36px",
              fontWeight: 700,
              lineHeight: 1,
              color:      "var(--p-color-text, #202223)",
            }}
          >
            ${plan.amount}
          </span>
          <s-text tone="neutral">USD / mes</s-text>
        </div>

        {/* Divider */}
        <div style={{ borderTop: "1px solid var(--p-color-border-subdued, #e1e3e5)" }} />

        {/* Feature list */}
        <s-stack direction="block" gap="small">
          {features.map((f) => (
            <div
              key={f.label}
              style={{
                display:    "flex",
                alignItems: "flex-start",
                gap:        "8px",
                opacity:    f.included ? 1 : 0.45,
              }}
            >
              {f.included ? <CheckIcon /> : <XIcon />}
              <s-text>{f.label}</s-text>
            </div>
          ))}
        </s-stack>

        {/* CTA */}
        <Form method="post" style={{ display: "block" }}>
          <input type="hidden" name="planKey" value={planKey} />
          <div style={{ width: "100%" }}>
            <s-button
              type="submit"
              variant={isCurrentPlan ? "tertiary" : isPopular ? "primary" : "secondary"}
              disabled={isCurrentPlan || submitting}
            >
              {isCurrentPlan
                ? "Plan actual"
                : submitting
                  ? "Procesando…"
                  : "Seleccionar plan"}
            </s-button>
          </div>
        </Form>

        {/* Upsell banner — only on the Bsale entry plan card */}
        {isBsaleEntry && (
          <div
            style={{
              marginTop:    "auto",
              padding:      "10px 12px",
              background:   "var(--p-color-bg-surface-info-subdued, #f0f5ff)",
              borderRadius: "var(--p-border-radius-200, 8px)",
              fontSize:     "var(--p-font-size-300, 0.75rem)",
              color:        "var(--p-color-text-info, #0b64b7)",
            }}
          >
            💡 <strong>¿Necesitas Forecast y Analytics?</strong>{" "}
            Starter incluye todo por solo <strong>$5 más</strong>.
          </div>
        )}

      </s-stack>
    </s-box>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function BillingPage() {
  const { currentPlan, success, errorParam } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";

  const planEntries = Object.keys(PLANS) as (keyof typeof PLANS)[];

  return (
    <s-page heading="Planes y precios">
      <s-stack direction="block" gap="base">

        {/* Feedback banners */}
        {success && (
          <s-banner tone="success">
            <p>¡Plan activado correctamente! Bienvenido/a a SkuBeam.</p>
          </s-banner>
        )}
        {errorParam === "not_approved" && (
          <s-banner tone="warning">
            <p>La suscripción no fue aprobada. Puedes intentarlo de nuevo cuando quieras.</p>
          </s-banner>
        )}
        {actionData && "error" in actionData && (
          <s-banner tone="critical">
            <p>{actionData.error}</p>
          </s-banner>
        )}

        {/* Section header */}
        <s-section>
          <s-stack direction="block" gap="small">
            <s-heading>Elige tu plan</s-heading>
            <s-text tone="neutral">
              Todos los planes incluyen 14 días de prueba gratuita. Sin tarjeta de crédito al inicio.
            </s-text>
          </s-stack>
        </s-section>

        {/* Plan cards — 4 columns: Bsale, Starter, Growth, Pro */}
        <s-section>
          <div
            style={{
              display:             "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap:                 "16px",
              alignItems:          "stretch",
            }}
          >
            {planEntries.map((key) => (
              <PlanCard
                key={key}
                planKey={key}
                isCurrentPlan={currentPlan === key}
                isPopular={key === "starter"}
                isBsaleEntry={key === "bsale"}
                submitting={submitting}
              />
            ))}
          </div>
        </s-section>

        {/* Guarantee */}
        <s-section>
          <s-banner tone="info">
            <p>
              <strong>Sin riesgos.</strong> Cancela en cualquier momento desde tu panel de Shopify
              en <em>Aplicaciones → SkuBeam → Cancelar suscripción</em>. No cobramos períodos parciales.
            </p>
          </s-banner>
        </s-section>

      </s-stack>
    </s-page>
  );
}
