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
│   │   ├── app.tsx                              # Layout + AppProvider + s-app-nav
│   │   ├── app._index.tsx                       # Dashboard /app
│   │   ├── app.skus._index.tsx                  # Lista de SKUs con filtros y sync
│   │   ├── app.skus.$id.tsx                     # Detalle de SKU: edición, barcode, health score
│   │   ├── app.forecast.tsx                     # Forecast & Replenishment
│   │   ├── app.analytics._index.tsx             # Analytics: KPIs + ABC + Velocity chart
│   │   ├── auth.$.tsx                           # OAuth — NO TOCAR
│   │   ├── auth.login/                          # Login flow — NO TOCAR
│   │   ├── api.sync.tsx                         # GET polling + POST trigger de sync (products/orders)
│   │   ├── api.sync.status.tsx                  # GET /api/sync/status?jobId= (sin auth, para polling)
│   │   ├── webhooks.app.uninstalled.tsx         # APP_UNINSTALLED
│   │   ├── webhooks.app.scopes_update.tsx       # Scopes update
│   │   ├── webhooks.bulk_operations.finish.tsx  # BULK_OPERATIONS_FINISH
│   │   ├── webhooks.products.update.tsx         # PRODUCTS_UPDATE → upsertSkuFromShopify
│   │   ├── webhooks.orders.paid.tsx             # ORDERS_PAID → handleShopifyOrderPaid (Bsale adj.)
│   │   ├── webhooks.bsale.document.tsx          # POST /webhooks/bsale/document (público, Bsale→Shopify)
│   │   └── webhooks.gdpr.tsx                    # CUSTOMERS_DATA_REQUEST/REDACT, SHOP_REDACT
│   │
│   ├── lib/
│   │   ├── barcode.server.ts                    # generateBarcode() con @bwip-js/node
│   │   ├── navigate.ts                          # useSkuBeamNavigate, useShopifyParams
│   │   ├── server.ts                            # safeRedirect (preserva ?shop=&host=)
│   │   └── supabase-session-storage.server.ts   # SupabaseSessionStorage para OAuth
│   │
│   ├── models/
│   │   ├── shop.server.ts                       # upsertShop, getShop, checkSkuLimit
│   │   ├── sku.server.ts                        # CRUD + upsertSkuFromShopify + health score
│   │   ├── sync.server.ts                       # startBulkSync, startOrdersSync, processBulkJsonl,
│   │   │                                        # processOrdersJsonl, refreshSkuAnalytics
│   │   ├── forecast.server.ts                   # getForecastForShop, getDeadStockSkus, hasSalesData
│   │   └── analytics.server.ts                  # getShopKpis, getAbcAnalysis, getTopSkusByVelocity
│   │
│   ├── types/
│   │   └── supabase.ts                          # Generado: npx supabase gen types typescript --local
│   │
│   ├── db.server.ts                             # supabaseAdmin (service role)
│   └── shopify.server.ts                        # shopifyApp config + webhooks + afterAuth
│
├── supabase/
│   ├── migrations/
│   │   ├── 001_shopify_sessions.sql             # Tabla shopify_sessions + RLS
│   │   ├── 003_shops.sql                        # Tabla shops con sku_limit
│   │   ├── 20260311120654_initial_schema.sql    # skus, inventory_levels, sales_history,
│   │   │                                        # sync_jobs, forecast_configs, gdpr_requests,
│   │   │                                        # sku_analytics (materialized view)
│   │   ├── 20260312000000_sales_history_line_item.sql  # shopify_line_item_id para idempotencia
│   │   └── 20260312_bidirectional_sync.sql             # processed_webhooks + bsale_variant_id en skus
│   └── seed.sql                                 # Datos de prueba para forecast/analytics (10 SKUs)
│
├── shopify.app.toml                             # Scopes + webhooks registrados
└── CLAUDE.md                                    # Este archivo
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

### sku_analytics — fuente de verdad para analytics

`sku_analytics` es una **materialized view** y la **fuente canónica para todos los cálculos de analytics, forecast y KPIs**. Ningún módulo debe calcular métricas derivadas (stock total, sold_30d, sold_90d, last_sold_at) desde las tablas base — siempre leer desde `sku_analytics`.

**Regla crítica**: la vista NO se actualiza automáticamente. `refreshSkuAnalytics()` debe llamarse explícitamente después de **cualquier operación que modifique stock o ventas**:

