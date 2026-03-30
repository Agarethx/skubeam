import type { ActionFunctionArgs } from "react-router";
import { data } from "react-router";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../db.server";

const MAX_BULK = 500;

/**
 * POST /api/bulk-publish
 *
 * Enqueues a bulk_publish job for up to MAX_BULK unpublished SKUs and
 * fires the worker. Returns { ok, jobId, total } immediately.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  // Avoid duplicate jobs
  const { data: existing } = await supabaseAdmin
    .from("sync_jobs")
    .select("id, status")
    .eq("shop_id", shopId)
    .eq("type", "bulk_publish")
    .in("status", ["pending", "processing"])
    .limit(1)
    .maybeSingle();

  if (existing) {
    return data({ ok: true, jobId: existing.id, total: 0, alreadyRunning: true });
  }

  // Fetch first MAX_BULK unpublished SKU IDs
  const { data: skus } = await supabaseAdmin
    .from("skus")
    .select("id")
    .eq("shop_id", shopId)
    .is("shopify_variant_id", null)
    .limit(MAX_BULK);

  const total = skus?.length ?? 0;
  if (total === 0) {
    return data({ ok: true, jobId: null, total: 0 });
  }

  const { data: job, error } = await supabaseAdmin
    .from("sync_jobs")
    .insert({
      shop_id:  shopId,
      type:     "bulk_publish",
      status:   "pending",
      payload:  { sku_ids: (skus ?? []).map((s) => s.id), total },
    })
    .select("id")
    .single();

  if (error || !job) {
    return data({ ok: false, message: "No se pudo crear el job" }, { status: 500 });
  }

  // Fire-and-forget: trigger the worker
  fetch(`${process.env.APP_URL}/api/worker`, {
    method:  "POST",
    headers: { "x-worker-secret": process.env.WORKER_SECRET ?? "" },
  }).catch(() => {});

  return data({ ok: true, jobId: job.id, total });
};
