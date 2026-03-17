import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { safeRedirect } from "../lib/server";
import {
  checkBilling,
  activatePlanInSupabase,
} from "../lib/billing.server";

/**
 * GET /app/billing/callback?charge_id=xxx&shop=xxx&host=xxx
 *
 * Shopify redirects here after the merchant approves (or declines) a
 * subscription. We verify the subscription is ACTIVE, persist the plan to
 * Supabase, then send the merchant back to the billing page.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  // checkBilling queries currentAppInstallation.activeSubscriptions — the
  // subscription is already ACTIVE by the time Shopify redirects here.
  const billing = await checkBilling(admin);

  if (billing) {
    await activatePlanInSupabase(session.shop, billing.plan);
  }

  const destination = billing
    ? "/app/billing?success=1"
    : "/app/billing?error=not_approved";

  return safeRedirect(request, destination);
};

// No default export — this route is loader-only (always redirects)