| Operación | Dónde se llama refresh |
|---|---|
| Sync bulk de productos | `processBulkJsonl()` — al final |
| Sync individual de SKU | `syncSkuFromShopify()` — al final |
| Webhook PRODUCTS_UPDATE | `upsertSkuFromShopify()` — al final |
| Importar órdenes | `processOrdersJsonl()` — al final |
| Cualquier write a `inventory_levels` | Llamar `refreshSkuAnalytics()` manualmente |
| Cualquier write a `sales_history` | Llamar `refreshSkuAnalytics()` manualmente |

La función SQL usa `REFRESH MATERIALIZED VIEW CONCURRENTLY` — no bloquea lecturas gracias al índice único en `id`. Si una operación omite el refresh, `sku_analytics` queda desincronizada y todos los módulos (Forecast, Analytics, Health Score) mostrarán datos stale.

Columnas disponibles en `sku_analytics`:
```
id, shop_id, sku_code, title, vendor, status, cost_price,
total_stock, sold_30d, sold_90d, last_sold_at
```

### Polling de jobs sin autenticación
Los endpoints de polling para bulk operations **no deben usar `authenticate.admin()`** porque el fetcher del cliente no puede incluir `?shop=&host=` automáticamente.

Patrón: `api.sync.status.tsx` — endpoint público que recibe `?jobId=<uuid>` y consulta Supabase directamente. El UUID no adivinable es suficiente como token de acceso para datos de solo lectura.

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
ORDERS_PAID             → /webhooks/orders/paid  (Bsale stock adjustment)
CUSTOMERS_DATA_REQUEST  → /webhooks/gdpr
CUSTOMERS_REDACT        → /webhooks/gdpr
SHOP_REDACT             → /webhooks/gdpr
```

---

## Base de datos Supabase

### Principios de multi-tenancy
- **`shop_id` en todas las tablas** — es el dominio Shopify (`mi-tienda.myshopify.com`)
- **RLS activo en todas las tablas** — sin excepciones
- **Migrations en orden**: `001_` → `003_` → `20260311...` → `20260312...`
- **Nunca queries sin filtrar por `shop_id`**
- **Regenerar tipos** tras cualquier cambio de schema: `npx supabase gen types typescript --local > app/types/supabase.ts`

### Schema actual
```
shopify_sessions   → OAuth sessions (SupabaseSessionStorage)
shops              → Un registro por merchant (plan, sku_limit, is_active)
skus               → Variantes de Shopify sincronizadas
inventory_levels   → Stock por location
sales_history      → Historial de ventas (shopify_line_item_id para idempotencia)
sync_jobs          → Tracking de bulk operations (type: full_product_sync | orders_sync)
forecast_configs      → Config de reorder point por merchant
gdpr_requests         → Auditoría GDPR
sku_analytics         → Materialized view: fuente de verdad para todos los cálculos
processed_webhooks    → Idempotencia para ORDERS_PAID y document:add (source+external_id únicos)
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

### ✅ Módulo 2: Forecast & Replenishment — COMPLETADO
- [x] Importar `sales_history` desde Shopify Orders API (bulk operations, último año)
- [x] `shopify_line_item_id` en `sales_history` para idempotencia de importaciones
- [x] Velocidad de ventas por SKU (sold_30d / 30 días)
- [x] Reorder point automático = velocity × (lead_days + safety_stock_days)
- [x] Dead stock detector (sold_90d = 0 con stock > 0)
- [x] Vista `app.forecast.tsx` con tabla de SKUs por status (critical/low/ok/dead)
- [x] Polling de jobs sin auth via `/api/sync/status?jobId=` + `useRevalidator`
- [x] `supabase/seed.sql` con datos de prueba que cubren los 4 status

Pendiente del Módulo 2:
- [ ] `forecast_configs` editable por merchant (lead_days, safety_stock_days)
- [ ] PO generator (exportar PDF con SKUs a reponer)

### ✅ Módulo 3: Analytics — COMPLETADO
- [x] `analytics.server.ts`: `getShopKpis`, `getAbcAnalysis`, `getTopSkusByVelocity`
- [x] KPI dashboard: SKUs activos, unidades vendidas 30d, stock total, rotación, costo de ventas est., valor de inventario est.
- [x] ABC analysis: clasificación por sold_30d con cumulative sum (A=80%, B=15%, C=5%)
- [x] Velocity chart: top 20 SKUs por velocidad con barras inline CSS (sin dependencias de charts)
- [x] Tabla ABC con badge A/B/C (success/caution/neutral), % individual y % acumulado con mini-barra

Pendiente del Módulo 3:
- [ ] Margen por SKU (requiere campo `price` en skus — precio de venta de Shopify)
- [ ] Exportar reportes CSV

---

