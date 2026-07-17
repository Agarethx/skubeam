import { describe, expect, it, vi } from "vitest";

vi.mock("../../db.server", () => ({ supabaseAdmin: {} }));

import {
  buildBoletaClient,
  buildBoletaDetails,
  type ShopifyOrderForBoleta,
} from "./documents.server";

const baseOrder: ShopifyOrderForBoleta = {
  id:          123456,
  created_at:  "2026-07-15T12:00:00-04:00",
  total_price: "11900",
  line_items:  [{ sku: "SKU-1", quantity: 1, price: "11900" }],
};

describe("buildBoletaDetails", () => {
  it("calcula netUnitValue sin descuentos (precio / 1.19)", () => {
    const details = buildBoletaDetails(baseOrder);
    expect(details).toHaveLength(1);
    expect(details[0].code).toBe("SKU-1");
    expect(details[0].netUnitValue).toBe(10000);
  });

  it("descuenta discount_allocations del precio (código de descuento)", () => {
    const details = buildBoletaDetails({
      ...baseOrder,
      line_items: [{
        sku:      "SKU-1",
        quantity: 2,
        price:    "10000",
        discount_allocations: [{ amount: "4000" }],
      }],
    });
    // (10000×2 − 4000) / 2 = 8000 bruto unitario → 8000/1.19 = 6722.6891
    expect(details[0].netUnitValue).toBe(6722.6891);
    expect(details[0].quantity).toBe(2);
  });

  it("suma múltiples discount_allocations (descuento por línea + por orden)", () => {
    const details = buildBoletaDetails({
      ...baseOrder,
      line_items: [{
        sku:      "SKU-1",
        quantity: 1,
        price:    "11900",
        discount_allocations: [{ amount: "1000" }, { amount: "900" }],
      }],
    });
    // 11900 − 1900 = 10000 bruto → 10000/1.19 = 8403.3613
    expect(details[0].netUnitValue).toBe(8403.3613);
  });

  it("agrega el envío como detalle sin código con el nombre del courier", () => {
    const details = buildBoletaDetails({
      ...baseOrder,
      shipping_lines: [{ title: "Bluexpress", price: "3990" }],
    });
    expect(details).toHaveLength(2);
    const shipping = details[1];
    expect(shipping.code).toBeUndefined();
    expect(shipping.comment).toBe("Bluexpress");
    expect(shipping.quantity).toBe(1);
    // 3990/1.19 = 3352.9412
    expect(shipping.netUnitValue).toBe(3352.9412);
  });

  it("omite el envío cuando un código de envío gratis lo descuenta completo", () => {
    const details = buildBoletaDetails({
      ...baseOrder,
      shipping_lines: [{
        title: "Bluexpress",
        price: "3990",
        discount_allocations: [{ amount: "3990" }],
      }],
    });
    expect(details).toHaveLength(1);
  });

  it("lanza error si no hay items con SKU", () => {
    expect(() =>
      buildBoletaDetails({ ...baseOrder, line_items: [{ sku: "", quantity: 1, price: "1000" }] }),
    ).toThrow("No hay items con SKU válido");
  });
});

describe("buildBoletaClient", () => {
  it("prefiere shipping_address y contact_email sobre datos de la pasarela (Mercado Pago)", () => {
    const client = buildBoletaClient({
      ...baseOrder,
      email:         "cuenta-mp@example.com",
      contact_email: "comprador@example.com",
      customer: {
        first_name: "Cuenta",
        last_name:  "MercadoPago",
        email:      "cuenta-mp@example.com",
        phone:      "+56900000000",
      },
      billing_address: {
        first_name: "Cuenta",
        last_name:  "MercadoPago",
        address1:   "Dirección MP 123",
        city:       "Otra Ciudad",
      },
      shipping_address: {
        first_name: "Juana",
        last_name:  "Pérez",
        address1:   "Av. Checkout 456",
        city:       "Santiago",
        phone:      "+56911111111",
      },
    });

    expect(client.email).toBe("comprador@example.com");
    expect(client.firstName).toBe("Juana");
    expect(client.lastName).toBe("Pérez");
    expect(client.address).toBe("Av. Checkout 456");
    expect(client.city).toBe("Santiago");
    expect(client.phone).toBe("+56911111111");
  });

  it("usa customer/billing como fallback cuando no hay shipping_address", () => {
    const client = buildBoletaClient({
      ...baseOrder,
      email:    "cliente@example.com",
      customer: { first_name: "Pedro", last_name: "Soto" },
      billing_address: { address1: "Calle Facturación 1", city: "Valparaíso" },
    });

    expect(client.email).toBe("cliente@example.com");
    expect(client.firstName).toBe("Pedro");
    expect(client.lastName).toBe("Soto");
    expect(client.address).toBe("Calle Facturación 1");
    expect(client.city).toBe("Valparaíso");
  });
});
