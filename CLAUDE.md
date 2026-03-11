# SkuBeam — CLAUDE.md

## Qué es este proyecto

**SkuBeam** es una app embebida de Shopify para gestión de inventario y SKUs, dirigida a merchants mid-market (500–10k SKUs). Construida exclusivamente para Shopify con objetivo de certificación **"Built for Shopify"**.

Stack: **Remix (React Router v7) + Supabase + Shopify App Bridge + Polaris**

---

## Estructura real del proyecto

```
skubeam/
├── app/
│   ├── routes/
│   │   ├── app.tsx                          # Layout principal con AppProvider
│   │   ├── app._index.tsx                   # Dashboard /app
│   │   ├── app.additional.tsx               # Ejemplo del scaffold — puede borrarse
│   │   ├── auth.$.tsx                       # OAuth — NO TOCAR
│   │   ├── auth.login/                      # Login flow — NO TOCAR
│   │   ├── webhooks.app.uninstalled.tsx     # APP_UNINSTALLED webhook
│   │   ├── webhooks.app.scopes_update.tsx   # Scopes update webhook
│   │   │
│   │   # RUTAS A CREAR:
│   │   ├── app.skus._index.tsx              # Lista de SKUs
│   │   ├── app.skus.$id.tsx                 # Detalle de SKU
│   │   ├── app.skus.new.tsx                 # Crear SKU
│   │   ├── app.forecast.tsx                 # Forecasting
│   │   ├── app.analytics.tsx                # Analytics / ABC analysis
│   │   ├── app.settings.tsx                 # Config del merchant
│   │   ├── webhooks.gdpr.tsx                # GDPR handlers (obligatorio)
│   │   └── api.sync.tsx                     # Trigger sync manual
│   │
│   ├── db.server.ts                         # REEMPLAZAR: era Prisma, ahora Supabase
│   ├── shopify.server.ts                    # Config Shopify — MODIFICAR session storage
│   ├── entry.server.tsx                     # No tocar
│   ├── root.tsx                             # Root layout
│   ├── routes.ts                            # Registro de rutas
│   │
│   # CARPETAS A CREAR:
│   ├── lib/
│   │   ├── supabase.server.ts               # Cliente Supabase con tenant isolation
│   │   └── billing.server.ts                # Shopify Billing API
│   └── models/
│       ├── sku.server.ts                    # CRUD de SKUs
│       ├── inventory.server.ts              # Queries de inventario
│       └── forecast.server.ts              # Lógica de forecasting
│
├── supabase/
│   ├── migrations/                          # SQL migrations versionadas
│   └── seed.sql                             # Datos de desarrollo
│
├── prisma/                                  # ELIMINAR después de migrar a Supabase
│   ├── schema.prisma
│   └── migrations/
│
├── extensions/                              # Shopify extensions (futuro)
├── shopify.app.toml                         # Config de la app — REVISAR scopes
├── shopify.web.toml                         # Scripts de dev/build
├── CLAUDE.md                                # Este archivo
└── .claude/
    ├── agents/
    │   ├── shopify-sync-agent.md
    │   ├── supabase-migration-agent.md
    │   ├── forecast-agent.md
    │   └── compliance-agent.md
    └── skills/
        ├── shopify-api/SKILL.md
        ├── remix-shopify/SKILL.md
        └── supabase-patterns/SKILL.md
```

---

## Stack técnico

| Capa | Tecnología | Notas |
|---|---|---|
| Framework | Remix / React Router v7 | Scaffold de Shopify CLI |
| UI | Shopify Polaris v13 | Obligatorio para Built for Shopify |
| App Bridge | @shopify/app-bridge-react | Embedded app en Shopify Admin |
| DB / Auth | Supabase | Reemplaza Prisma del scaffold |
| Session Storage | Supabase (custom adapter) | Reemplaza SQLite del scaffold |
| ORM | Supabase JS client + RLS | Multi-tenant por shop_id |
| Jobs async | Supabase Edge Functions | Forecasting batch, sync masivo |
| Deploy | Fly.io | Remix server-side |
| Testing | Vitest | Unit tests |

---

## MIGRACIÓN PRISMA → SUPABASE

### Estado actual del scaffold
El CLI generó Prisma + SQLite para manejar sesiones OAuth. Hay que reemplazarlo.

### Paso 1 — Instalar dependencias
```bash
npm install @supabase/supabase-js
npm install @supabase/auth-helpers-remix
npm uninstall @prisma/client prisma @shopify/shopify-app-session-storage-prisma
```

### Paso 2 — Reemplazar app/db.server.ts
```typescript
// app/db.server.ts — REEMPLAZAR TODO el contenido por:
import { createClient } from "@supabase/supabase-js";

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");

// Cliente con service role — solo server-side, nunca al browser
export const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Helper con tenant isolation — usar en modelos
export function getShopClient(shopId: string) {
  return {
    client: supabaseAdmin,
    shopId,
    // Siempre filtra por shop_id automáticamente
    from: (table: string) => supabaseAdmin.from(table).eq("shop_id", shopId),
  };
}
```

### Paso 3 — Reemplazar session storage en shopify.server.ts
```typescript
// app/shopify.server.ts — cambiar el sessionStorage:

import { SupabaseSessionStorage } from "~/lib/supabase-session-storage.server";

// Reemplazar:
// sessionStorage: new PrismaSessionStorage(prisma),
// Por:
sessionStorage: new SupabaseSessionStorage(supabaseAdmin),
```

