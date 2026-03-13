import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../db.server";
import { computeHealthScore } from "../models/sku.server";
import type { SkuDetail } from "../models/sku.server";

// ── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  // Read from sku_analytics (source of truth for stock/sales metrics)
  const { data: analytics, error: analyticsError } = await supabaseAdmin
    .from("sku_analytics")
    .select("id, sku_code, title, status, cost_price, total_stock, sold_30d, vendor")
    .eq("shop_id", shopId)
    .order("sku_code");

  if (analyticsError) throw new Error(`api.skus.export: ${analyticsError.message}`);

  // Read extra fields from skus table (barcode for health score, bsale_variant_id, updated_at)
  const { data: skusData } = await supabaseAdmin
    .from("skus")
    .select("id, barcode, bsale_variant_id, updated_at")
    .eq("shop_id", shopId);

  const skusMap = new Map((skusData ?? []).map((s) => [s.id, s]));

  const HEADERS = [
    "sku",
    "title",
    "variant_title",
    "total_stock",
    "price",
    "cost",
    "health_score",
    "status",
    "bsale_variant_id",
    "updated_at",
  ];

  function csvCell(value: string | number | null | undefined): string {
    const s = String(value ?? "");
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  }

  const lines: string[] = [HEADERS.join(",")];

  for (const a of analytics ?? []) {
    const extra = skusMap.get(a.id ?? "");

    // Build a minimal SkuDetail for health score computation
    const skuForScore = {
      title: a.title,
      barcode: extra?.barcode ?? null,
      vendor: a.vendor,
      cost_price: a.cost_price,
    } as SkuDetail;

    const { score } = computeHealthScore(skuForScore, {
      total_stock: a.total_stock,
      sold_30d: a.sold_30d,
    });

    const row = [
      csvCell(a.sku_code),
      csvCell(a.title),
      csvCell(""), // variant_title — not stored separately in DB
      csvCell(a.total_stock),
      csvCell(""), // price — not stored in DB
      csvCell(a.cost_price),
      csvCell(score),
      csvCell(a.status),
      csvCell(extra?.bsale_variant_id),
      csvCell(extra?.updated_at),
    ];

    lines.push(row.join(","));
  }

  const csv = lines.join("\n");

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": "attachment; filename=skus-export.csv",
    },
  });
};
