import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Los jobs `bsale_stock` y `bsale_prices` son disjuntos a propósito: sincronizar
 * stock desde Bsale nunca debe modificar precios en Shopify (rompería cualquier
 * oferta vigente) y sincronizar precios nunca debe mover inventario.
 *
 * Esta separación es una convención de código, así que se fija acá: un guard
 * estático sobre el fuente, que falla si alguien vuelve a mezclar ambas cosas.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Fuente sin comentarios — los comentarios explican el contrato y lo nombran. */
const read = (file: string) =>
  readFileSync(join(here, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const PRICE_WRITE_PATTERNS = [
  /productVariantsBulkUpdate/,
  /productVariantUpdate/,
  /compareAtPrice\s*:/,
  /\bsale_price\s*:/,
];

const INVENTORY_WRITE_PATTERNS = [
  /inventoryAdjustQuantities/,
  /inventorySetQuantities/,
  /inventoryActivate/,
  /inventory_levels/,
];

describe("contrato stock ↔ precios", () => {
  it("stocks.server.ts no escribe precios", () => {
    const src = read("stocks.server.ts");
    for (const pattern of PRICE_WRITE_PATTERNS) {
      expect(src, `stocks.server.ts no debe contener ${pattern}`).not.toMatch(pattern);
    }
  });

  it("products.server.ts (sync de precios) no escribe inventario", () => {
    const src = read("products.server.ts");
    for (const pattern of INVENTORY_WRITE_PATTERNS) {
      expect(src, `products.server.ts no debe contener ${pattern}`).not.toMatch(pattern);
    }
  });

  it("el webhook Bsale → Shopify solo ajusta inventario, no precios", () => {
    const src = read("realtime.server.ts");
    for (const pattern of PRICE_WRITE_PATTERNS) {
      expect(src, `realtime.server.ts no debe contener ${pattern}`).not.toMatch(pattern);
    }
  });
});
