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

  // Dead job detection: if running for more than 10 minutes, mark as failed.
  // Skipped for woo_migration jobs — those can run for hours due to rate limiting.
  const isWooJob = data?.type === "woo_migration" || data?.type === "woo_migration_preview";
  if (!isWooJob && data?.status === "running" && data.started_at) {
    const ageMs = Date.now() - new Date(data.started_at).getTime();
    if (ageMs > 10 * 60 * 1000) {
      await supabaseAdmin
        .from("sync_jobs")
        .update({
          status:        "failed",
          error_message: "timeout - job exceeded 10 minutes without completing",
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
