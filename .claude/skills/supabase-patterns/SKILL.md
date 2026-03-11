# Skill: supabase-patterns

Patrones de Supabase para SkuBeam. Incluye el adapter de sesiones que reemplaza Prisma, multi-tenancy, y RLS.

---

## CRÍTICO: Supabase Session Storage Adapter

El scaffold de Shopify usa `@shopify/shopify-app-session-storage-prisma`. Hay que reemplazarlo con un adapter custom para Supabase.

```typescript
// app/lib/supabase-session-storage.server.ts
import type { Session, SessionStorage } from "@shopify/shopify-app-remix/server";
import type { SupabaseClient } from "@supabase/supabase-js";

export class SupabaseSessionStorage implements SessionStorage {
  constructor(private supabase: SupabaseClient) {}

  async storeSession(session: Session): Promise<boolean> {
    const { error } = await this.supabase
      .from("shopify_sessions")
      .upsert({
        id: session.id,
        shop: session.shop,
        state: session.state,
        is_online: session.isOnline,
        scope: session.scope,
        expires: session.expires?.toISOString() ?? null,
        access_token: session.accessToken,
        user_id: (session as any).onlineAccessInfo?.associated_user?.id?.toString() ?? null,
      }, { onConflict: "id" });

    return !error;
  }

  async loadSession(id: string): Promise<Session | undefined> {
    const { data, error } = await this.supabase
      .from("shopify_sessions")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !data) return undefined;

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
    const { data, error } = await this.supabase
      .from("shopify_sessions")
      .select("*")
      .eq("shop", shop);

    if (error || !data) return [];

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
```

---

## Migration SQL para sesiones

```sql
-- supabase/migrations/001_shopify_sessions.sql
create table shopify_sessions (
  id text primary key,
  shop text not null,
  state text not null,
  is_online boolean default false,
  scope text,
  expires timestamptz,
  access_token text,
  user_id text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Índice para buscar sesiones por shop (usado en findSessionsByShop)
create index shopify_sessions_shop_idx on shopify_sessions(shop);

-- RLS: las sesiones son internas, solo acceso via service_role
alter table shopify_sessions enable row level security;
-- Sin políticas públicas = nadie accede salvo service_role
```

---

## shopify.server.ts completo con Supabase

```typescript
// app/shopify.server.ts — versión completa con Supabase
import "@shopify/shopify-app-remix/server/adapters/node";
import {
  AppDistribution,
  shopifyApp,
  LATEST_API_VERSION,
} from "@shopify/shopify-app-remix/server";
import { supabaseAdmin } from "~/db.server";
import { SupabaseSessionStorage } from "~/lib/supabase-session-storage.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY!,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: LATEST_API_VERSION,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new SupabaseSessionStorage(supabaseAdmin),
  distribution: AppDistribution.AppStore,
  future: {
    unstable_newEmbeddedAuthStrategy: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = LATEST_API_VERSION;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
```

---

## db.server.ts — reemplazo de Prisma

```typescript
// app/db.server.ts — reemplazar TODO el archivo
import { createClient } from "@supabase/supabase-js";
import type { Database } from "~/types/supabase"; // Generado con supabase gen types

if (!process.env.SUPABASE_URL) {
  throw new Error("SUPABASE_URL is required");
}
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");
}

// Cliente admin — solo server-side
export const supabaseAdmin = createClient<Database>(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Helper con tenant isolation por shop
// Usar en todos los modelos: getShopClient(session.shop).from("skus")
export function getShopClient(shopId: string) {
  return {
    shopId,
    from: <T extends keyof Database["public"]["Tables"]>(table: T) =>
      supabaseAdmin
        .from(table)
        .eq("shop_id" as any, shopId),
  };
}
```

---

## shopify.web.toml — eliminar referencia a Prisma

```toml
# shopify.web.toml — versión limpia sin Prisma
[build]
automatically_update_urls_on_dev = true

[commands]
dev = "npm exec remix vite:dev"
```

---

## Patrón estándar en modelos

```typescript
// app/models/sku.server.ts
import { supabaseAdmin, getShopClient } from "~/db.server";

export async function getSkus(shopId: string, options?: {
  status?: string;
  search?: string;
  limit?: number;
}) {
  let query = supabaseAdmin
    .from("skus")
    .select("*, inventory_levels(quantity)")
    .eq("shop_id", shopId)
    .order("sku_code");

  if (options?.status) {
    query = query.eq("status", options.status);
  }

  if (options?.search) {
    query = query.ilike("sku_code", `%${options.search}%`);
  }

  if (options?.limit) {
    query = query.limit(options.limit);
  }

  const { data, error } = await query;
  if (error) throw new Error(`getSkus: ${error.message}`);
  return data ?? [];
}

export async function upsertSkuFromShopify(
  shopId: string,
  variantData: {
    shopify_variant_id: number;
    shopify_product_id: number;
    sku_code: string;
    barcode: string | null;
    title: string;
  }
) {
  const { data, error } = await supabaseAdmin
    .from("skus")
    .upsert(
      { shop_id: shopId, ...variantData },
      { onConflict: "shopify_variant_id" }
    )
    .select()
    .single();

  if (error) throw new Error(`upsertSku: ${error.message}`);
  return data;
}
```

---

## Tipos TypeScript desde Supabase

Después de cada migration, regenerar tipos:

```bash
npx supabase gen types typescript --local > app/types/supabase.ts
```

Esto genera tipos exactos para todas las tablas, eliminando la necesidad de definirlos manualmente.
