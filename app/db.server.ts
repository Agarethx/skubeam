import { createClient } from "@supabase/supabase-js";

if (!process.env.SUPABASE_URL) {
  throw new Error("SUPABASE_URL is required");
}
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");
}

console.log("[db.server] Supabase init →", {
  url: process.env.SUPABASE_URL,
  keyPrefix: process.env.SUPABASE_SERVICE_ROLE_KEY?.slice(0, 20) + "...",
});

// Cliente admin — solo server-side, nunca exponer al browser
export const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Helper con tenant isolation por shop
// Usar en todos los modelos: getShopClient(session.shop)
export function getShopClient(shopId: string) {
  return {
    shopId,
    supabase: supabaseAdmin,
  };
}
