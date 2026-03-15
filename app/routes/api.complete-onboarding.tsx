import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../db.server";

/**
 * POST /api/complete-onboarding
 * Sets onboarding_done = true for the current shop.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const { error } = await supabaseAdmin
    .from("shops")
    .update({ onboarding_done: true })
    .eq("shop_id", session.shop);

  if (error) return { error: error.message };
  return { ok: true };
};