### Paso 4 — Crear el adapter de sesiones para Supabase
Ver `.claude/skills/supabase-patterns/SKILL.md` para implementación completa.

### Paso 5 — Actualizar shopify.web.toml
```toml
[commands]
# Eliminar línea de prisma migrate:
# predev = "npx prisma migrate deploy"
dev = "npm exec remix vite:dev"
```

### Paso 6 — Borrar Prisma
```bash
rm -rf prisma/
```

---

## shopify.app.toml — Scopes necesarios

```toml
[access_scopes]
scopes = "read_products,write_products,read_inventory,write_inventory,read_orders,read_locations"

# Webhooks obligatorios
[[webhooks.subscriptions]]
topics = ["app/uninstalled"]
uri = "/webhooks/app/uninstalled"

[[webhooks.subscriptions]]
topics = ["products/update"]
uri = "/webhooks/products/update"

[[webhooks.subscriptions]]
topics = ["inventory_levels/update"]
uri = "/webhooks/inventory_levels/update"

# GDPR — sin estos Shopify rechaza la app
[[webhooks.subscriptions]]
topics = ["customers/data_request"]
uri = "/webhooks/gdpr"

[[webhooks.subscriptions]]
topics = ["customers/redact"]
uri = "/webhooks/gdpr"

[[webhooks.subscriptions]]
topics = ["shop/redact"]
uri = "/webhooks/gdpr"
```

---

## Variables de entorno (.env)

```env
# Ya generadas por Shopify CLI:
SHOPIFY_API_KEY=
SHOPIFY_API_SECRET=
SHOPIFY_APP_URL=

# Agregar estas:
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=   # NUNCA exponer al cliente

# App
NODE_ENV=development
```

---

## Base de datos Supabase

### Principios de multi-tenancy
- **`shop_id` en todas las tablas** — es el dominio Shopify (`mi-tienda.myshopify.com`)
- **RLS activo en todas las tablas** — sin excepciones
- **Migrations versionadas** en `supabase/migrations/`
- **Nunca queries sin filtrar por `shop_id`**

### Tablas principales
```
shops              → Un registro por merchant instalado
skus               → SKUs/variantes sincronizadas desde Shopify
inventory_levels   → Stock por location
sales_history      → Historial para forecasting (particionado por año)
sync_jobs          → Tracking de sincronizaciones
forecast_configs   → Config de reorder point por merchant
```

Ver `.claude/agents/supabase-migration-agent.md` para el schema SQL completo.

---

## Módulos del producto

### Módulo 1: SKU Intelligence (MVP — construir primero)
- [ ] Reemplazar Prisma por Supabase (PRIMER PASO)
- [ ] Sync inicial de productos desde Shopify al instalar
- [ ] Lista de SKUs con búsqueda y filtros (Polaris DataTable)
- [ ] Detalle de SKU con edición
- [ ] SKU health score (sin barcode, sin imagen = penalización)
- [ ] Generador de barcodes (Code128, QR, EAN-13)
- [ ] Bulk operations: archivar, exportar CSV
- [ ] Detección de duplicados

### Módulo 2: Forecast & Replenishment
- [ ] Velocidad de ventas por SKU (moving average 30d)
- [ ] Reorder point automático
- [ ] Dead stock detector
- [ ] PO generator (PDF)

### Módulo 3: Analytics
- [ ] ABC analysis automática
- [ ] Dashboard de margen por SKU
- [ ] Exportar reportes CSV

---

## Reglas de desarrollo

### SIEMPRE
1. `authenticate.admin(request)` al inicio de cada loader/action bajo `/app`
2. Filtrar por `shop_id` en CADA query a Supabase
3. Usar Polaris para toda la UI — no CSS custom salvo casos extremos
4. Archivos `.server.ts` para todo lo que corre en servidor
5. Webhooks idempotentes — procesar el mismo evento dos veces no rompe nada
6. TypeScript estricto — sin `any`

### NUNCA
- ❌ Llamar a Admin API desde el browser — siempre server-side
- ❌ `SUPABASE_SERVICE_ROLE_KEY` en código cliente
- ❌ Queries a Supabase sin filtro `shop_id`
- ❌ Ignorar los webhooks GDPR
- ❌ Modificar `app/routes/auth.$.tsx` — es el OAuth flow
- ❌ Modificar `app/routes/auth.login/` — es el login flow

---

## Archivos del scaffold que NO tocar

```
app/routes/auth.$.tsx           # OAuth splat route
app/routes/auth.login/          # Login UI
app/entry.server.tsx            # Entry point del servidor
```

---

## Comandos frecuentes

```bash
# Desarrollo
npm run dev                      # Shopify CLI + Remix dev server

# Supabase local
npx supabase start               # Levantar Supabase local
npx supabase db push             # Aplicar migrations
npx supabase gen types typescript --local > app/types/supabase.ts

# Shopify
shopify app info                 # Ver config de la app
shopify app deploy               # Deploy a Shopify Partners

# Limpiar tunnel si se cuelga
shopify app dev --reset
```

---

## Agentes disponibles

Invocar en Claude Code con `@nombre-del-agente`:

| Agente | Cuándo usarlo |
|---|---|
| `@shopify-sync-agent` | Sync de productos, webhooks, rate limiting |
| `@supabase-migration-agent` | Schema SQL, migrations, RLS policies |
| `@forecast-agent` | Algoritmos de forecasting, dead stock, ABC analysis |
| `@compliance-agent` | GDPR, Billing API, checklist Built for Shopify |
