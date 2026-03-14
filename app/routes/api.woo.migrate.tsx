import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../db.server";
import { createWooJob, processWooMigration } from "../integrations/woo/jobs.server";

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

  const formData      = await request.formData();
  const includeOrders = formData.get("include_orders") === "1";
  const preview       = formData.get("preview") === "1";

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

  // TEMP: direct await to surface the full error in logs.
  // Revert to fire-and-forget once migration is confirmed working.
  try {
    await processWooMigration(job.id, shopId, includeOrders, preview);
    console.log("[woo-migrate] processWooMigration completed");
  } catch (err) {
    console.error("[woo-migrate] processWooMigration FAILED", err);
  }

  return { jobId: job.id, preview };
};
