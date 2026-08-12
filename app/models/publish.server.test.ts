import { describe, it, expect, vi, beforeEach } from "vitest";

interface RecordedQuery {
  table: string;
  calls: Array<{ method: string; args: unknown[] }>;
}

let queries: RecordedQuery[] = [];

function makeSupabaseStub() {
  return {
    from(table: string) {
      const rec: RecordedQuery = { table, calls: [] };
      queries.push(rec);

      const resolve = () => {
        if (table === "skus") {
          const isWrite = rec.calls.some((c) => ["update", "upsert", "insert"].includes(c.method));
          if (isWrite) return { data: null, error: null };
          return {
            data: {
              id: "sku-1", sku_code: "ANZ410", title: "Mochila Doite",
              vendor: "Doite", cost_price: 5000, sale_price: 19990, barcode: "7801234567890",
            },
            error: null,
          };
        }
        if (table === "inventory_levels") return { data: { quantity: 7 }, error: null };
        return { data: null, error: null };
      };

      const proxy: Record<string | symbol, unknown> = new Proxy({}, {
        get(_target, prop) {
          if (prop === "then") {
            return (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
              Promise.resolve(resolve()).then(onFulfilled, onRejected);
          }
          if (prop === "single" || prop === "maybeSingle") return () => Promise.resolve(resolve());
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

vi.mock("../db.server", () => ({ supabaseAdmin: makeSupabaseStub() }));
vi.mock("./sync.server", () => ({ refreshSkuAnalytics: vi.fn() }));

import { publishSkuToShopify } from "./publish.server";

let graphqlCalls: Array<{ query: string; variables?: Record<string, unknown> }> = [];
let restCalls: Array<{ url: string; method: string; body: string }> = [];

const admin = {
  graphql: vi.fn(async (query: string, opts?: { variables?: Record<string, unknown> }) => {
    graphqlCalls.push({ query, variables: opts?.variables });

    if (query.includes("GetFirstLocation")) {
      return { json: async () => ({ data: { locations: { edges: [{ node: { id: "gid://shopify/Location/1" } }] } } }) } as unknown as Response;
    }
    if (query.includes("productCreate")) {
      return {
        json: async () => ({
          data: {
            productCreate: {
              product: {
                id: "gid://shopify/Product/900",
                variants: { nodes: [{ id: "gid://shopify/ProductVariant/111", inventoryItem: { id: "gid://shopify/InventoryItem/222" } }] },
              },
              userErrors: [],
            },
          },
        }),
      } as unknown as Response;
    }
    return { json: async () => ({ data: {} }) } as unknown as Response;
  }),
};

beforeEach(() => {
  queries = [];
  graphqlCalls = [];
  restCalls = [];
  admin.graphql.mockClear();

  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    restCalls.push({ url: String(url), method: String(init?.method ?? "GET"), body: String(init?.body ?? "") });
    return { ok: true, json: async () => ({}) } as unknown as Response;
  }));
});

describe("publishSkuToShopify", () => {
  it("crea el producto como borrador, nunca activo", async () => {
    const result = await publishSkuToShopify(admin, "test.myshopify.com", "shpat_x", "sku-1");

    expect(result).toEqual({ success: true, shopifyProductId: 900 });

    const create = graphqlCalls.find((c) => c.query.includes("productCreate"));
    expect((create?.variables?.product as { status: string }).status).toBe("DRAFT");
  });

  it("no publica el producto en el canal online", async () => {
    await publishSkuToShopify(admin, "test.myshopify.com", "shpat_x", "sku-1");

    // El PUT products/{id}.json con published:true dejaba la ficha visible en la
    // tienda sin imágenes — no debe volver.
    const publishCalls = restCalls.filter((c) => /\/products\/\d+\.json/.test(c.url) || c.body.includes('"published"'));
    expect(publishCalls).toEqual([]);

    const publishMutations = graphqlCalls.filter((c) => /publishablePublish|productPublish/.test(c.query));
    expect(publishMutations).toEqual([]);
  });

  it("igual deja el SKU listo: precio, código de barras y stock", async () => {
    await publishSkuToShopify(admin, "test.myshopify.com", "shpat_x", "sku-1");

    const variantUpdate = graphqlCalls.find((c) => c.query.includes("productVariantsBulkUpdate"));
    const variants = variantUpdate?.variables?.variants as Array<Record<string, unknown>>;
    expect(variants[0]).toMatchObject({ price: "19990", barcode: "7801234567890" });

    const stockCall = restCalls.find((c) => c.url.includes("inventory_levels/set.json"));
    expect(stockCall).toBeDefined();
    expect(JSON.parse(stockCall!.body)).toMatchObject({ available: 7 });
  });
});
