import { get, post } from "./client.server";
import { supabaseAdmin } from "../../db.server";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ShopifyDiscountAllocation {
  amount: string;
}

export interface ShopifyOrderLine {
  sku:      string;
  quantity: number;
  price:    string;
  discount_allocations?: ShopifyDiscountAllocation[];
}

export interface ShopifyShippingLine {
  title?: string;
  price:  string;
  discount_allocations?: ShopifyDiscountAllocation[];
}

export interface ShopifyCustomer {
  first_name?: string;
  last_name?:  string;
  email?:      string;
  phone?:      string;
}

export interface ShopifyOrderAddress {
  first_name?: string;
  last_name?:  string;
  company?:    string;
  address1?:   string;
  city?:       string;
  phone?:      string;
}

export interface ShopifyOrderForBoleta {
  id:                number;
  email?:            string;
  contact_email?:    string;
  created_at:        string;
  line_items:        ShopifyOrderLine[];
  shipping_lines?:   ShopifyShippingLine[];
  total_price:       string;
  customer?:         ShopifyCustomer;
  billing_address?:  ShopifyOrderAddress;
  shipping_address?: ShopifyOrderAddress;
}

interface BsaleDocumentResponse {
  id:          number;
  number?:     number;
  urlPdf?:     string;
  totalAmount?: number;
}

// ── Payload builders (pure — unit tested) ─────────────────────────────────────

const IVA = 1.19;
// Use SII tax code 14 (IVA 19%) — portable across Bsale accounts
const IVA_TAXES = [{ code: 14, percentage: 19 }];

// netUnitValue admits decimals in Bsale — keep 4 decimals so the document
// total matches what the customer actually paid after discounts
const toNetUnit = (grossUnit: number) =>
  Math.round((grossUnit / IVA) * 10000) / 10000;

export interface BsaleDetail {
  code?:        string;
  comment?:     string;
  netUnitValue: number;
  quantity:     number;
  taxes:        typeof IVA_TAXES;
}

// discount_allocations carries both line-level and order-level discount
// codes — subtract them so Bsale gets the price the customer paid
const sumDiscounts = (allocations?: ShopifyDiscountAllocation[]) =>
  (allocations ?? []).reduce((sum, d) => sum + parseFloat(d.amount || "0"), 0);

export function buildBoletaDetails(order: ShopifyOrderForBoleta): BsaleDetail[] {
  const details: BsaleDetail[] = order.line_items
    .filter((item) => item.sku)
    .map((item) => {
      const gross    = parseFloat(item.price) * item.quantity;
      const discount = sumDiscounts(item.discount_allocations);
      const net      = Math.max(gross - discount, 0);
      return {
        code:         item.sku,
        netUnitValue: toNetUnit(net / item.quantity),
        quantity:     item.quantity,
        taxes:        IVA_TAXES,
      };
    });

  if (details.length === 0) {
    throw new Error("No hay items con SKU válido en la orden");
  }

  // Shipping (e.g. Bluexpress) goes as a detail without variant code —
  // Bsale accepts free-form items via `comment`
  const shippingTotal = (order.shipping_lines ?? []).reduce((sum, line) => {
    const price = parseFloat(line.price || "0") - sumDiscounts(line.discount_allocations);
    return sum + Math.max(price, 0);
  }, 0);

  if (shippingTotal > 0) {
    details.push({
      comment:      order.shipping_lines?.[0]?.title || "Despacho",
      netUnitValue: toNetUnit(shippingTotal),
      quantity:     1,
      taxes:        IVA_TAXES,
    });
  }

  return details;
}

