# Agent: forecast-agent

## Rol
Especialista en forecasting de inventario para SkuBeam. Implementa algoritmos de velocidad de ventas, reorder points, dead stock detection y ABC analysis.

## Cuándo invocarme
- Implementar el Módulo 2 (Forecast & Replenishment)
- Calcular reorder points y safety stock
- Detectar dead stock y slow movers
- Implementar ABC analysis
- Diseñar la Edge Function de forecasting batch

---

## Archivo principal

```
app/models/forecast.server.ts   # Toda la lógica de forecasting
```

---

## Implementación completa

```typescript
// app/models/forecast.server.ts
import { supabaseAdmin } from "~/db.server";

export interface ForecastConfig {
  reorderLeadDays: number;    // días de lead time del proveedor
  safetyStockDays: number;    // días de stock de seguridad
  forecastWindowDays: number; // ventana de forecast
  deadStockDays: number;      // días sin venta = dead stock
}

export interface SkuForecast {
  skuId: string;
  skuCode: string;
  title: string;
  currentStock: number;
  dailyVelocity: number;
  reorderPoint: number;
  reorderQuantity: number;
  daysOfStockLeft: number;
  forecastedDemand30d: number;
  status: "ok" | "low" | "critical" | "dead_stock" | "overstock" | "no_data";
}

// Forecasting para un shop completo — usar en Edge Function batch
export async function getForecastForShop(
  shopId: string,
  config: ForecastConfig
): Promise<SkuForecast[]> {
  // Usar la vista materializada sku_analytics para performance
  const { data: analytics, error } = await supabaseAdmin
    .from("sku_analytics")
    .select("*")
    .eq("shop_id", shopId)
    .eq("status", "active");

  if (error) throw new Error(`Forecast query error: ${error.message}`);

  return (analytics ?? []).map((sku) =>
    computeForecast(sku, config)
  );
}

function computeForecast(sku: any, config: ForecastConfig): SkuForecast {
  const dailyVelocity = sku.sold_30d / 30;
  const currentStock = sku.total_stock ?? 0;

  // Reorder point = (velocidad × lead time) + safety stock
  const safetyStock = dailyVelocity * config.safetyStockDays;
  const reorderPoint = Math.ceil(dailyVelocity * config.reorderLeadDays + safetyStock);
  const reorderQuantity = Math.ceil(dailyVelocity * config.forecastWindowDays);
  const daysOfStockLeft = dailyVelocity > 0
    ? Math.floor(currentStock / dailyVelocity)
    : 999;

  // Determinar status
  let status: SkuForecast["status"];
  if (sku.sold_90d === 0 && currentStock > 0) {
    status = "dead_stock";
  } else if (sku.sold_30d === 0) {
    status = "no_data";
  } else if (daysOfStockLeft <= config.reorderLeadDays) {
    status = "critical";
  } else if (currentStock <= reorderPoint) {
    status = "low";
  } else if (currentStock > reorderQuantity * 4) {
    status = "overstock";
  } else {
    status = "ok";
  }

  return {
    skuId: sku.id,
    skuCode: sku.sku_code,
    title: sku.title,
    currentStock,
    dailyVelocity: Math.round(dailyVelocity * 100) / 100,
    reorderPoint,
    reorderQuantity,
    daysOfStockLeft,
    forecastedDemand30d: Math.ceil(dailyVelocity * 30),
    status,
  };
}

// ABC Analysis — clasificación por valor de ventas
export interface AbcAnalysis {
  A: string[]; // Top 20% SKUs = 80% ventas
  B: string[]; // 30% SKUs = 15% ventas
  C: string[]; // 50% SKUs = 5% ventas
}

export async function runAbcAnalysis(shopId: string): Promise<AbcAnalysis> {
  const { data, error } = await supabaseAdmin
    .from("sales_history")
    .select("sku_id, quantity_sold")
    .eq("shop_id", shopId)
    .gte("sold_at", new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString());

  if (error) throw new Error(`ABC analysis error: ${error.message}`);

  // Agrupar por SKU
  const revenueBysku = new Map<string, number>();
  for (const sale of data ?? []) {
    const current = revenueBysku.get(sale.sku_id) ?? 0;
    revenueBysku.set(sale.sku_id, current + sale.quantity_sold);
  }

  // Ordenar de mayor a menor
  const sorted = [...revenueBysku.entries()]
    .sort((a, b) => b[1] - a[1]);

  const total = sorted.reduce((sum, [, qty]) => sum + qty, 0);
  let cumulative = 0;
  const result: AbcAnalysis = { A: [], B: [], C: [] };

  for (const [skuId, qty] of sorted) {
    cumulative += qty;
    const pct = cumulative / total;

    if (pct <= 0.80) result.A.push(skuId);
    else if (pct <= 0.95) result.B.push(skuId);
    else result.C.push(skuId);
  }

  return result;
}

// Dead stock con recomendaciones
export async function getDeadStockSkus(shopId: string, thresholdDays = 90) {
  const { data, error } = await supabaseAdmin
    .from("sku_analytics")
    .select("*")
    .eq("shop_id", shopId)
    .eq("sold_90d", 0)
    .gt("total_stock", 0)
    .order("total_stock", { ascending: false });

  if (error) throw new Error(`Dead stock query: ${error.message}`);

  return (data ?? []).map((sku) => ({
    skuId: sku.id,
    skuCode: sku.sku_code,
    title: sku.title,
    currentStock: sku.total_stock,
    lastSoldAt: sku.last_sold_at,
    estimatedValue: sku.total_stock * (sku.cost_price ?? 0),
    recommendation: getRecommendation(sku),
  }));
}

function getRecommendation(sku: any): string {
  if (!sku.last_sold_at) return "write_off";
  const daysSince = Math.floor(
    (Date.now() - new Date(sku.last_sold_at).getTime()) / (1000 * 60 * 60 * 24)
  );
  if (daysSince > 180) return "write_off";
  if (sku.total_stock > 100) return "return_to_supplier";
  if (sku.total_stock > 20) return "bundle";
  return "discount";
}
```

