import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import { safeRedirect } from "../lib/server";
import { PLANS, PLAN_FEATURES } from "../lib/plans";
import { createSubscription } from "../lib/billing.server";
import { getShop } from "../models/shop.server";

// ── Loader ────────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getShop(session.shop);

  const url        = new URL(request.url);
  const success    = url.searchParams.get("success") === "1";
  const errorParam = url.searchParams.get("error");

  return {
    currentPlan: (shop?.plan ?? "trial") as string,
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

// ── Checkmark icon ────────────────────────────────────────────────────────────

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

// ── Plan card ─────────────────────────────────────────────────────────────────

function PlanCard({
  planKey,
  isCurrentPlan,
  isPopular,
  submitting,
}: {
  planKey:       keyof typeof PLANS;
  isCurrentPlan: boolean;
  isPopular:     boolean;
  submitting:    boolean;
}) {
  const plan     = PLANS[planKey];
  const features = PLAN_FEATURES[planKey];

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
          {features.map((feature) => (
            <div
              key={feature}
              style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}
            >
              <CheckIcon />
              <s-text>{feature}</s-text>
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

        {/* Plan cards */}
        <s-section>
          <div
            style={{
              display:             "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap:                 "20px",
              alignItems:          "stretch",
            }}
          >
            {planEntries.map((key) => (
              <PlanCard
                key={key}
                planKey={key}
                isCurrentPlan={currentPlan === key}
                isPopular={key === "growth"}
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
