# Agent: shopify-sync-agent

## Rol
Especialista en sincronización entre Shopify Admin API y Supabase para SkuBeam. Maneja bulk operations, rate limiting, webhooks y consistencia de datos.

## Cuándo invocarme
- Implementar sync de productos/variantes/inventario
- Bulk sync para catálogos 500-10k SKUs
- Rate limiting y retry logic con la Admin API
- Implementar o modificar webhook handlers
- Sync inicial al instalar la app

---

## Archivos relevantes en skubeam

```
app/routes/webhooks.app.uninstalled.tsx   # Ya existe — revisar que limpie Supabase
app/routes/webhooks.app.scopes_update.tsx # Ya existe
app/routes/webhooks.gdpr.tsx              # CREAR — obligatorio
app/routes/api.sync.tsx                   # CREAR — sync manual desde UI
app/models/sku.server.ts                  # CREAR — lógica de upsert
app/shopify.server.ts                     # Registrar webhooks aquí
```

---

## Sync inicial al instalar (onboarding)

Para catálogos mid-market (500-10k SKUs) usar Bulk Operations de GraphQL.

```typescript
// app/models/sku.server.ts

const BULK_PRODUCTS_QUERY = `
  mutation {
    bulkOperationRunQuery(
      query: """
        {
          products {
            edges {
              node {
                id
                title
                vendor
                productType
                variants {
                  edges {
                    node {
                      id
                      sku
                      barcode
                      price
                      inventoryQuantity
                      inventoryItem {
                        id
                        tracked
                        unitCost { amount }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      """
    ) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }
`;

export async function startInitialSync(admin: any, shopId: string) {
  const { data } = await admin.graphql(BULK_PRODUCTS_QUERY);
  
  if (data.bulkOperationRunQuery.userErrors.length > 0) {
    throw new Error(data.bulkOperationRunQuery.userErrors[0].message);
  }
  
  const opId = data.bulkOperationRunQuery.bulkOperation.id;
  
  // Registrar job en Supabase
  await supabaseAdmin.from("sync_jobs").insert({
    shop_id: shopId,
    operation_id: opId,
    type: "full_product_sync",
    status: "running",
  });
  
  return opId;
}

// Llamar desde Edge Function con polling cada 30s
export async function processBulkResult(jsonlUrl: string, shopId: string) {
  const response = await fetch(jsonlUrl);
  const text = await response.text();
  const lines = text.trim().split("\n").filter(Boolean);
  
  const variants: any[] = [];
  const productMap = new Map<string, any>();
  
  for (const line of lines) {
    const node = JSON.parse(line);
    if (!node.__parentId) {
      // Es un producto
      productMap.set(node.id, node);
    } else {
      // Es una variante
      const product = productMap.get(node.__parentId);
      if (node.sku) { // Solo SKUs con código definido
        variants.push({
          shop_id: shopId,
          shopify_variant_id: parseInt(node.id.split("/").pop()),
          shopify_product_id: parseInt(node.__parentId.split("/").pop()),
          sku_code: node.sku,
          barcode: node.barcode || null,
          title: product ? `${product.title} - ${node.title}` : node.sku,
          vendor: product?.vendor || null,
          status: "active",
        });
      }
    }
  }
  
  // Upsert en batches de 500
  for (let i = 0; i < variants.length; i += 500) {
    const batch = variants.slice(i, i + 500);
    const { error } = await supabaseAdmin
      .from("skus")
      .upsert(batch, { onConflict: "shopify_variant_id" });
    
    if (error) console.error("Batch upsert error:", error);
  }
  
  // Marcar job como completado
  await supabaseAdmin
    .from("sync_jobs")
    .update({ status: "completed", records_processed: variants.length, completed_at: new Date().toISOString() })
    .eq("shop_id", shopId)
    .eq("type", "full_product_sync");
}
```

---

## Webhook handlers

### webhooks.app.uninstalled.tsx — actualizar para Supabase

```typescript
// app/routes/webhooks.app.uninstalled.tsx
import { authenticate } from "~/shopify.server";
import { supabaseAdmin } from "~/db.server";

export async function action({ request }: ActionFunctionArgs) {
  const { shop, session, topic } = await authenticate.webhook(request);
  console.log(`Webhook recibido: ${topic} para ${shop}`);

  // Marcar shop como inactivo (los datos se borran en SHOP_REDACT 48h después)
  await supabaseAdmin
    .from("shops")
    .update({
      is_active: false,
      uninstalled_at: new Date().toISOString(),
    })
    .eq("shop_id", shop);

  return new Response(null, { status: 200 });
}
```

### webhooks.gdpr.tsx — CREAR (obligatorio para App Store)

```typescript
// app/routes/webhooks.gdpr.tsx
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import { supabaseAdmin } from "~/db.server";

export async function action({ request }: ActionFunctionArgs) {
  const { topic, shop, payload } = await authenticate.webhook(request);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
      // Shopify pide datos de un customer — loguear y notificar al merchant
      await supabaseAdmin.from("gdpr_requests").insert({
        shop_id: shop,
        type: "data_request",
        customer_id: payload.customer?.id,
      });
      break;

    case "CUSTOMERS_REDACT":
      // Anonimizar referencias a órdenes del customer
      if (payload.orders_to_redact?.length > 0) {
        await supabaseAdmin
          .from("sales_history")
          .update({ shopify_order_id: null })
          .eq("shop_id", shop)
          .in("shopify_order_id", payload.orders_to_redact);
      }
      await supabaseAdmin.from("gdpr_requests").insert({
        shop_id: shop,
        type: "customer_redact",
        customer_id: payload.customer?.id,
      });
      break;

    case "SHOP_REDACT":
      // Borrar TODOS los datos del shop (48h después del uninstall)
      await supabaseAdmin.from("shops").delete().eq("shop_id", shop);
      // El ON DELETE CASCADE borra el resto de tablas
      break;
  }

  return new Response(null, { status: 200 });
}
```

---

## Rate limiting GraphQL

```typescript
// app/lib/shopify-graphql.server.ts

export async function graphqlWithRateLimit(
  admin: any,
  query: string,
  variables?: Record<string, any>
) {
  const MAX_RETRIES = 3;
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    try {
      const response = await admin.graphql(query, { variables });
      const data = await response.json();

      // Verificar throttling
      const throttle = data.extensions?.cost?.throttleStatus;
      if (throttle && throttle.currentlyAvailable < 100) {
        const waitMs = ((100 - throttle.currentlyAvailable) / throttle.restoreRate) * 1000;
        await sleep(waitMs);
      }

      return data;
    } catch (error: any) {
      if (error?.response?.status === 429) {
        // Rate limited — esperar y reintentar
        await sleep(Math.pow(2, attempt) * 1000);
        attempt++;
      } else {
        throw error;
      }
    }
  }

  throw new Error("Max retries exceeded");
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

---

## Registrar webhooks en shopify.server.ts

```typescript
// En shopify.server.ts — agregar webhooks al config:
webhooks: {
  APP_UNINSTALLED: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/webhooks/app/uninstalled",
  },
  PRODUCTS_UPDATE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/webhooks/products/update",
  },
  INVENTORY_LEVELS_UPDATE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/webhooks/inventory_levels/update",
  },
  CUSTOMERS_DATA_REQUEST: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/webhooks/gdpr",
  },
  CUSTOMERS_REDACT: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/webhooks/gdpr",
  },
  SHOP_REDACT: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/webhooks/gdpr",
  },
},
```
