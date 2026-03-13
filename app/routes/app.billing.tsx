import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import { safeRedirect } from "../lib/server";
import { PLANS, PLAN_FEATURES } from "../lib/plans";
import { createSubscription } from "../lib/billing.server";
import { supabaseAdmin } from "../db.server";

// ── Loader ────────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const { data: shop } = await supabaseAdmin
    .from("shops")
    .select("plan, sku_limit")
    .eq("shop_id", session.shop)
    .single();

  const url    = new URL(request.url);
  const success = url.searchParams.get("success") === "1";
  const errorParam = url.searchParams.get("error");

  return {
    currentPlan: (shop?.plan ?? "trial") as string,
    skuLimit:    shop?.sku_limit ?? 500,
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

    // Redirect merchant to Shopify billing confirmation page
    return safeRedirect(request, confirmationUrl as unknown as string);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message };
  }
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function BillingPage() {
  const { currentPlan, success, errorParam } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";

  const planEntries = Object.entries(PLANS) as [keyof typeof PLANS, typeof PLANS[keyof typeof PLANS]][];

  return (
    <div style={{ padding: "24px", maxWidth: "960px", margin: "0 auto" }}>
      <s-title-bar title="Planes y precios" />

      {/* Success / error banners */}
      {success && (
        <s-banner tone="success" style={{ marginBottom: "20px" }}>
          <p>¡Plan activado correctamente! Bienvenido/a.</p>
        </s-banner>
      )}
      {errorParam === "not_approved" && (
        <s-banner tone="warning" style={{ marginBottom: "20px" }}>
          <p>La suscripción no fue aprobada. Puedes intentarlo de nuevo.</p>
        </s-banner>
      )}
      {actionData && "error" in actionData && (
        <s-banner tone="critical" style={{ marginBottom: "20px" }}>
          <p>{actionData.error}</p>
        </s-banner>
      )}

      {/* Current plan notice */}
      {currentPlan !== "trial" && (
        <s-banner tone="info" style={{ marginBottom: "20px" }}>
          <p>
            Tu plan actual es <strong style={{ textTransform: "capitalize" }}>{currentPlan}</strong>.
            Para cambiar de plan, selecciona uno nuevo y aprueba el cargo en Shopify.
          </p>
        </s-banner>
      )}

      {/* Plan cards */}
      <div
        style={{
          display:             "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap:                 "20px",
        }}
      >
        {planEntries.map(([key, plan]) => {
          const isCurrentPlan = currentPlan === key;
          return (
            <div
              key={key}
              style={{
                border:       isCurrentPlan ? "2px solid #008060" : "1px solid #e1e3e5",
                borderRadius: "12px",
                padding:      "24px",
                background:   "#fff",
                position:     "relative",
                display:      "flex",
                flexDirection: "column",
                gap:           "16px",
              }}
            >
              {/* Plan name + current badge */}
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                <h2 style={{ margin: 0, fontSize: "20px", fontWeight: 600 }}>{plan.name}</h2>
                {isCurrentPlan && (
                  <s-badge tone="success">Tu plan actual</s-badge>
                )}
              </div>

              {/* Trial badge */}
              <s-badge tone="attention">14 días gratis</s-badge>

              {/* Price */}
              <div>
                <span style={{ fontSize: "32px", fontWeight: 700 }}>
                  ${plan.amount}
                </span>
                <span style={{ fontSize: "14px", color: "#6d7175" }}>/mes USD</span>
              </div>

              {/* Features */}
              <ul style={{ margin: 0, paddingLeft: "20px", display: "flex", flexDirection: "column", gap: "6px" }}>
                {PLAN_FEATURES[key].map((feature) => (
                  <li key={feature} style={{ fontSize: "14px", color: "#202223" }}>
                    {feature}
                  </li>
                ))}
              </ul>

              {/* CTA */}
              <Form method="post" style={{ marginTop: "auto" }}>
                <input type="hidden" name="planKey" value={key} />
                <s-button
                  type="submit"
                  tone={isCurrentPlan ? "default" : "success"}
                  disabled={submitting || isCurrentPlan ? "true" : undefined}
                  style={{ width: "100%" }}
                >
                  {isCurrentPlan ? "Plan actual" : submitting ? "Procesando…" : "Seleccionar"}
                </s-button>
              </Form>
            </div>
          );
        })}
      </div>

      {/* Trial info */}
      <p style={{ marginTop: "24px", fontSize: "14px", color: "#6d7175", textAlign: "center" }}>
        Todos los planes incluyen 14 días de prueba gratis. Cancela en cualquier momento desde tu panel de Shopify.
      </p>
    </div>
  );
}
