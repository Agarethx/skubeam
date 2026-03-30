import { describe, it, expect, vi } from "vitest";

vi.mock("../db.server", () => ({ supabaseAdmin: {} }));
vi.mock("./sync.server", () => ({ refreshSkuAnalytics: vi.fn() }));

import { computeHealthScore } from "./sku.server";
import type { SkuDetail } from "./sku.server";

function makeSku(overrides: Partial<SkuDetail> = {}): SkuDetail {
  return {
    title: null,
    barcode: null,
    vendor: null,
    cost_price: null,
    ...overrides,
  } as unknown as SkuDetail;
}

describe("computeHealthScore", () => {
  it("returns 100 for a fully populated SKU with stock and sales", () => {
    const sku = makeSku({
      title: "Widget A",
      barcode: "1234567890128",
      vendor: "ACME",
      cost_price: 9.99,
      sale_price: 19.99,
    });
    const { score, criteria } = computeHealthScore(sku, {
      total_stock: 10,
      sold_30d: 5,
    });
    expect(score).toBe(100);
    expect(criteria).toHaveLength(6);
    expect(criteria.every((c) => c.earned)).toBe(true);
  });

  it("returns 0 for an empty SKU with no stock or sales", () => {
    const sku = makeSku();
    const { score, criteria } = computeHealthScore(sku, {
      total_stock: 0,
      sold_30d: 0,
    });
    expect(score).toBe(0);
    expect(criteria.every((c) => !c.earned)).toBe(true);
  });

  it("accumulates partial points correctly (title + barcode only)", () => {
    const sku = makeSku({ title: "Widget A", barcode: "1234567890128" });
    const { score } = computeHealthScore(sku, {
      total_stock: 0,
      sold_30d: 0,
    });
    // title=20 + barcode=25 = 45
    expect(score).toBe(45);
  });
});
