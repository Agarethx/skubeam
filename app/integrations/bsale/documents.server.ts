import { post } from "./client.server";
import { supabaseAdmin } from "../../db.server";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ShopifyOrderLine {
  sku:      string;
  quantity: number;
  price:    string;
}

export interface ShopifyOrderForBoleta {
  id:          number;
  email?:      string;
  created_at:  string;
  line_items:  ShopifyOrderLine[];
  total_price: string;
}

interface BsaleDocumentResponse {
  id:          number;
  number?:     number;
  urlPdf?:     string;
  totalAmount?: number;
}

// ── emitBoleta ────────────────────────────────────────────────────────────────

/**
 * Emits an electronic boleta (codeSii=39) in Bsale for a Shopify order.
 * Idempotent — safe to call multiple times for the same order.
 * Non-throwing — errors are recorded in bsale_documents and logged.
 *
 * @param dispatch - Pass 0 (SkuBeam already handles stock via webhook sync)
 */
export async function emitBoleta(
  shopId:   string,
  token:    string,
  officeId: number,
  order:    ShopifyOrderForBoleta,
): Promise<void> {
  const shopifyOrderId = String(order.id);

  // Idempotency guard
  const { data: existing } = await supabaseAdmin
    .from("bsale_documents")
    .select("id, status, url_pdf")
    .eq("shop_id", shopId)
    .eq("shopify_order_id", shopifyOrderId)
    .maybeSingle();

  if (existing?.status === "emitted") {
    console.log(`[bsale-docs] Boleta ya existe para orden ${shopifyOrderId}`);
    return;
  }

  // Create or reset to pending
  await supabaseAdmin
    .from("bsale_documents")
    .upsert(
      {
        shop_id:          shopId,
        shopify_order_id: shopifyOrderId,
        document_type:    "boleta",
        status:           "pending",
      },
      { onConflict: "shop_id,shopify_order_id" },
    );

  try {
    // Build line items — Shopify prices include IVA; Bsale expects netUnitValue (ex-IVA)
    const details = order.line_items
      .filter((item) => item.sku)
      .map((item) => ({
        code:         item.sku,
        netUnitValue: Math.round(parseFloat(item.price) / 1.19),
        quantity:     item.quantity,
        taxId:        "[1]", // IVA estándar 19% Chile
      }));

    if (details.length === 0) {
      throw new Error("No hay items con SKU válido en la orden");
    }

    const emissionDate = Math.floor(new Date(order.created_at).getTime() / 1000);

    const payload: Record<string, unknown> = {
      codeSii:    39,   // Boleta Electrónica
      officeId,
      emissionDate,
      declareSii: 1,    // Declare to SII automatically
      dispatch:   0,    // Do NOT adjust stock — SkuBeam already handles it
      salesId:    `shopify_${shopifyOrderId}`, // Bsale-side deduplication key
      details,
    };

    if (order.email) {
      payload.sendEmail = 1;
    }

    const response = await post<BsaleDocumentResponse>(
      "/documents.json",
      token,
      payload,
    );

    await supabaseAdmin
      .from("bsale_documents")
      .update({
        bsale_document_id: response.id,
        status:            "emitted",
        url_pdf:           response.urlPdf ?? null,
        total_amount:      response.totalAmount ?? null,
        error_message:     null,
      })
      .eq("shop_id", shopId)
      .eq("shopify_order_id", shopifyOrderId);

    console.log(
      `[bsale-docs] Boleta ${response.number ?? response.id} emitida para orden ${shopifyOrderId}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[bsale-docs] Error emitiendo boleta para orden ${shopifyOrderId}:`, message);

    await supabaseAdmin
      .from("bsale_documents")
      .update({ status: "error", error_message: message })
      .eq("shop_id", shopId)
      .eq("shopify_order_id", shopifyOrderId);
  }
}
