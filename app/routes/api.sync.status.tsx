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
    return { status: null, records_processed: 0, type: null, error_message: null };
  }

  const { data } = await supabaseAdmin
    .from("sync_jobs")
    .select("status, records_processed, type, started_at, error_message")
    .eq("id", jobId)
    .maybeSingle();

  // Dead job detection: mark as failed if a job runs too long without completing.
  // El procesamiento es fire-and-forget dentro del proceso: si el server se
  // reinicia a mitad de camino, el job queda "running" para siempre y la UI se
  // bloquea sin salida. Este corte es lo que la destraba.
  // woo_migration jobs get 24 hours (rate-limited, large catalogs can take hours).
  // bsale_products / bsale_stock get 30 min (large Bsale catalogs can have many pages).
  // All other jobs get 10 minutes.
  const isWooJob    = data?.type === "woo_migration" || data?.type === "woo_migration_preview";
  const isBsaleSync = data?.type === "bsale_products" || data?.type === "bsale_stock";
  const timeoutLabel = isWooJob ? "24 horas" : isBsaleSync ? "30 minutos" : "10 minutos";
  const jobTimeoutMs = isWooJob ? 24 * 60 * 60 * 1000 : isBsaleSync ? 30 * 60 * 1000 : 10 * 60 * 1000;

  if (data?.status === "running" && data.started_at) {
    const ageMs = Date.now() - new Date(data.started_at).getTime();
    if (ageMs > jobTimeoutMs) {
      const message = `El proceso se interrumpió: el job superó ${timeoutLabel} sin terminar (lo más común es un reinicio del servidor a mitad de la sincronización). Vuelve a ejecutarlo.`;
      await supabaseAdmin
        .from("sync_jobs")
        .update({ status: "failed", error_message: message, completed_at: new Date().toISOString() })
        .eq("id", jobId);

      return {
        status:            "failed",
        records_processed: data.records_processed ?? 0,
        type:              data.type ?? null,
        error_message:     message,
      };
    }
  }

  return {
    status:            data?.status            ?? null,
    records_processed: data?.records_processed ?? 0,
    type:              data?.type              ?? null,
    error_message:     data?.error_message     ?? null,
  };
};
