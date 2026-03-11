import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getActiveSyncJob, processBulkJsonl } from "../models/sync.server";
import { supabaseAdmin } from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Webhook ${topic} for ${shop}`);

  const webhookPayload = payload as {
    status?: string;
    url?: string;
    error_code?: string;
    admin_graphql_api_id?: string;
  };

  if (webhookPayload.status === "completed" && webhookPayload.url) {
    const job = await getActiveSyncJob(shop);
    if (job) {
      await processBulkJsonl(webhookPayload.url, shop, job.id);
    }
  } else if (
    webhookPayload.status === "failed" ||
    webhookPayload.status === "canceled"
  ) {
    const job = await getActiveSyncJob(shop);
    if (job) {
      await supabaseAdmin
        .from("sync_jobs")
        .update({
          status: "failed",
          error_message: webhookPayload.error_code ?? "Unknown error",
          completed_at: new Date().toISOString(),
        })
        .eq("id", job.id);
    }
  }

  return new Response(null, { status: 200 });
};
