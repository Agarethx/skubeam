import type { ActionFunctionArgs } from "react-router";
import { data } from "react-router";
import { supabaseAdmin } from "../db.server";
import {
  handleBsaleDocumentAdd,
  handleShopifyOrderPaid,
  type ShopifyOrderPayload,
} from "../integrations/bsale/realtime.server";
import { emitBoleta, type ShopifyOrderForBoleta } from "../integrations/bsale/documents.server";
import { resolveToken } from "../integrations/bsale/client.server";

const BATCH_SIZE    = 5;   // jobs processed per invocation
const RATE_LIMIT_MS = 500; // ms between jobs to avoid Bsale rate limits

/**
 * POST /api/worker
 *
 * Processes pending sync_jobs in batches. Secured via x-worker-secret header.
 * Called as fire-and-forget after each webhook enqueue, or via an external cron
 * (e.g. Railway cron, Fly.io scheduled machine) for reliability.
 */
export async function action({ request }: ActionFunctionArgs) {
  // Auth check — shared secret
  const authHeader = request.headers.get("x-worker-secret");
  if (authHeader !== process.env.WORKER_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Fetch pending jobs oldest-first
  const { data: jobs } = await supabaseAdmin
    .from("sync_jobs")
    .select("*")
    .eq("status", "pending")
    .in("type", ["bsale_document", "shopify_order", "emit_boleta"])
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (!jobs?.length) {
    return data({ processed: 0, errors: 0 });
  }

  let processed = 0;
  let errors    = 0;

  for (const job of jobs) {
    // Optimistic lock — claim the job only if it is still pending
    const { data: claimed } = await supabaseAdmin
      .from("sync_jobs")
      .update({ status: "processing", started_at: new Date().toISOString() })
      .eq("id", job.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();

    if (!claimed) continue; // another worker instance claimed it first

    try {
      await processJob(job.shop_id, job.type, job.payload as Record<string, unknown> ?? {});

      await supabaseAdmin
        .from("sync_jobs")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .eq("id", job.id);

      processed++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[worker] Error procesando job ${job.id} (${job.type}):`, message);

      await supabaseAdmin
        .from("sync_jobs")
        .update({
          status:        "error",
          error_message: message,
          completed_at:  new Date().toISOString(),
        })
        .eq("id", job.id);

      errors++;
    }

    // Rate limiting between jobs
    if (processed + errors < jobs.length) {
      await new Promise<void>((resolve) => setTimeout(resolve, RATE_LIMIT_MS));
    }
  }

  console.log(`[worker] Procesados: ${processed}, Errores: ${errors}`);
  return data({ processed, errors });
}

// ── Job handlers ──────────────────────────────────────────────────────────────

async function processJob(
  shopId:  string,
  type:    string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (type === "bsale_document") {
    const resourceId = payload.resourceId as string;
    if (!resourceId) throw new Error("bsale_document job missing resourceId in payload");
    await handleBsaleDocumentAdd(shopId, resourceId);

  } else if (type === "shopify_order") {
    const order = payload.order as ShopifyOrderPayload;
    if (!order) throw new Error("shopify_order job missing order in payload");
    await handleShopifyOrderPaid(shopId, order);

  } else if (type === "emit_boleta") {
    const order    = payload.order as ShopifyOrderForBoleta;
    const officeId = (payload.officeId as number | undefined) ?? 1;
    if (!order) throw new Error("emit_boleta job missing order in payload");

    const { data: shopRow } = await supabaseAdmin
      .from("shops")
      .select("bsale_token")
      .eq("shop_id", shopId)
      .maybeSingle();

    if (!shopRow?.bsale_token) {
      console.log(`[worker] emit_boleta: shop ${shopId} has no Bsale token — skip`);
      return;
    }

    const token = resolveToken(shopRow.bsale_token);
    await emitBoleta(shopId, token, officeId, order);

  } else {
    console.warn(`[worker] Unknown job type: ${type} — skipping`);
  }
}
