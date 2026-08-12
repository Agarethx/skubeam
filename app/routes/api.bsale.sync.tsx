import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../db.server";
import {
  processBsalePricesJob,
  processBsaleStockJob,
} from "../integrations/bsale/jobs.server";

/**
 * POST /api/bsale/sync
 *
 * Receives a jobId that was already created in sync_jobs, looks up the job
 * type, then fires the actual processing in the background (fire-and-forget).
 * Returns 200 immediately so the browser never hits the Cloudflare 524 timeout.
 *
 * The client polls /api/sync/status?jobId=X (unauthenticated) to track progress.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId   = session.shop;
  const formData = await request.formData();
  const jobId    = (formData.get("jobId") as string | null)?.trim();

  if (!jobId) return { error: "jobId required" };

  // Verify the job belongs to this shop
  const { data: job } = await supabaseAdmin
    .from("sync_jobs")
    .select("id, type, status")
    .eq("id", jobId)
    .eq("shop_id", shopId)
    .maybeSingle();

  if (!job) return { error: "Job not found" };
  if (job.status !== "running") return { error: "Job is not in running state" };

  // Fire-and-forget: return immediately, process in background Node.js event loop
  if (job.type === "bsale_prices" || job.type === "bsale_prices_preview") {
    const preview = job.type === "bsale_prices_preview";
    processBsalePricesJob(jobId, shopId, { preview }).catch((err) =>
      console.error(`[api.bsale.sync] ${job.type}:`, err),
    );
  } else if (job.type === "bsale_stock") {
    processBsaleStockJob(jobId, shopId).catch((err) =>
      console.error("[api.bsale.sync] bsale_stock:", err),
    );
  } else {
    return { error: `Unknown job type: ${job.type}` };
  }

  return { started: true, jobId };
};