## ✅ V1.1: Arquitectura de Integraciones — EN PROGRESO

### Objetivo
Permitir que SkuBeam se conecte con ERPs y sistemas de ventas de LATAM (Bsale, Aspel, etc.) usando una **interfaz común** por integración. Cada integración vive en `app/integrations/<nombre>/` y expone los mismos métodos, lo que permite agregar integraciones nuevas sin modificar la lógica core.

### Estructura de directorios
```
app/integrations/
├── bsale/
│   ├── client.server.ts        # get(), paginate(), put(), resolveToken()
│   ├── products.server.ts      # syncBsaleToSkuBeam, getBsaleShopifyDiff
│   ├── stocks.server.ts        # syncBsaleStockToSkuBeam
│   ├── jobs.server.ts          # createBsaleJob, processBsale*Job
│   └── realtime.server.ts      # handleShopifyOrderPaid, handleBsaleDocumentAdd
└── (future: aspel/, siigo/, etc.)
```

### Interfaz común `IntegrationAdapter`
Todos los adaptadores deben implementar esta interfaz definida en `app/integrations/types.ts`:

```typescript
export interface IntegrationAdapter {
  /** Importar catálogo de productos desde el sistema externo → skus */
  syncProducts(shopId: string): Promise<{ synced: number; errors: number }>;

  /** Importar niveles de stock por location desde el sistema externo → inventory_levels */
  syncStock(shopId: string): Promise<{ synced: number; errors: number }>;

  /** Enviar una orden de compra generada en SkuBeam al sistema externo */
  pushPurchaseOrder(shopId: string, order: PurchaseOrder): Promise<{ externalId: string }>;

  /** Callback invocado cuando el stock cambia en el sistema externo.
   *  La integración debe llamar refreshSkuAnalytics() al final. */
  onStockChange(shopId: string, event: StockChangeEvent): Promise<void>;
}

export interface PurchaseOrder {
  items: Array<{ sku_code: string; quantity: number; unit_cost: number }>;
  supplier?: string;
  notes?: string;
}

export interface StockChangeEvent {
  shopify_variant_id?: number;
  sku_code?: string;
  location_id?: string;
  new_quantity: number;
  changed_at: string;
}
```

### ✅ Primera integración: Bsale API REST — SYNC MANUAL COMPLETADO
- **Auth**: API key por merchant (guardada en `shops.settings` JSONB)
- **syncProducts**: `GET /v1/variant.json` → upsert en `skus` ✅
- **syncStock**: `GET /v1/stock.json?officeId=X` → upsert en `inventory_levels` + refresh ✅
- **pushPurchaseOrder**: `POST /v1/purchaseOrder.json` ✅
- **onStockChange**: webhook entrante de Bsale → `POST /webhooks/bsale/stock` ✅

### 🔒 Contrato stock ↔ precios (Bsale → Shopify)

**Stock y precio son jobs disjuntos. Nunca mezclarlos.**

| Job | Escribe | Nunca toca |
|---|---|---|
| `bsale_stock` (`stocks.server.ts`) | `inventory_levels` + `inventoryAdjustQuantities` | precio, `sale_price`, `compareAtPrice` |
| `bsale_prices` (`products.server.ts`) | `skus.sale_price` + `productVariantsBulkUpdate` (solo `price`) | inventario en Shopify ni `inventory_levels` |
| webhook `document:add` (`realtime.server.ts`) | `inventoryAdjustQuantities` + `sales_history` | precio |

El único lugar donde un flujo Bsale escribe precio fuera del job de precios es la **creación** de un producto nuevo (`publish.server.ts`, `api.worker.tsx` → `handleBulkPublish`): ahí el precio de Bsale es el precio inicial y después nunca se re-sincroniza solo.

**Publicar desde Bsale = crear borrador.** Los productos creados desde el tab "Sin publicar" (`/app/skus?tab=unpublished`) se crean en Shopify con `status: DRAFT` y **no** se publican en el canal online. Bsale solo aporta SKU, nombre, precio, código de barras y stock — sin imágenes ni descripción, un producto activo aparecería en la tienda como ficha vacía. El merchant lo activa desde Shopify cuando lo completa. Fijado en `app/models/publish.server.test.ts`.

`app/integrations/bsale/sync-contract.test.ts` es un guard estático sobre el fuente que falla si alguien vuelve a mezclar ambas responsabilidades.

**Descuentos**: el sync de precios omite toda variante en oferta en Shopify (`compareAtPrice > price`) — escribir el precio de lista de Bsale encima cancelaría la promoción. Se reportan en `PriceSyncResult.discounted_skipped`. Los descuentos automáticos y códigos de descuento de Shopify no usan `variant.price`, así que esos SKUs se sincronizan normalmente.

