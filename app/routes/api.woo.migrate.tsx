import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../db.server";
import { createWooJob, processWooMigration, type WooMigrationMode } from "../integrations/woo/jobs.server";

/**
 * POST /api/woo/migrate
 *
 * Creates a sync_job of type "woo_migration", fires processWooMigration
 * in the background, and returns the jobId immediately.
 *
 * The client polls /api/sync/status?jobId=X to track progress.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("[woo-migrate] action start");

  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  console.log("[woo-migrate] shopId", shopId);

  const formData = await request.formData();
  const preview  = formData.get("preview") === "1";
  // preview always runs both phases; otherwise use explicit mode (default: "products")
  const mode: WooMigrationMode = preview
    ? "all"
    : (formData.get("mode") as WooMigrationMode | null) ?? "products";

  console.log("[woo-migrate] formData", Object.fromEntries(formData));

  console.log("[woo-migrate] looking for woo_connection", shopId);
  const { data: conn, error: connError } = await supabaseAdmin
    .from("woo_connections")
    .select("*")
    .eq("shop_id", shopId)
    .order("analyzed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  console.log("[woo-migrate] conn found", conn);

  if (connError) console.error("[woo-migrate] conn DB error", connError.message);
  if (!conn) {
    console.error("[woo-migrate] NO CONNECTION FOUND for", shopId);
    return { error: "Analiza tu tienda primero para guardar las credenciales." };
  }

  const job = await createWooJob(shopId, preview);
  console.log("[woo-migrate] job created", job.id);

  // Fire-and-forget — returns jobId immediately so the client can start polling.
  // processWooMigration handles its own error logging and marks the job as failed.
  void processWooMigration(job.id, shopId, mode, preview);

  return { jobId: job.id, preview };
};
