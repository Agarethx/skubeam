# SkuBeam — CLAUDE.md

## Qué es este proyecto

**SkuBeam** es una app embebida de Shopify para gestión de inventario y SKUs, dirigida a merchants mid-market (500–10k SKUs). Construida exclusivamente para Shopify con objetivo de certificación **"Built for Shopify"**.

Stack: **React Router v7 (Remix) + Supabase + Shopify App Bridge v4 + Polaris web components**

---

## Estructura actual del proyecto

```
skubeam/
├── app/
│   ├── routes/
│   │   ├── app.tsx                           # Layout + AppProvider + s-app-nav
│   │   ├── app._index.tsx                    # Dashboard /app
│   │   ├── app.skus._index.tsx               # Lista de SKUs con filtros y sync
│   │   ├── app.skus.$id.tsx                  # Detalle de SKU: edición, barcode, health score
│   │   ├── auth.$.tsx                        # OAuth — NO TOCAR
│   │   ├── auth.login/                       # Login flow — NO TOCAR
│   │   ├── api.sync.tsx                      # GET polling + POST trigger de sync
│   │   ├── webhooks.app.uninstalled.tsx      # APP_UNINSTALLED
│   │   ├── webhooks.app.scopes_update.tsx    # Scopes update
│   │   ├── webhooks.bulk_operations.finish.tsx # BULK_OPERATIONS_FINISH
│   │   ├── webhooks.products.update.tsx      # PRODUCTS_UPDATE → upsertSkuFromShopify
│   │   └── webhooks.gdpr.tsx                 # CUSTOMERS_DATA_REQUEST/REDACT, SHOP_REDACT
│   │
│   ├── lib/
│   │   ├── barcode.server.ts                 # generateBarcode() con @bwip-js/node
│   │   ├── navigate.ts                       # useSkuBeamNavigate, useShopifyParams
│   │   ├── server.ts                         # safeRedirect (preserva ?shop=&host=)
│   │   └── supabase-session-storage.server.ts # SupabaseSessionStorage para OAuth
│   │
│   ├── models/
│   │   ├── shop.server.ts                    # upsertShop, getShop, checkSkuLimit
│   │   ├── sku.server.ts                     # CRUD + upsertSkuFromShopify + health score
│   │   └── sync.server.ts                    # startBulkSync, processBulkJsonl, refreshSkuAnalytics
│   │
│   ├── types/
│   │   └── supabase.ts                       # Generado: npx supabase gen types typescript --local
│   │
│   ├── db.server.ts                          # supabaseAdmin (service role)
│   └── shopify.server.ts                     # shopifyApp config + webhooks + afterAuth
│
├── supabase/
│   └── migrations/
│       ├── 001_shopify_sessions.sql          # Tabla shopify_sessions + RLS
│       ├── 003_shops.sql                     # Tabla shops con sku_limit
│       └── 20260311120654_initial_schema.sql # skus, inventory_levels, sales_history,
│                                             # sync_jobs, forecast_configs, gdpr_requests,
│                                             # sku_analytics (materialized view)
│
├── shopify.app.toml                          # Scopes + webhooks registrados
└── CLAUDE.md                                 # Este archivo
```

---

## Stack técnico

| Capa | Tecnología | Notas |
|---|---|---|
| Framework | React Router v7 (Remix) | Scaffold de Shopify CLI |
| UI | Polaris web components (`s-*`) | Polaris v13, obligatorio para Built for Shopify |
| App Bridge | @shopify/app-bridge-react v4 | No expone `navigate()` — usar React Router |
| DB | Supabase (PostgreSQL) | Multi-tenant por `shop_id` |
| Session Storage | SupabaseSessionStorage (custom) | Reemplaza SQLite/Prisma del scaffold |
| Barcodes | @bwip-js/node | ESM nativo — NO usar `bwip-js` (sin ESM) |
| Deploy | Fly.io | Server-side Remix |
| Testing | Vitest | Unit tests |

---

## Decisiones técnicas tomadas

### Navegación en app embebida (App Bridge v4)
App Bridge v4 **no expone `shopify.navigate()`** — la interfaz `ShopifyGlobal` solo tiene `toast`, `loading`, `modal`, `resourcePicker`, `intents`.

Patrón correcto en `app/lib/navigate.ts`:
- `useSkuBeamNavigate()` — usa `shopify.loading(true)` + React Router `useNavigate()` para SPA navigation sin recargar el iframe
- `useShopifyParams()` — devuelve `?shop=X&host=Y` para añadir a hrefs estáticos (`s-link`, `<a>`)
- `app.tsx` → `useEffect` limpia `shopify.loading(false)` cuando `navigation.state === "idle"`
- `s-app-nav` links son interceptados nativamente por App Bridge — no necesitan `useSkuBeamNavigate`

