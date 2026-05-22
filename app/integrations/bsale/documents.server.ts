import { post } from "./client.server";
import { supabaseAdmin } from "../../db.server";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ShopifyOrderLine {
  sku:      string;
  quantity: number;
  price:    string;
}

interface ShopifyCustomer {
  first_name?: string;
  last_name?:  string;
  email?:      string;
  phone?:      string;
}

interface ShopifyBillingAddress {
  first_name?: string;
  last_name?:  string;
  company?:    string;
  address1?:   string;
  city?:       string;
  phone?:      string;
}

export interface ShopifyOrderForBoleta {
  id:               number;
  email?:           string;
  created_at:       string;
  line_items:       ShopifyOrderLine[];
  total_price:      string;
  customer?:        ShopifyCustomer;
  billing_address?: ShopifyBillingAddress;
}

interface BsaleDocumentResponse {
  id:          number;
  number?:     number;
  urlPdf?:     string;
  totalAmount?: number;
}

// ── emitBoleta ────────────────────────────────────────────────────────────────

/**
 * Creates a document in Bsale for a Shopify order.
 * Supports two modes:
 *   - codeSii (e.g. 39=Boleta Electrónica, 33=Factura) → declared to SII
 *   - documentTypeId (internal Bsale ID) → used for Nota de Venta (non-SII draft)
 * Idempotent — safe to call multiple times for the same order.
 * Non-throwing — errors are recorded in bsale_documents and logged.
 */
export async function emitBoleta(
  shopId:          string,
  token:           string,
  officeId:        number,
  order:           ShopifyOrderForBoleta,
  documentTypeId:  number | null,
  codeSii?:        number | null,
): Promise<void> {
  if (!documentTypeId && !codeSii) {
    console.error(`[bsale-docs] Sin documentTypeId ni codeSii configurado para shop=${shopId} — configura el tipo de documento en la integración Bsale`);
    return;
  }

  const shopifyOrderId = String(order.id);
  console.log(`[bsale-docs] ── inicio orden=${shopifyOrderId} shop=${shopId} officeId=${officeId}`, { documentTypeId, codeSii });

  const { data: existing, error: checkErr } = await supabaseAdmin
    .from("bsale_documents")
    .select("id, status, url_pdf")
    .eq("shop_id", shopId)
    .eq("shopify_order_id", shopifyOrderId)
    .maybeSingle();

  if (checkErr) {
    console.error(`[bsale-docs] Error verificando idempotencia:`, checkErr.message);
  }

  if (existing?.status === "emitted") {
    console.log(`[bsale-docs] Boleta ya emitida para orden ${shopifyOrderId} — saltando`);
    return;
  }

  console.log(`[bsale-docs] Registro previo:`, existing ? `status=${existing.status}` : "ninguno");

  await supabaseAdmin
    .from("bsale_documents")
    .upsert(
      {
        shop_id:          shopId,
        shopify_order_id: shopifyOrderId,
        document_type:    "nota_venta",
        status:           "pending",
      },
      { onConflict: "shop_id,shopify_order_id" },
    );

  try {
    const details = order.line_items
      .filter((item) => item.sku)
      .map((item) => ({
        code:         item.sku,
        netUnitValue: Math.round(parseFloat(item.price) / 1.19),
        quantity:     item.quantity,
        // Use SII tax code 14 (IVA 19%) — portable across Bsale accounts
        taxes: [{ code: 14, percentage: 19 }],
      }));

    console.log(`[bsale-docs] Line items para Bsale:`, details.map((d) => ({
      code: d.code, qty: d.quantity, netUnitValue: d.netUnitValue,
    })));

    if (details.length === 0) {
      throw new Error("No hay items con SKU válido en la orden");
    }

    const emissionDate = Math.floor(new Date(order.created_at).getTime() / 1000);

    // Nota de Venta (non-SII draft): uses internal documentTypeId, no declareSii, no expirationDate
    // SII document (boleta 39, factura 33): uses codeSii, declareSii=1, expirationDate required
    const isSiiDocument = !!codeSii;

    // Build client object from Shopify order data
    const email     = order.email ?? order.customer?.email;
    const firstName = order.customer?.first_name ?? order.billing_address?.first_name;
    const lastName  = order.customer?.last_name  ?? order.billing_address?.last_name;
    const company   = order.billing_address?.company;
    const phone     = order.customer?.phone ?? order.billing_address?.phone;
    const address   = order.billing_address?.address1;
    const city      = order.billing_address?.city;

    const client: Record<string, unknown> = {
      companyOrPerson: company ? 1 : 0,
    };
    if (email)     client.email     = email;
    if (firstName) client.firstName = firstName;
    if (lastName)  client.lastName  = lastName;
    if (company)   client.company   = company;
    if (phone)     client.phone     = phone;
    if (address)   client.address   = address;
    if (city)      client.city      = city;

    console.log(`[bsale-docs] Cliente para Bsale:`, { email, firstName, lastName, company });

    const payload: Record<string, unknown> = {
      ...(isSiiDocument ? { codeSii } : { documentTypeId }),
      officeId,
      emissionDate,
      ...(isSiiDocument ? { expirationDate: emissionDate, declareSii: 1 } : {}),
      dispatch: 0,
      salesId:  `shopify_${shopifyOrderId}`,
      client,
      details,
    };

    console.log(`[bsale-docs] Payload enviado a Bsale POST /documents.json:`, JSON.stringify(payload));

    const response = await post<BsaleDocumentResponse>(
      "/documents.json",
      token,
      payload,
    );

    console.log(`[bsale-docs] Respuesta de Bsale:`, JSON.stringify(response));

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

    console.log(`[bsale-docs] ✓ Nota de Venta ${response.number ?? response.id} creada para orden ${shopifyOrderId} — pendiente aprobación en Bsale`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[bsale-docs] ✗ Error emitiendo Nota de Venta para orden ${shopifyOrderId}:`, message);

    await supabaseAdmin
      .from("bsale_documents")
      .update({ status: "error", error_message: message })
      .eq("shop_id", shopId)
      .eq("shopify_order_id", shopifyOrderId);

    // Re-throw so the worker marks the job as "error" instead of "completed"
    throw error;
  }
}
