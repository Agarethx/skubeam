import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

interface RecordedQuery {
  table: string;
  calls: Array<{ method: string; args: unknown[] }>;
}

let queries: RecordedQuery[] = [];
let skuRows: Array<Record<string, unknown>> = [];

/**
 * Minimal chainable stand-in for the Supabase client: every builder method is
 * recorded and returns the builder itself; awaiting it (or calling
 * single/maybeSingle) resolves based on the table and the ops recorded.
 */
function makeSupabaseStub() {
  return {
    from(table: string) {
      const rec: RecordedQuery = { table, calls: [] };
      queries.push(rec);

      const resolve = () => {
        if (table === "shopify_sessions") return { data: { access_token: "shpat_test" }, error: null };
        if (table === "skus") {
          const isWrite = rec.calls.some((c) => ["update", "upsert", "insert"].includes(c.method));
          if (isWrite) return { data: null, error: null };
          return { data: skuRows, error: null };
        }
        return { data: null, error: null };
      };

      const proxy: Record<string | symbol, unknown> = new Proxy({}, {
        get(_target, prop) {
          if (prop === "then") {
            return (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
              Promise.resolve(resolve()).then(onFulfilled, onRejected);
          }
          if (prop === "single" || prop === "maybeSingle") {
            return () => Promise.resolve(resolve());
          }
          return (...args: unknown[]) => {
            rec.calls.push({ method: String(prop), args });
            return proxy;
          };
        },
      }) as Record<string | symbol, unknown>;

      return proxy;
    },
  };
}

vi.mock("../../db.server", () => ({ supabaseAdmin: makeSupabaseStub() }));
vi.mock("../../shopify.server", () => ({ apiVersion: "2026-04" }));
vi.mock("../../models/sync.server", () => ({ refreshSkuAnalytics: vi.fn() }));
vi.mock("./client.server", () => ({ get: vi.fn() }));

import { get } from "./client.server";
import { syncBsalePricesToShopify } from "./products.server";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NORMAL = { skuId: "sku-1", code: "NORMAL-1", variantId: 111, productId: 900, bsaleVariantId: 5001 };
const ONSALE = { skuId: "sku-2", code: "OFERTA-1", variantId: 222, productId: 901, bsaleVariantId: 5002 };

/** Shopify state: NORMAL at 9.990 sin oferta; ONSALE rebajado de 19.990 a 14.990. */
const SHOPIFY_VARIANTS = [
  { id: `gid://shopify/ProductVariant/${NORMAL.variantId}`, price: "9990.00", compareAtPrice: null },
  { id: `gid://shopify/ProductVariant/${ONSALE.variantId}`, price: "14990.00", compareAtPrice: "19990.00" },
];

/** Bsale price list: ambos a 12.990 (distinto del precio vivo en Shopify). */
const BSALE_PRICE = 12990;

let graphqlBodies: Array<{ query: string; variables?: Record<string, unknown> }> = [];

function mockShopifyFetch() {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { query: string; variables?: Record<string, unknown> };
    graphqlBodies.push(body);

    if (body.query.includes("GetVariantPrices")) {
      const ids = (body.variables?.ids ?? []) as string[];
      return {
        json: async () => ({ data: { nodes: SHOPIFY_VARIANTS.filter((v) => ids.includes(v.id)) } }),
      } as unknown as Response;
    }
    if (body.query.includes("productVariantsBulkUpdate")) {
      return {
        json: async () => ({ data: { productVariantsBulkUpdate: { userErrors: [] } } }),
      } as unknown as Response;
    }
    return { json: async () => ({ data: {} }) } as unknown as Response;
  }));
}

beforeEach(() => {
  queries = [];
  graphqlBodies = [];
  skuRows = [
    { id: NORMAL.skuId, sku_code: NORMAL.code, title: "Normal", bsale_variant_id: String(NORMAL.bsaleVariantId), shopify_variant_id: NORMAL.variantId, shopify_product_id: NORMAL.productId },
    { id: ONSALE.skuId, sku_code: ONSALE.code, title: "En oferta", bsale_variant_id: String(ONSALE.bsaleVariantId), shopify_variant_id: ONSALE.variantId, shopify_product_id: ONSALE.productId },
  ];

  vi.mocked(get).mockImplementation(async (path: string) => {
    if (path.includes("/details.json")) {
      const offset = Number(new URL(`http://x/${path}`).searchParams.get("offset") ?? 0);
      if (offset > 0) return { items: [] } as never;
      return {
        items: [
          { variantValueWithTaxes: BSALE_PRICE, variant: { id: NORMAL.bsaleVariantId, code: NORMAL.code } },
          { variantValueWithTaxes: BSALE_PRICE, variant: { id: ONSALE.bsaleVariantId, code: ONSALE.code } },
        ],
      } as never;
    }
    return { items: [] } as never;
  });

  mockShopifyFetch();
});

