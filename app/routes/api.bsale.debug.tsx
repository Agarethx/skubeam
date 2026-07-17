import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { data } from "react-router";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../db.server";
import { emitBoleta, type ShopifyOrderForBoleta } from "../integrations/bsale/documents.server";
import { resolveToken } from "../integrations/bsale/client.server";

/**
 * GET  /api/bsale/debug                              → diagnóstico: webhooks Shopify + config shop
 * POST /api/bsale/debug?test=boleta&orderId=XXX      → emite boleta manual para una orden real
 */

// ── helpers ───────────────────────────────────────────────────────────────────

async function shopifyRestGet(shopId: string, path: string, query = "") {
  const { data: session } = await supabaseAdmin
    .from("shopify_sessions")
    .select("access_token")
    .eq("id", `offline_${shopId}`)
    .single();

  if (!session?.access_token) throw new Error("No offline session found");

  const res = await fetch(
    `https://${shopId}/admin/api/2025-10/${path}${query ? `?${query}` : ""}`,
    { headers: { "X-Shopify-Access-Token": session.access_token as string } },
  );

  if (!res.ok) throw new Error(`Shopify REST ${path}: HTTP ${res.status}`);
  return res.json();
}

// ── GET: diagnóstico ──────────────────────────────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  console.log("[bsale-debug] GET diagnóstico — shop:", shopId);

  // 1. Webhooks registrados en Shopify
  let shopifyWebhooks: unknown[] = [];
  try {
    const body = await shopifyRestGet(shopId, "webhooks.json", "limit=50") as { webhooks?: unknown[] };
    shopifyWebhooks = body.webhooks ?? [];
    console.log("[bsale-debug] Webhooks Shopify:", JSON.stringify(shopifyWebhooks, null, 2));
  } catch (err) {
    console.error("[bsale-debug] Error leyendo webhooks Shopify:", err);
  }

  // 1b. Tipos de documento disponibles en Bsale (para encontrar Nota de Venta)
  let bsaleDocTypes: unknown[] = [];
  try {
    const { data: shopRow2 } = await supabaseAdmin
      .from("shops").select("bsale_token").eq("shop_id", shopId).maybeSingle();
    if (shopRow2?.bsale_token) {
      const body = await (async () => {
        await supabaseAdmin
          .from("shopify_sessions").select("access_token").eq("id", `offline_${shopId}`).single();
        const token = shopRow2.bsale_token!;
        const res = await fetch("https://api.bsale.io/v1/document_types.json?state=0&limit=50", {
          headers: { access_token: token },
        });
        return res.ok ? res.json() : null;
      })();
      bsaleDocTypes = (body as { items?: unknown[] } | null)?.items ?? [];
      console.log("[bsale-debug] Tipos de documento Bsale:", JSON.stringify(bsaleDocTypes, null, 2));
    }
  } catch (err) {
    console.error("[bsale-debug] Error leyendo document_types:", err);
  }

  // 2. Config del shop en Supabase
  const { data: shopRow } = await supabaseAdmin
    .from("shops")
    .select("bsale_token, active_addons, bsale_office_id, bsale_price_list_id")
    .eq("shop_id", shopId)
    .maybeSingle();

  console.log("[bsale-debug] Shop config:", {
    hasToken:     !!shopRow?.bsale_token,
    activeAddons: shopRow?.active_addons,
    officeId:     shopRow?.bsale_office_id,
    priceListId:  shopRow?.bsale_price_list_id,
  });

  // 3. Últimos jobs de órdenes/boletas
  const { data: recentJobs } = await supabaseAdmin
    .from("sync_jobs")
    .select("id, type, status, error_message, created_at, completed_at")
    .eq("shop_id", shopId)
    .in("type", ["shopify_order", "emit_boleta", "bsale_document"])
    .order("created_at", { ascending: false })
    .limit(10);

  console.log("[bsale-debug] Últimos jobs:", recentJobs);

  // 4. Últimas boletas
  const { data: boletas } = await supabaseAdmin
    .from("bsale_documents")
    .select("shopify_order_id, bsale_document_id, status, error_message, created_at")
    .eq("shop_id", shopId)
    .order("created_at", { ascending: false })
    .limit(5);

  return data({
    shop:            shopId,
    shopConfig: {
      hasToken:     !!shopRow?.bsale_token,
      activeAddons: shopRow?.active_addons ?? [],
      officeId:     shopRow?.bsale_office_id ?? null,
      priceListId:  shopRow?.bsale_price_list_id ?? null,
    },
    shopifyWebhooks,
    bsaleDocTypes,
    recentJobs:      recentJobs ?? [],
    recentBoletas:   boletas ?? [],
    env: {
      appUrl:          process.env.APP_URL ?? "(no seteado)",
      shopifyAppUrl:   process.env.SHOPIFY_APP_URL ?? "(no seteado)",
      workerSecretSet: !!process.env.WORKER_SECRET,
    },
  });
}

