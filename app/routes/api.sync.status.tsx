import type { LoaderFunctionArgs } from "react-router";
import { supabaseAdmin } from "../db.server";

/**
 * GET /api/sync/status?jobId=<uuid>
 *
 * Unauthenticated polling endpoint — does NOT call authenticate.admin().
 * The jobId UUID is unguessable, so no additional auth is needed for this
 * read-only status check.  The forecast page uses this to poll while a
 * bulk-operation job is running, avoiding the ?shop=&host= requirement
 * that authenticate.admin() imposes.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url   = new URL(request.url);
  const jobId = url.searchParams.get("jobId");

  if (!jobId) {
    return { status: null, records_processed: 0, type: null };
  }

  const { data } = await supabaseAdmin
    .from("sync_jobs")
    .select("status, records_processed, type, started_at")
    .eq("id", jobId)
    .maybeSingle();

  // Dead job detection: mark as failed if a job runs too long without completing.
  // woo_migration jobs get 24 hours (rate-limited, large catalogs can take hours).
  // bsale_products gets 30 min (large Bsale catalogs can have many pages).
  // All other jobs get 10 minutes.
  const isWooJob    = data?.type === "woo_migration" || data?.type === "woo_migration_preview";
  const isBsaleSync = data?.type === "bsale_products" || data?.type === "bsale_stock";
  const jobTimeoutMs = isWooJob ? 24 * 60 * 60 * 1000 : isBsaleSync ? 30 * 60 * 1000 : 10 * 60 * 1000;
  if (data?.status === "running" && data.started_at) {
    const ageMs = Date.now() - new Date(data.started_at).getTime();
    if (ageMs > jobTimeoutMs) {
      await supabaseAdmin
        .from("sync_jobs")
        .update({
          status:        "failed",
          error_message: `timeout - job exceeded ${isWooJob ? "24 hours" : "10 minutes"} without completing`,
          completed_at:  new Date().toISOString(),
        })
        .eq("id", jobId);

      return { status: "failed", records_processed: data.records_processed ?? 0, type: data.type ?? null };
    }
  }

  return {
    status:            data?.status            ?? null,
    records_processed: data?.records_processed ?? 0,
    type:              data?.type              ?? null,
  };
};