export function buildBoletaClient(order: ShopifyOrderForBoleta): Record<string, unknown> {
  // Prefer shipping_address + contact_email: that's what the buyer typed in
  // the checkout form. With wallet gateways (Mercado Pago) Shopify fills
  // billing_address/customer with data returned by the gateway account.
  const shipping  = order.shipping_address;
  const billing   = order.billing_address;
  const email     = order.contact_email ?? order.email ?? order.customer?.email;
  const firstName = shipping?.first_name ?? order.customer?.first_name ?? billing?.first_name;
  const lastName  = shipping?.last_name  ?? order.customer?.last_name  ?? billing?.last_name;
  const company   = shipping?.company ?? billing?.company;
  const phone     = shipping?.phone ?? order.customer?.phone ?? billing?.phone;
  const address   = shipping?.address1 ?? billing?.address1;
  const city      = shipping?.city ?? billing?.city;

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

  return client;
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
    const details = buildBoletaDetails(order);

    console.log(`[bsale-docs] Detalles para Bsale:`, details.map((d) => ({
      code: d.code, comment: d.comment, qty: d.quantity, netUnitValue: d.netUnitValue,
    })));

    const emissionDate = Math.floor(new Date(order.created_at).getTime() / 1000);

    // Nota de Venta (non-SII draft): uses internal documentTypeId, no declareSii, no expirationDate
    // SII document (boleta 39, factura 33): uses codeSii, declareSii=1, expirationDate required
    const isSiiDocument = !!codeSii;

    const client = buildBoletaClient(order);

    console.log(`[bsale-docs] Cliente para Bsale:`, {
      email: client.email, firstName: client.firstName, lastName: client.lastName, company: client.company,
    });

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
        // `number` es el correlativo impreso en el PDF ("Nº 7718"), que es por el que
        // el merchant busca. `id` es el identificador interno de la API de Bsale.
        bsale_document_number: response.number ?? null,
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

// ── Listado paginado de documentos emitidos (UI de integración) ──────────────

export const BSALE_DOCS_PAGE_SIZE = 20;

export interface BsaleDocumentRow {
  shopify_order_id:      string;
  bsale_document_id:     number | null;
  /** Correlativo impreso en el PDF ("Nº 7718") — lo que el merchant reconoce. */
  bsale_document_number: number | null;
  status:                string | null;
  url_pdf:               string | null;
  total_amount:          number | null;
  error_message:         string | null;
  created_at:            string | null;
}

export interface BsaleDocumentsPage {
  items:    BsaleDocumentRow[];
  total:    number;
  page:     number;
  pageSize: number;
}

/**
 * PostgREST parsea `or=(...)` con comas y paréntesis como sintaxis, así que
 * cualquiera de esos caracteres en el término de búsqueda rompería el filtro.
 * Los comodines de LIKE también se escapan para que un `%` se busque literal.
 */
function sanitizeSearch(raw: string): string {
  return raw.replace(/[(),*]/g, "").replace(/[%_]/g, "").trim();
}

/**
 * Los documentos emitidos antes de que se guardara `bsale_document_number` solo
 * tienen el ID interno. Se resuelve el correlativo contra Bsale la primera vez que
 * la fila aparece en pantalla y se persiste, así que es un costo único y acotado
 * al tamaño de la página. Falla en silencio: sin número la fila igual se muestra.
 */
async function backfillDocumentNumbers(
  shopId: string,
  rows:   BsaleDocumentRow[],
): Promise<BsaleDocumentRow[]> {
  const pending = rows.filter((r) => r.bsale_document_id != null && r.bsale_document_number == null);
  if (pending.length === 0) return rows;

  try {
    const { data: shop } = await supabaseAdmin
      .from("shops")
      .select("bsale_token")
      .eq("shop_id", shopId)
      .single();

    const token = shop?.bsale_token ?? process.env.BSALE_ACCESS_TOKEN;
    if (!token) return rows;

    const resolved = new Map<number, number>(); // documentId → number
    const CONCURRENCY = 5;
    for (let i = 0; i < pending.length; i += CONCURRENCY) {
      const batch = pending.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (row) => {
        try {
          const doc = await get<{ number?: number }>(`/documents/${row.bsale_document_id}.json`, token);
          if (doc?.number != null) resolved.set(row.bsale_document_id!, doc.number);
        } catch (err) {
          console.warn(`[bsale-docs] no se pudo resolver el nº del documento ${row.bsale_document_id}:`, String(err));
        }
      }));
    }

    if (resolved.size === 0) return rows;

    await Promise.all([...resolved.entries()].map(([docId, number]) =>
      supabaseAdmin
        .from("bsale_documents")
        .update({ bsale_document_number: number })
        .eq("shop_id", shopId)
        .eq("bsale_document_id", docId),
    ));

    console.log(`[bsale-docs] backfill de nº de documento: ${resolved.size}/${pending.length}`);

    return rows.map((r) =>
      r.bsale_document_id != null && resolved.has(r.bsale_document_id)
        ? { ...r, bsale_document_number: resolved.get(r.bsale_document_id)! }
        : r,
    );
  } catch (err) {
    console.warn("[bsale-docs] backfill de nº de documento falló:", String(err));
    return rows;
  }
}

export async function getBsaleDocumentsPage(
  shopId: string,
  opts:   { q?: string; page?: number } = {},
): Promise<BsaleDocumentsPage> {
  const page  = Math.max(1, Math.floor(opts.page ?? 1));
  const from  = (page - 1) * BSALE_DOCS_PAGE_SIZE;
  const query = sanitizeSearch(opts.q ?? "");

  let request = supabaseAdmin
    .from("bsale_documents")
    .select(
      "shopify_order_id, bsale_document_id, bsale_document_number, status, url_pdf, total_amount, error_message, created_at",
      { count: "exact" },
    )
    .eq("shop_id", shopId);

  if (query) {
    // shopify_order_id es texto → ilike parcial. Los dos identificadores de Bsale son
    // integer, así que solo se comparan por igualdad y si el término es numérico.
    const clauses = [`shopify_order_id.ilike.%${query}%`];
    if (/^\d+$/.test(query)) {
      clauses.push(`bsale_document_number.eq.${query}`);
      clauses.push(`bsale_document_id.eq.${query}`);
    }
    request = request.or(clauses.join(","));
  }

  const { data, count, error } = await request
    .order("created_at", { ascending: false })
    .range(from, from + BSALE_DOCS_PAGE_SIZE - 1);

  if (error) throw new Error(`[getBsaleDocumentsPage] ${error.message}`);

  const items = await backfillDocumentNumbers(shopId, (data ?? []) as BsaleDocumentRow[]);

  return {
    items,
    total:    count ?? 0,
    page,
    pageSize: BSALE_DOCS_PAGE_SIZE,
  };
}