**Vista previa obligatoria**: el botón "Revisar cambios de precio" crea un job `bsale_prices_preview` que calcula el diff completo sin escribir nada (ni Supabase ni Shopify). El job `bsale_prices` (aplicar) solo se dispara desde el botón de confirmación de esa tarjeta, y recalcula contra Bsale en ese momento.

### ✅ Sync bidireccional en tiempo real — COMPLETADO

#### Flujo 1 — Shopify → Bsale (descuento de stock por venta)
- **Trigger**: webhook `ORDERS_PAID` de Shopify
- **Acción**: por cada line item de la orden, llamar `PUT /v1/stocks/adjustments.json` en Bsale para descontar la cantidad vendida
- **Handler**: `app/integrations/bsale/webhooks.server.ts` → función `handleShopifyOrderPaid`
- **Ruta**: registrar `ORDERS_PAID` en `shopify.server.ts` → `/webhooks/orders/paid`

#### Flujo 2 — Bsale → Shopify (descuento de stock por documento de venta)
- **Trigger**: webhook de Bsale evento `document:add` (documento de venta creado en Bsale)
- **Acción**: por cada detalle del documento, llamar `inventoryAdjustQuantities` GraphQL mutation en Shopify Admin API para descontar el stock de la variante correspondiente
- **Handler**: `app/integrations/bsale/webhooks.server.ts` → función `handleBsaleDocumentAdd`
- **Ruta**: `POST /webhooks/bsale/document` — verificación por token secreto (no HMAC)
- **Registro del webhook**: Bsale no tiene registro automático — se debe registrar manualmente la URL de callback desde el **panel de Bsale** en Configuración → Webhooks, apuntando a `https://<app-domain>/webhooks/bsale/document`
- **Endpoint de webhooks Bsale**: `POST /v1/webhooks.json` (para gestión programática si se necesita en el futuro)

#### Reglas para el sync bidireccional
- Idempotencia obligatoria en ambos flujos — usar `shopify_order_id` + `line_item_id` y `bsale_document_id` + `detail_id` como claves de deduplicación
- Llamar `refreshSkuAnalytics()` al final de cualquier ajuste de stock en Supabase
- Los ajustes de Bsale → Shopify usan `inventoryAdjustQuantities` (delta), no `inventorySetQuantities` (absoluto)
- Loggear en `sync_jobs` cada operación de sync en tiempo real para auditoría

### Reglas para integraciones
- Credenciales siempre en `shops.settings` (JSONB), nunca hardcodeadas
- Llamar `refreshSkuAnalytics()` al final de `syncStock` y `onStockChange`
- Cada integración tiene su propio directorio — sin código de Bsale en el core
- Los webhooks de integraciones siguen el mismo patrón que los webhooks de Shopify (verificación HMAC o token)
- Agregar `integration_connections` table en migration para tracking de auth status por merchant

---

## Reglas de desarrollo

### SIEMPRE
1. `authenticate.admin(request)` al inicio de cada loader/action bajo `/app`
2. `authenticate.webhook(request)` en todos los handlers de webhook de Shopify
3. Filtrar por `shop_id` en CADA query a Supabase
4. `safeRedirect(request, path)` en lugar de `redirect(path)` para redirects entre rutas `/app`
5. Llamar `refreshSkuAnalytics()` después de cualquier write a `skus`, `inventory_levels` o `sales_history`
6. Archivos `.server.ts` para todo lo que corre en servidor
7. Webhooks idempotentes — procesar el mismo evento dos veces no rompe nada
8. TypeScript estricto — sin `any`
9. Todo cálculo de analytics/forecast/KPIs debe leer desde `sku_analytics`, no desde las tablas base

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
- ❌ Calcular métricas de analytics directamente desde `skus`, `inventory_levels` o `sales_history` — usar `sku_analytics`
- ❌ Hacer polling de jobs con `authenticate.admin()` en el fetcher — usar `/api/sync/status?jobId=`

---

## Comandos frecuentes

```bash
# Desarrollo
npm run dev                      # Shopify CLI + Remix dev server

# Supabase local
npx supabase start               # Levantar Supabase local
npx supabase db reset            # Limpiar DB y re-aplicar todas las migrations
npx supabase gen types typescript --local > app/types/supabase.ts

# Seed de datos de prueba (después de importar productos)
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/seed.sql

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
| `@integrations-agent` | Adaptadores de ERP/POS (Bsale, Aspel, Siigo) |
