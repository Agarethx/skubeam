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
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  const formData     = await request.formData();
  const includeOrders = formData.get("include_orders") === "1";

  // Verify there's a woo_connections record for this shop
  const { data: conn } = await supabaseAdmin
    .from("woo_connections")
    .select("id")
    .eq("shop_id", shopId)
    .maybeSingle();

  if (!conn) {
    return { error: "Analiza tu tienda primero para guardar las credenciales." };
  }

  const job = await createWooJob(shopId);

  // Fire-and-forget: returns immediately, processes in background Node.js event loop
  processWooMigration(job.id, shopId, includeOrders).catch((err) =>
    console.error("[api.woo.migrate]", err),
  );

  return { jobId: job.id };
};
