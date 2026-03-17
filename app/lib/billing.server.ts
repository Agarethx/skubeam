import { supabaseAdmin } from "../db.server";
import { PLANS, SKU_LIMITS } from "./plans";
import type { PlanKey } from "./plans";
import { PLAN_FEATURES as FEATURE_FLAGS } from "./features";
import type { PlanFeatures } from "./features";

// Re-export so existing imports of billing.server keep working
export { PLANS, SKU_LIMITS } from "./plans";
export type { PlanKey } from "./plans";

export type BillingResult = {
  plan: PlanKey;
  features: PlanFeatures;
};

// ── Internal admin client type ────────────────────────────────────────────────

type AdminClient = {
  graphql: (
    query: string,
    opts?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

// ── GraphQL ───────────────────────────────────────────────────────────────────

const ACTIVE_SUBS_QUERY = `#graphql
  query ActiveSubscriptions {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        status
        test
      }
    }
  }`;

const SUBSCRIPTION_CREATE = `#graphql
  mutation AppSubscriptionCreate(
    $name:       String!
    $lineItems:  [AppSubscriptionLineItemInput!]!
    $returnUrl:  URL!
    $trialDays:  Int
    $test:       Boolean
  ) {
    appSubscriptionCreate(
      name:      $name
      lineItems: $lineItems
      returnUrl: $returnUrl
      trialDays: $trialDays
      test:      $test
    ) {
      confirmationUrl
      appSubscription { id status }
      userErrors { field message }
    }
  }`;

const SUBSCRIPTION_CANCEL = `#graphql
  mutation AppSubscriptionCancel($id: ID!) {
    appSubscriptionCancel(id: $id) {
      appSubscription { id status }
      userErrors { field message }
    }
  }`;

// ── Helpers ───────────────────────────────────────────────────────────────────

interface ActiveSubscription {
  id:     string;
  name:   string;
  status: string;
  test:   boolean;
}

async function getActiveSubscription(
  admin: AdminClient,
): Promise<ActiveSubscription | null> {
  const res  = await admin.graphql(ACTIVE_SUBS_QUERY);
  const json = await res.json() as {
    data?: {
      currentAppInstallation?: {
        activeSubscriptions: ActiveSubscription[];
      };
    };
  };
  const subs = json.data?.currentAppInstallation?.activeSubscriptions ?? [];
  return subs.find((s) => s.status === "ACTIVE") ?? null;
}

/** Map Shopify plan name ("Starter") → plan key ("starter"). */
export function planNameToKey(name: string): PlanKey | null {
  const entry = Object.entries(PLANS).find(([, v]) => v.name === name);
  return entry ? (entry[0] as PlanKey) : null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns the active plan key and its feature set, or null if the shop
 * has no active paid subscription.
 */
export async function checkBilling(admin: AdminClient): Promise<BillingResult | null> {
  const sub = await getActiveSubscription(admin);
  if (!sub) return null;
  const plan = planNameToKey(sub.name);
  if (!plan) return null;
  return {
    plan,
    features: FEATURE_FLAGS[plan] ?? FEATURE_FLAGS.starter,
  };
}

/**
 * Creates an app subscription and returns the confirmationUrl that the
 * merchant must visit to approve it.
 */
export async function createSubscription(
  admin:     AdminClient,
  planKey:   PlanKey,
  returnUrl: string,
): Promise<string> {
  const plan = PLANS[planKey];

  const res  = await admin.graphql(SUBSCRIPTION_CREATE, {
    variables: {
      name:      plan.name,
      returnUrl,
      trialDays: plan.trialDays,
      test:      process.env.NODE_ENV !== "production",
      lineItems: [{
        plan: {
          appRecurringPricingDetails: {
            interval: plan.interval,
            price:    { amount: plan.amount, currencyCode: plan.currencyCode },
          },
        },
      }],
    },
  });

  const json = await res.json() as {
    data?: {
      appSubscriptionCreate?: {
        confirmationUrl: string | null;
        userErrors: Array<{ field: string; message: string }>;
      };
    };
  };

  const result = json.data?.appSubscriptionCreate;
  if (result?.userErrors?.length) {
    throw new Error(`appSubscriptionCreate: ${result.userErrors[0].message}`);
  }
  if (!result?.confirmationUrl) {
    throw new Error("appSubscriptionCreate: no confirmationUrl returned");
  }

  return result.confirmationUrl;
}

/**
 * Cancels the shop's active subscription (used for plan downgrades or uninstall).
 */
export async function cancelSubscription(admin: AdminClient): Promise<void> {
  const sub = await getActiveSubscription(admin);
  if (!sub) return;

  const res  = await admin.graphql(SUBSCRIPTION_CANCEL, {
    variables: { id: sub.id },
  });
  const json = await res.json() as {
    data?: {
      appSubscriptionCancel?: {
        userErrors: Array<{ field: string; message: string }>;
      };
    };
  };

  const errors = json.data?.appSubscriptionCancel?.userErrors ?? [];
  if (errors.length) {
    throw new Error(`appSubscriptionCancel: ${errors[0].message}`);
  }
}

/**
 * Persists the confirmed plan + derived sku_limit to Supabase.
 * Called from the billing callback after Shopify confirms.
 */
export async function activatePlanInSupabase(
  shopId:  string,
  planKey: PlanKey,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("shops")
    .update({
      plan:      planKey,
      sku_limit: SKU_LIMITS[planKey],
    })
    .eq("shop_id", shopId);

  if (error) throw new Error(`activatePlanInSupabase: ${error.message}`);
}