// ── POST: test manual de boleta ───────────────────────────────────────────────

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  const url     = new URL(request.url);
  const test    = url.searchParams.get("test");
  const orderId = url.searchParams.get("orderId");

  console.log("[bsale-debug] POST — test:", test, "orderId:", orderId, "shop:", shopId);

  if (test !== "boleta") {
    return data({ error: "Usa ?test=boleta&orderId=SHOPIFY_ORDER_ID" }, { status: 400 });
  }
  if (!orderId) {
    return data({ error: "Falta ?orderId=SHOPIFY_ORDER_ID" }, { status: 400 });
  }

  // Fetch orden real desde Shopify REST
  console.log("[bsale-debug] Fetching orden Shopify:", orderId);

  interface RawLineItem {
    id: number;
    sku: string | null;
    quantity: number;
    price: string;
    discount_allocations?: Array<{ amount: string }>;
  }
  interface RawOrder {
    id: number;
    email?: string;
    contact_email?: string;
    created_at: string;
    line_items: RawLineItem[];
    shipping_lines?: ShopifyOrderForBoleta["shipping_lines"];
    total_price: string;
    customer?: ShopifyOrderForBoleta["customer"];
    billing_address?: ShopifyOrderForBoleta["billing_address"];
    shipping_address?: ShopifyOrderForBoleta["shipping_address"];
  }

  let rawOrder: RawOrder;
  try {
    const body = await shopifyRestGet(
      shopId,
      `orders/${orderId}.json`,
      "fields=id,email,contact_email,created_at,line_items,shipping_lines,total_price,customer,billing_address,shipping_address",
    ) as { order?: RawOrder };

    if (!body.order) throw new Error("Orden no encontrada");
    rawOrder = body.order;

    console.log("[bsale-debug] Orden recibida:", {
      id:         rawOrder.id,
      email:      rawOrder.email,
      lineItems:  rawOrder.line_items?.length,
      totalPrice: rawOrder.total_price,
      skus:       rawOrder.line_items?.map((li) => li.sku),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[bsale-debug] Error fetching orden:", msg);
    return data({ error: `No se pudo obtener la orden ${orderId}: ${msg}` }, { status: 400 });
  }

  // Adaptar al tipo ShopifyOrderForBoleta (sku required string)
  const order: ShopifyOrderForBoleta = {
    id:               rawOrder.id,
    email:            rawOrder.email,
    contact_email:    rawOrder.contact_email,
    created_at:       rawOrder.created_at,
    total_price:      rawOrder.total_price,
    shipping_lines:   rawOrder.shipping_lines,
    customer:         rawOrder.customer,
    billing_address:  rawOrder.billing_address,
    shipping_address: rawOrder.shipping_address,
    line_items:       rawOrder.line_items
      .filter((li) => li.sku)
      .map((li) => ({
        sku:                  li.sku!,
        quantity:             li.quantity,
        price:                li.price,
        discount_allocations: li.discount_allocations,
      })),
  };

  console.log("[bsale-debug] Order adaptada para emitBoleta:", {
    id:        order.id,
    lineItems: order.line_items,
  });

  // Resolver token, officeId y documentTypeId
  const { data: shopRow } = await supabaseAdmin
    .from("shops")
    .select("bsale_token, bsale_office_id, bsale_document_type_id")
    .eq("shop_id", shopId)
    .maybeSingle();

  if (!shopRow?.bsale_token) {
    return data({ error: "Shop sin token Bsale — configúralo en Integraciones → Bsale" }, { status: 400 });
  }

  const token          = resolveToken(shopRow.bsale_token);
  const officeId       = shopRow.bsale_office_id ?? 1;
  const documentTypeId = shopRow.bsale_document_type_id ?? 72;

  console.log("[bsale-debug] Llamando emitBoleta (Nota de Venta) — officeId:", officeId, "documentTypeId:", documentTypeId);

  try {
    await emitBoleta(shopId, token, officeId, order, documentTypeId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[bsale-debug] emitBoleta lanzó error:", msg);
    return data({ ok: false, error: msg }, { status: 500 });
  }

  // Leer resultado desde DB
  const { data: doc } = await supabaseAdmin
    .from("bsale_documents")
    .select("bsale_document_id, status, url_pdf, error_message, total_amount")
    .eq("shop_id", shopId)
    .eq("shopify_order_id", String(order.id))
    .maybeSingle();

  console.log("[bsale-debug] Resultado final boleta:", doc);
  return data({ ok: true, orderId: order.id, result: doc });
}