### Redirects server-side
`redirect()` sin `?shop=&host=` hace que App Bridge pierda el contexto del iframe. Siempre usar:
```typescript
// app/lib/server.ts
return safeRedirect(request, "/app/skus");  // preserva ?shop=&host=
```

### SupabaseSessionStorage — fix crítico
La columna `state` en `shopify_sessions` es `NOT NULL`. Durante OAuth, `session.state` puede ser `undefined`. Sin el fix, `storeSession` falla silenciosamente y la sesión nunca se guarda → loop infinito de OAuth.

```typescript
// app/lib/supabase-session-storage.server.ts
state: session.state ?? "",  // ← fix crítico
```

### Barcodes — @bwip-js/node
`bwip-js` (el paquete base) usa exports condicionales: con `moduleResolution: "Bundler"` TypeScript resuelve el build de browser que **no tiene `toBuffer`**. En runtime, Vite SSR lanza `require is not defined`.

Solución: usar `@bwip-js/node` que tiene `"import": "./dist/bwip-js-node.mjs"` (ESM nativo):
```typescript
import { toBuffer } from "@bwip-js/node";  // ✅
// import bwipjs from "bwip-js";            // ❌ falla en Vite SSR
// createRequire workaround                  // ❌ descartado
```
Pasar `width: undefined` a `toBuffer` lanza error — usar spread condicional:
```typescript
...(type === "QR" ? { width: 30 } : {})
```

### sku_analytics — vista materializada
`sku_analytics` es una **materialized view** — no se actualiza automáticamente. Hay que llamar `refreshSkuAnalytics()` explícitamente después de cada write:
- `processBulkJsonl()` → llama refresh al final del bulk sync
- `syncSkuFromShopify()` → llama refresh después de sync individual
- `upsertSkuFromShopify()` → llama refresh después de webhook update

La función SQL `refresh_sku_analytics()` usa `REFRESH MATERIALIZED VIEW CONCURRENTLY` (no bloquea lecturas) con índice único en `id`.

### Scopes actuales (shopify.app.toml)
```toml
scopes = "read_products,write_products,read_inventory,write_inventory,read_orders,read_locations"
```
El scope anterior del scaffold (`write_metaobject_definitions,...`) causaba scope mismatch con `expiringOfflineAccessTokens: true` → loop de re-auth → `shop: null` en logs.

### Webhooks registrados en shopify.server.ts
```
APP_UNINSTALLED         → /webhooks/app/uninstalled
BULK_OPERATIONS_FINISH  → /webhooks/bulk_operations/finish
PRODUCTS_UPDATE         → /webhooks/products/update
CUSTOMERS_DATA_REQUEST  → /webhooks/gdpr
CUSTOMERS_REDACT        → /webhooks/gdpr
SHOP_REDACT             → /webhooks/gdpr
```

---

## Base de datos Supabase

### Principios de multi-tenancy
- **`shop_id` en todas las tablas** — es el dominio Shopify (`mi-tienda.myshopify.com`)
- **RLS activo en todas las tablas** — sin excepciones
- **Migrations en orden**: `001_` → `003_` → `20260311...`
- **Nunca queries sin filtrar por `shop_id`**
- **Regenerar tipos** tras cualquier cambio de schema: `npx supabase gen types typescript --local > app/types/supabase.ts`

### Schema actual
```
shopify_sessions   → OAuth sessions (SupabaseSessionStorage)
shops              → Un registro por merchant (plan, sku_limit, is_active)
skus               → Variantes de Shopify sincronizadas
inventory_levels   → Stock por location
sales_history      → Historial para forecasting
sync_jobs          → Tracking de bulk operations
forecast_configs   → Config de reorder point por merchant
gdpr_requests      → Auditoría GDPR
sku_analytics      → Materialized view: total_stock, sold_30d, sold_90d, last_sold_at
```

### shops.sku_limit
```
plan = "trial"  → sku_limit = 500   (default)
plan = "basic"  → sku_limit = 2000
plan = "pro"    → sku_limit = -1    (unlimited)
```
Consultar con `checkSkuLimit(shopId)` de `app/models/shop.server.ts`.

---

## Módulos del producto

