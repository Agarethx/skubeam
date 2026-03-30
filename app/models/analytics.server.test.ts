import { describe, it, expect, beforeEach, vi } from "vitest";

const mockData = vi.hoisted(() => ({ rows: [] as Array<{ total_stock: number | null; sold_30d: number | null; cost_price: number | null }> }));

vi.mock("../db.server", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => chain,
    range: () => chain,
    gt: () => chain,
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve({ data: mockData.rows, error: null }).then(resolve, reject),
  };
  return { supabaseAdmin: { from: () => chain } };
});

import { getShopKpis } from "./analytics.server";

describe("getShopKpis", () => {
  beforeEach(() => {
    mockData.rows = [];
  });

  it("returns zero KPIs when no active SKUs exist", async () => {
    const kpis = await getShopKpis("test-shop.myshopify.com");
    expect(kpis.active_skus).toBe(0);
    expect(kpis.units_sold_30d).toBe(0);
    expect(kpis.turnover_ratio).toBe(0);
    expect(kpis.estimated_cogs_30d).toBe(0);
  });

  it("computes turnover_ratio and estimated_cogs correctly", async () => {
    mockData.rows = [
      { total_stock: 100, sold_30d: 10, cost_price: 5 },
      { total_stock: 50, sold_30d: 15, cost_price: null },
    ];
    const kpis = await getShopKpis("test-shop.myshopify.com");
    expect(kpis.active_skus).toBe(2);
    expect(kpis.total_stock).toBe(150);
    expect(kpis.units_sold_30d).toBe(25);
    // Only first SKU has cost: cogs = 10 * 5 = 50
    expect(kpis.estimated_cogs_30d).toBe(50);
    // turnover = round(25/150 * 100) / 100 = 0.17
    expect(kpis.turnover_ratio).toBe(0.17);
  });
});
