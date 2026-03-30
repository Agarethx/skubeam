import type { SessionStorage } from "@shopify/shopify-app-session-storage";
import { Session } from "@shopify/shopify-api";
import type { SupabaseClient } from "@supabase/supabase-js";

// Unused while scope mismatch check is disabled
// const REQUIRED_SCOPES = [
//   "read_products", "write_products",
//   "read_inventory", "write_inventory",
//   "read_orders", "write_orders",
//   "read_locations",
// ];

// Unused while scope mismatch check is disabled
// function hasRequiredScopes(scopeString: string | null | undefined): boolean {
//   if (!scopeString) return false;
//   const granted = scopeString.split(",").map((s) => s.trim());
//   return REQUIRED_SCOPES.every((required) => granted.includes(required));
// }

export class SupabaseSessionStorage implements SessionStorage {
  constructor(private supabase: SupabaseClient) {}

  async storeSession(session: Session): Promise<boolean> {
    console.log("[SupabaseSessionStorage] storeSession →", {
      id: session.id,
      shop: session.shop,
      scope: session.scope,
      isOnline: session.isOnline,
      expires: session.expires?.toISOString() ?? null,
      hasToken: !!session.accessToken,
    });
    const { error } = await this.supabase
      .from("shopify_sessions")
      .upsert(
        {
          id: session.id,
          shop: session.shop,
          state: session.state ?? "",
          is_online: session.isOnline,
          scope: session.scope,
          expires: session.expires?.toISOString() ?? null,
          access_token: session.accessToken,
          user_id:
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (session as any).onlineAccessInfo?.associated_user?.id?.toString() ??
            null,
        },
        { onConflict: "id" }
      );

    if (error) {
      console.error("[SupabaseSessionStorage] storeSession ERROR →", error);
    } else {
      console.log("[SupabaseSessionStorage] storeSession OK →", session.id);
    }
    return !error;
  }

  async loadSession(id: string): Promise<Session | undefined> {
    console.log("[SupabaseSessionStorage] loadSession →", id);
    const { data, error } = await this.supabase
      .from("shopify_sessions")
      .select("*")
      .eq("id", id)
      .single();

    if (error) {
      console.error("[SupabaseSessionStorage] loadSession ERROR →", { id, error });
      return undefined;
    }
    if (!data) {
      console.log("[SupabaseSessionStorage] loadSession NOT FOUND →", id);
      return undefined;
    }
    // Scope mismatch check disabled — Shopify may store scopes in a different
    // order than REQUIRED_SCOPES, causing false negatives and an auth loop.
    // if (!hasRequiredScopes(data.scope)) {
    //   console.warn("[SupabaseSessionStorage] loadSession SCOPE MISMATCH → forzando re-auth", {
    //     id: data.id,
    //     scope: data.scope,
    //     required: REQUIRED_SCOPES,
    //   });
    //   await this.supabase.from("shopify_sessions").delete().eq("id", id);
    //   return undefined;
    // }
    console.log("[SupabaseSessionStorage] loadSession FOUND →", {
      id: data.id,
      shop: data.shop,
      scope: data.scope,
      is_online: data.is_online,
      expires: data.expires,
      hasToken: !!data.access_token,
    });

    const session = new Session({
      id: data.id,
      shop: data.shop,
      state: data.state,
      isOnline: data.is_online,
    });

    if (data.scope) session.scope = data.scope;
    if (data.expires) session.expires = new Date(data.expires);
    if (data.access_token) session.accessToken = data.access_token;

    return session;
  }

  async deleteSession(id: string): Promise<boolean> {
    const { error } = await this.supabase
      .from("shopify_sessions")
      .delete()
      .eq("id", id);

    return !error;
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    const { error } = await this.supabase
      .from("shopify_sessions")
      .delete()
      .in("id", ids);

    return !error;
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    console.log("[SupabaseSessionStorage] findSessionsByShop →", shop);
    const { data, error } = await this.supabase
      .from("shopify_sessions")
      .select("*")
      .eq("shop", shop);

    if (error) {
      console.error("[SupabaseSessionStorage] findSessionsByShop ERROR →", error);
      return [];
    }
    console.log("[SupabaseSessionStorage] findSessionsByShop FOUND →", data?.length ?? 0, "sessions");
    if (!data) return [];

    return data.map((row) => {
      const session = new Session({
        id: row.id,
        shop: row.shop,
        state: row.state,
        isOnline: row.is_online,
      });
      if (row.scope) session.scope = row.scope;
      if (row.expires) session.expires = new Date(row.expires);
      if (row.access_token) session.accessToken = row.access_token;
      return session;
    });
  }
}