### ✅ Módulo 1: SKU Intelligence — COMPLETADO
- [x] Reemplazar Prisma por Supabase (session storage + modelos)
- [x] `upsertShop` en `afterAuth` hook (install + reinstall)
- [x] Sync bulk inicial desde Shopify (bulk operations GraphQL, ~7s para 147 SKUs)
- [x] Lista de SKUs con búsqueda, filtro por estado y paginación
- [x] Banner de progreso de sync con polling cada 5s
- [x] Detalle de SKU con formulario editable (sku_code, barcode, vendor, cost_price)
- [x] Health score con desglose de criterios (título, barcode, vendor, costo, stock, ventas)
- [x] Stock por location con tabla
- [x] Ventas 30d / 90d
- [x] Sync individual de SKU desde Shopify (intent `sync` en detalle)
- [x] Archivar / reactivar SKU
- [x] Generador de barcodes: CODE128, QR, EAN-13, EAN-8 (con @bwip-js/node)
- [x] Imprimir barcode (abre imagen en nueva pestaña)
- [x] Webhook PRODUCTS_UPDATE → `upsertSkuFromShopify` (idempotente)
- [x] Webhooks GDPR (obligatorio para Built for Shopify)
- [x] `checkSkuLimit` por plan

Pendiente del Módulo 1 (no crítico para MVP):
- [ ] Exportar CSV
- [ ] Detección de duplicados
- [ ] Bulk archivar (selección múltiple)

### 🔜 Módulo 2: Forecast & Replenishment — SIGUIENTE
- [ ] Importar `sales_history` desde Shopify Orders API
- [ ] Velocidad de ventas por SKU (moving average 30d / 90d)
- [ ] Reorder point automático = (velocidad_diaria × lead_days) + safety_stock
- [ ] Dead stock detector (sin ventas en N días con stock > 0)
- [ ] Vista `app.forecast.tsx` con tabla de SKUs en riesgo
- [ ] `forecast_configs` editable por merchant (lead_days, safety_stock_days)
- [ ] PO generator (exportar PDF con SKUs a reponer)

### Módulo 3: Analytics
- [ ] ABC analysis automática (A=top 80% ventas, B=15%, C=5%)
- [ ] Dashboard de margen por SKU (precio − costo)
- [ ] Exportar reportes CSV

---

## Reglas de desarrollo

### SIEMPRE
1. `authenticate.admin(request)` al inicio de cada loader/action bajo `/app`
2. `authenticate.webhook(request)` en todos los handlers de webhook
3. Filtrar por `shop_id` en CADA query a Supabase
4. `safeRedirect(request, path)` en lugar de `redirect(path)` para redirects entre rutas `/app`
5. Llamar `refreshSkuAnalytics()` después de cualquier write a `skus` o `inventory_levels`
6. Archivos `.server.ts` para todo lo que corre en servidor
7. Webhooks idempotentes — procesar el mismo evento dos veces no rompe nada
8. TypeScript estricto — sin `any`

### NUNCA
- ❌ `shopify.navigate()` — no existe en App Bridge v4
- ❌ `window.location.href` para navegación interna — rompe el contexto del iframe
- ❌ `redirect()` sin `safeRedirect` entre rutas `/app`
- ❌ `import bwipjs from "bwip-js"` — usar `@bwip-js/node`
- ❌ Llamar a Admin API desde el browser — siempre server-side
- ❌ `SUPABASE_SERVICE_ROLE_KEY` en código cliente
- ❌ Queries a Supabase sin filtro `shop_id`
- ❌ Ignorar los webhooks GDPR
- ❌ Modificar `app/routes/auth.$.tsx` ni `app/routes/auth.login/`

---

## Comandos frecuentes

```bash
# Desarrollo
npm run dev                      # Shopify CLI + Remix dev server

# Supabase local
npx supabase start               # Levantar Supabase local
npx supabase db reset            # Limpiar DB y re-aplicar todas las migrations
npx supabase gen types typescript --local > app/types/supabase.ts

# Verificar DB
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres

# TypeScript
npx tsc --noEmit                 # Verificar tipos sin compilar

# Shopify
shopify app deploy               # Deploy a Shopify Partners
shopify app dev --reset          # Limpiar tunnel si se cuelga
```

---

## Archivos que NO tocar

```
app/routes/auth.$.tsx           # OAuth splat route
app/routes/auth.login/          # Login UI
app/entry.server.tsx            # Entry point del servidor
```

---

## Agentes disponibles

| Agente | Cuándo usarlo |
|---|---|
| `@shopify-sync-agent` | Sync de productos, webhooks, rate limiting |
| `@supabase-migration-agent` | Schema SQL, migrations, RLS policies |
| `@forecast-agent` | Algoritmos de forecasting, dead stock, ABC analysis |
| `@compliance-agent` | GDPR, Billing API, checklist Built for Shopify |