const priceMutations = () => graphqlBodies.filter((b) => b.query.includes("productVariantsBulkUpdate"));
const skuWrites = () => queries.filter((q) => q.table === "skus" && q.calls.some((c) => c.method === "update"));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("syncBsalePricesToShopify — descuentos", () => {
  it("omite las variantes en oferta y las reporta en discounted_skipped", async () => {
    const result = await syncBsalePricesToShopify("test.myshopify.com", "tok", 7);

    expect(result.discounted_skipped).toHaveLength(1);
    expect(result.discounted_skipped[0]).toMatchObject({
      sku_code:         ONSALE.code,
      price_shopify:    14990,
      compare_at_price: 19990,
      price_bsale:      BSALE_PRICE,
    });

    // La variante en oferta no aparece en ninguna mutación de precio.
    const pushedIds = priceMutations().flatMap((b) =>
      ((b.variables?.variants ?? []) as Array<{ id: string }>).map((v) => v.id),
    );
    expect(pushedIds).toContain(`gid://shopify/ProductVariant/${NORMAL.variantId}`);
    expect(pushedIds).not.toContain(`gid://shopify/ProductVariant/${ONSALE.variantId}`);
  });

  it("sí actualiza las variantes sin oferta", async () => {
    const result = await syncBsalePricesToShopify("test.myshopify.com", "tok", 7);

    expect(result.shopify_updated).toBe(1);
    expect(result.items.map((i) => i.sku_code)).toEqual([NORMAL.code]);
    expect(result.items[0]).toMatchObject({ price_before: 9990, price_after: BSALE_PRICE, changed: true });
  });

  it("no escribe sale_price en Supabase para las variantes en oferta", async () => {
    await syncBsalePricesToShopify("test.myshopify.com", "tok", 7);

    const salePriceWrites = skuWrites().filter((q) =>
      q.calls.some((c) => c.method === "update" && JSON.stringify(c.args).includes("sale_price")),
    );
    expect(salePriceWrites).toHaveLength(1);
    expect(JSON.stringify(salePriceWrites[0].calls)).toContain(NORMAL.skuId);
    expect(JSON.stringify(salePriceWrites[0].calls)).not.toContain(ONSALE.skuId);
  });

  it("una variante con compareAtPrice obsoleto (<= precio) no cuenta como oferta", async () => {
    SHOPIFY_VARIANTS[1].compareAtPrice = "14990.00";
    try {
      const result = await syncBsalePricesToShopify("test.myshopify.com", "tok", 7);
      expect(result.discounted_skipped).toHaveLength(0);
      expect(result.shopify_updated).toBe(2);
    } finally {
      SHOPIFY_VARIANTS[1].compareAtPrice = "19990.00";
    }
  });
});

describe("syncBsalePricesToShopify — vista previa", () => {
  it("calcula el diff sin escribir en Shopify ni en Supabase", async () => {
    const result = await syncBsalePricesToShopify("test.myshopify.com", "tok", 7, { preview: true });

    expect(result.mode).toBe("preview");
    expect(priceMutations()).toHaveLength(0);
    expect(result.shopify_updated).toBe(0);
    expect(result.synced).toBe(0);

    const salePriceWrites = skuWrites().filter((q) =>
      q.calls.some((c) => c.method === "update" && JSON.stringify(c.args).includes("sale_price")),
    );
    expect(salePriceWrites).toHaveLength(0);

    // Pero el diff propuesto sí está completo.
    expect(result.items.filter((i) => i.changed).map((i) => i.sku_code)).toEqual([NORMAL.code]);
    expect(result.discounted_skipped.map((d) => d.sku_code)).toEqual([ONSALE.code]);
  });
});

describe("syncBsalePricesToShopify — contrato precio/stock", () => {
  it("nunca toca inventario: ni mutaciones de stock en Shopify ni inventory_levels", async () => {
    await syncBsalePricesToShopify("test.myshopify.com", "tok", 7);

    const inventoryOps = graphqlBodies.filter((b) =>
      /inventoryAdjustQuantities|inventorySetQuantities|inventoryActivate|inventoryItemUpdate/.test(b.query),
    );
    expect(inventoryOps).toHaveLength(0);
    expect(queries.some((q) => q.table === "inventory_levels")).toBe(false);
  });
});
