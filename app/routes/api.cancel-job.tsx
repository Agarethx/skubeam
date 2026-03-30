import type { ActionFunctionArgs } from "react-router";
import { data } from "react-router";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../db.server";

/**
 * POST /api/cancel-job
 *
 * Cancels an active sync_job (pending or processing) for the authenticated shop.
 * Body: jobId (UUID)
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId   = session.shop;
  const formData = await request.formData();
  const jobId    = (formData.get("jobId") as string | null)?.trim();

  if (!jobId) return data({ ok: false, error: "jobId requerido" }, { status: 400 });

  const { error } = await supabaseAdmin
    .from("sync_jobs")
    .update({ status: "cancelled", completed_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("shop_id", shopId)
    .in("status", ["pending", "processing"]);

  if (error) return data({ ok: false, error: error.message }, { status: 500 });

  return data({ ok: true });
};
