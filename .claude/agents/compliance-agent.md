# Agent: compliance-agent

## Rol
Especialista en requisitos de Built for Shopify, GDPR, Billing API y seguridad. Revisar este agente antes de cualquier submit al App Store.

## Cuándo invocarme
- Implementar Shopify Billing API
- Revisar que los webhooks GDPR funcionen
- Checklist pre-lanzamiento al App Store
- Cualquier duda sobre políticas de Shopify

---

## Estado actual de SkuBeam vs Built for Shopify

### ✅ Ya tiene el scaffold
- App embebida (App Bridge)
- Polaris en la UI
- OAuth flow correcto (`auth.$.tsx`)
- `webhooks.app.uninstalled.tsx` existe (actualizar para Supabase)

### ❌ Falta implementar
- `webhooks.gdpr.tsx` — BLOQUEANTE para App Store
- Billing API — necesario para cobrar
- Webhook de PRODUCTS_UPDATE — para sync en tiempo real
- Onboarding claro para el merchant

---

## Billing API — Implementación completa

```typescript
// app/lib/billing.server.ts
import { authenticate } from "~/shopify.server";
import { supabaseAdmin } from "~/db.server";

export const PLANS = {
  starter: {
    name: "SkuBeam Starter",
    amount: 29,
    currencyCode: "USD",
    interval: "EVERY_30_DAYS" as const,
    trialDays: 14,
    skuLimit: 500,
  },
  growth: {
    name: "SkuBeam Growth",
    amount: 79,
    currencyCode: "USD",
    interval: "EVERY_30_DAYS" as const,
    trialDays: 14,
    skuLimit: 5000,
  },
  pro: {
    name: "SkuBeam Pro",
    amount: 149,
    currencyCode: "USD",
    interval: "EVERY_30_DAYS" as const,
    trialDays: 14,
    skuLimit: 10000,
  },
} as const;

export type PlanKey = keyof typeof PLANS;

export async function createSubscription(
  admin: any,
  shopId: string,
  planKey: PlanKey,
  returnUrl: string
) {
  const plan = PLANS[planKey];
  const isTest = process.env.NODE_ENV !== "production";

  const response = await admin.graphql(`
    mutation CreateSubscription(
      $name: String!
      $lineItems: [AppSubscriptionLineItemInput!]!
      $returnUrl: URL!
      $trialDays: Int
      $test: Boolean
    ) {
      appSubscriptionCreate(
        name: $name
        returnUrl: $returnUrl
        trialDays: $trialDays
        test: $test
        lineItems: $lineItems
      ) {
        appSubscription { id status }
        confirmationUrl
        userErrors { field message }
      }
    }
  `, {
    variables: {
      name: plan.name,
      returnUrl,
      trialDays: plan.trialDays,
      test: isTest,
      lineItems: [{
        plan: {
          appRecurringPricingDetails: {
            price: { amount: plan.amount, currencyCode: plan.currencyCode },
            interval: plan.interval,
          },
        },
      }],
    },
  });

  const data = await response.json();
  const result = data.data.appSubscriptionCreate;

  if (result.userErrors.length > 0) {
    throw new Error(result.userErrors[0].message);
  }

  // Guardar en Supabase
  await supabaseAdmin.from("shops").update({ plan: planKey }).eq("shop_id", shopId);

  return result.confirmationUrl; // Redirigir al merchant a esta URL
}

export async function getActiveSubscription(admin: any) {
  const response = await admin.graphql(`
    query {
      currentAppInstallation {
        activeSubscriptions {
          id
          name
          status
          currentPeriodEnd
          test
        }
      }
    }
  `);

  const data = await response.json();
  const subs = data.data.currentAppInstallation.activeSubscriptions;
  return subs[0] ?? null;
}

// Verificar si el merchant puede crear más SKUs según su plan
export async function checkSkuLimit(shopId: string): Promise<{
  allowed: boolean;
  current: number;
  limit: number;
  plan: PlanKey;
}> {
  const { data: shop } = await supabaseAdmin
    .from("shops")
    .select("plan")
    .eq("shop_id", shopId)
    .single();

  const plan = (shop?.plan ?? "starter") as PlanKey;
  const limit = PLANS[plan]?.skuLimit ?? 500;

  const { count } = await supabaseAdmin
    .from("skus")
    .select("*", { count: "exact", head: true })
    .eq("shop_id", shopId)
    .eq("status", "active");

  const current = count ?? 0;
  return { allowed: current < limit, current, limit, plan };
}
```