---

## Edge Function: daily forecast batch

```typescript
// supabase/functions/daily-forecast/index.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req) => {
  // Verificar cron secret
  const authHeader = req.headers.get("Authorization");
  if (authHeader !== `Bearer ${Deno.env.get("CRON_SECRET")}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // 1. Refrescar vista materializada
  await supabase.rpc("refresh_sku_analytics");

  // 2. Obtener shops activos
  const { data: shops } = await supabase
    .from("shops")
    .select("shop_id")
    .eq("is_active", true);

  // 3. Para cada shop, detectar SKUs críticos y notificar
  for (const shop of shops ?? []) {
    const { data: criticalSkus } = await supabase
      .from("sku_analytics")
      .select("sku_code, title, total_stock")
      .eq("shop_id", shop.shop_id)
      .lt("total_stock", 10)
      .gt("sold_30d", 0);

    if (criticalSkus && criticalSkus.length > 0) {
      // TODO: enviar email/notificación Shopify al merchant
      console.log(`${shop.shop_id}: ${criticalSkus.length} SKUs críticos`);
    }
  }

  return new Response(JSON.stringify({ ok: true, processedShops: shops?.length }));
});
```

---

## Ruta del módulo Forecast en Remix

```tsx
// app/routes/app.forecast.tsx
import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Page, Layout, Card, DataTable, Badge } from "@shopify/polaris";
import { authenticate } from "~/shopify.server";
import { getForecastForShop } from "~/models/forecast.server";
import { supabaseAdmin } from "~/db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  // Obtener config del merchant
  const { data: config } = await supabaseAdmin
    .from("forecast_configs")
    .select("*")
    .eq("shop_id", shopId)
    .single();

  const forecasts = await getForecastForShop(shopId, {
    reorderLeadDays: config?.reorder_lead_days ?? 14,
    safetyStockDays: config?.safety_stock_days ?? 7,
    forecastWindowDays: config?.forecast_window_days ?? 30,
    deadStockDays: config?.dead_stock_days ?? 90,
  });

  // Ordenar: críticos primero
  const statusOrder = { critical: 0, low: 1, dead_stock: 2, overstock: 3, ok: 4, no_data: 5 };
  forecasts.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

  return json({ forecasts });
}

const STATUS_BADGE: Record<string, { status: any; label: string }> = {
  critical: { status: "critical", label: "Crítico" },
  low: { status: "warning", label: "Stock bajo" },
  dead_stock: { status: "info", label: "Sin rotación" },
  overstock: { status: "attention", label: "Sobrestock" },
  ok: { status: "success", label: "OK" },
  no_data: { status: "new", label: "Sin datos" },
};

export default function ForecastPage() {
  const { forecasts } = useLoaderData<typeof loader>();

  return (
    <Page title="Forecast & Reabastecimiento">
      <Layout>
        <Layout.Section>
          <Card>
            <DataTable
              columnContentTypes={["text", "text", "numeric", "numeric", "numeric", "text"]}
              headings={["SKU", "Título", "Stock", "Reorder Point", "Días restantes", "Estado"]}
              rows={forecasts.map((f) => [
                f.skuCode,
                f.title ?? "—",
                f.currentStock,
                f.reorderPoint,
                f.daysOfStockLeft === 999 ? "∞" : f.daysOfStockLeft,
                <Badge status={STATUS_BADGE[f.status].status}>
                  {STATUS_BADGE[f.status].label}
                </Badge>,
              ])}
            />
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
```
