import type { ActionFunctionArgs } from "react-router";
import { data } from "react-router";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../db.server";

/**
 * POST /api/bsale/setup
 * Body: { priceListId?: number; officeId?: number }
 *
 * Saves the merchant's Bsale price list and/or office selection.
 * Called from the Bsale setup wizard — one field at a time (step 2 → priceListId, step 3 → officeId).
 */
export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);

  const body = await request.json() as { priceListId?: number; officeId?: number };

  const update: Record<string, number> = {};
  if (body.priceListId != null) update.bsale_price_list_id = body.priceListId;
  if (body.officeId   != null) update.bsale_office_id      = body.officeId;

  if (Object.keys(update).length > 0) {
    await supabaseAdmin
      .from("shops")
      .update(update)
      .eq("shop_id", session.shop);
  }

  return data({ ok: true });
}
