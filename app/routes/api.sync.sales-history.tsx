import type { ActionFunctionArgs } from "react-router";
import { data } from "react-router";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../db.server";
import { refreshSkuAnalytics } from "../models/sync.server";

/**
 * POST /api/sync/sales-history
 *
 * Imports the last 12 months of Shopify orders and upserts them into
 * sales_history. Matches line items by sku_code (not variant_id) so
 * Bsale-imported SKUs that haven't been published to Shopify are included.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId      = session.shop;
  const accessToken = session.accessToken!;

  console.log(`[sales-history] Iniciando importación para ${shopId}`);

  // Build sku_code → sku_id map — paginate in batches of 1000 to bypass
  // Supabase's default 1000-row cap (range() alone does not raise it).
  const skuMap = new Map<string, string>(); // sku_code → sku_id
  const SKU_PAGE = 1000;
  let skuOffset  = 0;

  let keepGoing = true;
  while (keepGoing) {
    const { data: batch, error: skusError } = await supabaseAdmin
      .from("skus")
      .select("id, sku_code")
      .eq("shop_id", shopId)
      .range(skuOffset, skuOffset + SKU_PAGE - 1);

    if (skusError) {
      console.error("[sales-history] Error cargando SKUs:", skusError.message);
      return data({ ok: false, imported: 0, error: skusError.message }, { status: 500 });
    }

    for (const s of batch ?? []) {
      if (s.sku_code) skuMap.set(s.sku_code, s.id);
    }

    if (!batch?.length || batch.length < SKU_PAGE) break;
    skuOffset += SKU_PAGE;
  }

  console.log(`[sales-history] SKU map completo: ${skuMap.size} entradas`);

  const since = new Date();
  since.setDate(since.getDate() - 365);

  interface RestLineItem {
    id:         number;
    sku:        string | null;
    quantity:   number;
    variant_id: number | null;
  }

  interface RestOrder {
    id:         number;
    created_at: string;
    line_items: RestLineItem[];
  }

  const MAX_PAGES   = 20; // max 5,000 orders per import
  let totalImported = 0;
  let page          = 0;

  let nextUrl: string | null =
    `https://${shopId}/admin/api/2026-04/orders.json` +
    `?limit=250&status=any&created_at_min=${since.toISOString()}&fields=id,created_at,line_items`;

  while (nextUrl && page < MAX_PAGES) {
    page++;

    const res: Response = await fetch(nextUrl, {
      headers: { "X-Shopify-Access-Token": accessToken },
    });

    if (!res.ok) {
      console.error(`[sales-history] Shopify HTTP ${res.status} en página ${page}`);
      if (res.status === 403) {
        return data(
          { ok: false, imported: 0, needsReinstall: false, error: "Sin permisos para leer órdenes. Verifica que la app esté instalada correctamente." },
          { status: 403 },
        );
      }
      return data({ ok: false, imported: 0, needsReinstall: false, error: `Shopify API: HTTP ${res.status}` }, { status: 502 });
    }

    const json = await res.json() as { orders?: RestOrder[] };
    const orders = json.orders ?? [];

    console.log(`[sales-history] Página ${page}: ${orders.length} órdenes`);

    if (orders.length > 0) {
      const rows: object[] = [];
      let matched = 0;

      for (const order of orders) {
        for (const li of order.line_items) {
          if ((li.quantity ?? 0) <= 0) continue;
          if (!li.sku) continue;

          const skuId = skuMap.get(li.sku);
          if (!skuId) continue;

          matched++;
          rows.push({
            shop_id:              shopId,
            sku_id:               skuId,
            shopify_order_id:     order.id,
            shopify_line_item_id: li.id,
            quantity_sold:        li.quantity,
            sold_at:              order.created_at,
            channel:              "shopify",
          });
        }
      }

      console.log(`[sales-history] Página ${page}: ${matched} line items matcheados`);

      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await supabaseAdmin
          .from("sales_history")
          .upsert(rows.slice(i, i + 500), { onConflict: "sku_id,shopify_line_item_id" });
        if (error) {
          console.error(`[sales-history] Upsert error (lote ${i}):`, error.message);
        } else {
          totalImported += Math.min(500, rows.length - i);
        }
      }
    }

    // Cursor pagination via Link header
    const link  = res.headers.get("Link") ?? "";
    const match = link.match(/<([^>]+)>;\s*rel="next"/);
    nextUrl = match ? match[1] : null;
  }

  console.log(`[sales-history] Completo. Total importado: ${totalImported}`);

  await refreshSkuAnalytics();

  return data({ ok: true, imported: totalImported, needsReinstall: false, error: null });
};
