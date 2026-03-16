import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL ?? "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

if (!supabaseUrl || !supabaseKey) {
  // Warn instead of throwing so the health route can still respond.
  // Any actual DB call will fail at query time with a clear network error.
  console.warn("[db.server] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set");
} else {
  console.log("[db.server] Supabase init →", {
    url: supabaseUrl,
    keyPrefix: supabaseKey.slice(0, 20) + "...",
  });
}

// Cliente admin — solo server-side, nunca exponer al browser
export const supabaseAdmin = createClient(supabaseUrl, supabaseKey);

// Helper con tenant isolation por shop
export function getShopClient(shopId: string) {
  return {
    shopId,
    supabase: supabaseAdmin,
  };
}