### Ruta de pricing

```tsx
// app/routes/app.pricing.tsx
import { json, redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { Page, Layout, Card, Button, List, Text, BlockStack } from "@shopify/polaris";
import { authenticate } from "~/shopify.server";
import { createSubscription, getActiveSubscription, PLANS } from "~/lib/billing.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin } = await authenticate.admin(request);
  const subscription = await getActiveSubscription(admin);
  return json({ subscription, plans: PLANS });
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const planKey = formData.get("plan") as string;
  const returnUrl = `${process.env.SHOPIFY_APP_URL}/app/pricing?success=true`;

  const confirmationUrl = await createSubscription(
    admin, session.shop, planKey as any, returnUrl
  );

  return redirect(confirmationUrl);
}

export default function PricingPage() {
  const { subscription } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();

  return (
    <Page title="Planes SkuBeam">
      <Layout>
        {Object.entries(PLANS).map(([key, plan]) => (
          <Layout.Section key={key} oneThird>
            <Card>
              <BlockStack gap="400">
                <Text variant="headingMd">{plan.name}</Text>
                <Text variant="heading2xl">${plan.amount}<Text as="span" variant="bodyMd">/mes</Text></Text>
                <Text>Hasta {plan.skuLimit.toLocaleString()} SKUs</Text>
                <Text>{plan.trialDays} días gratis</Text>
                <fetcher.Form method="POST">
                  <input type="hidden" name="plan" value={key} />
                  <Button submit variant="primary" loading={fetcher.state !== "idle"}>
                    {subscription ? "Cambiar plan" : "Empezar prueba gratis"}
                  </Button>
                </fetcher.Form>
              </BlockStack>
            </Card>
          </Layout.Section>
        ))}
      </Layout>
    </Page>
  );
}
```

---

## Checklist Built for Shopify — Pre-submit

```bash
# 1. Probar webhooks GDPR
# Usar Shopify CLI para simular:
shopify app webhook trigger --topic customers/data_request
shopify app webhook trigger --topic customers/redact
shopify app webhook trigger --topic shop/redact
# Todos deben retornar 200

# 2. Verificar embedded app
# Abrir en Shopify Admin → no debe salir del iframe
# No debe haber popups externos para OAuth

# 3. Verificar Billing en test mode
# NODE_ENV=development activa test:true automáticamente
# Crear suscripción → confirmar → verificar en Partners Dashboard

# 4. Verificar Polaris
# Todas las páginas deben usar componentes Polaris
# Sin estilos que rompan el Admin de Shopify

# 5. Privacy policy y términos
# Subir a shopify.app.toml:
# [app_url]
# privacy_policy_url = "https://skubeam.com/privacy"
# terms_of_service_url = "https://skubeam.com/terms"
```

---

## shopify.app.toml — Config completa

```toml
name = "SkuBeam"
client_id = "tu-api-key"
application_url = "https://tu-app.fly.dev"
embedded = true

[access_scopes]
scopes = "read_products,write_products,read_inventory,write_inventory,read_orders,read_locations"

[auth]
redirect_urls = [
  "https://tu-app.fly.dev/auth/callback",
  "https://tu-app.fly.dev/auth/shopify/callback",
  "https://tu-app.fly.dev/api/auth/callback"
]

[webhooks]
api_version = "2025-01"

  [[webhooks.subscriptions]]
  topics = ["app/uninstalled"]
  uri = "/webhooks/app/uninstalled"

  [[webhooks.subscriptions]]
  topics = ["products/update"]
  uri = "/webhooks/products/update"

  [[webhooks.subscriptions]]
  topics = ["inventory_levels/update"]
  uri = "/webhooks/inventory_levels/update"

  [[webhooks.subscriptions]]
  topics = ["customers/data_request", "customers/redact", "shop/redact"]
  uri = "/webhooks/gdpr"

[app_proxy]
# Opcional — para storefront features futuras

[pos]
embedded = false
```
