import { supabaseAdmin } from "../../db.server";
import { paginate, resolveToken } from "./client.server";
import { refreshSkuAnalytics } from "../../models/sync.server";

// ── Bsale types ───────────────────────────────────────────────────────────────

interface BsaleStockVariant {
  id:      number;
  code:    string;
  barCode: string | null;
}

interface BsaleStock {
  id:       number;
  /** Available stock quantity — Bsale API field is `quantity`, not `quantityAvailable` */
  quantity: number;
  officeId: number;
  variantId: number;
  variant?:  BsaleStockVariant;
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

export async function getBsaleStocks(
  bsaleToken: string | null | undefined,
): Promise<BsaleStock[]> {
  const token = resolveToken(bsaleToken);
  return paginate<BsaleStock>("/stocks.json", token, {
    expand: "[variant]",
  });
}

// ── Sync ──────────────────────────────────────────────────────────────────────

export async function syncBsaleStockToSkuBeam(
  shopId:     string,
  bsaleToken: string | null | undefined,
): Promise<{ synced: number; errors: number }> {
  // Fetch Bsale stock records
  const stocks = await getBsaleStocks(bsaleToken);

  // Log first raw stock record to verify API field names
  if (stocks.length > 0) {
    const s0 = stocks[0];
    console.log("[bsale-stock] raw stock[0]:", JSON.stringify(s0, null, 2));
    console.log("[bsale-stock] stock fields:", {
      quantity:          (s0 as unknown as Record<string, unknown>)["quantity"],
      quantityAvailable: (s0 as unknown as Record<string, unknown>)["quantityAvailable"],
      quantityReserved:  (s0 as unknown as Record<string, unknown>)["quantityReserved"],
    });
  }

  // Build set of sku_codes we need to look up
  const skuCodes = [
    ...new Set(
      stocks
        .map((s) => s.variant?.code?.trim())
        .filter((c): c is string => !!c),
    ),
  ];

  if (skuCodes.length === 0) return { synced: 0, errors: 0 };

  // Resolve sku_code → sku UUID for this shop
  const { data: skuRows, error: skuErr } = await supabaseAdmin
    .from("skus")
    .select("id, sku_code")
    .eq("shop_id", shopId)
    .in("sku_code", skuCodes);

  if (skuErr) throw new Error(`[syncBsaleStockToSkuBeam] lookup: ${skuErr.message}`);

  const skuMap = new Map<string, string>(
    (skuRows ?? []).map((r) => [r.sku_code, r.id]),
  );

  const now    = new Date().toISOString();
  let synced   = 0;
  let errors   = 0;

  // Upsert inventory_levels in batches
  const rows: object[] = [];

  for (const s of stocks) {
    const code  = s.variant?.code?.trim();
    const skuId = code ? skuMap.get(code) : undefined;
    if (!skuId) continue;

    rows.push({
      shop_id:             shopId,
      sku_id:              skuId,
      shopify_location_id: s.officeId,          // Bsale officeId as location identifier
      location_name:       `Oficina ${s.officeId}`,
      quantity:            Math.max(0, Math.round(s.quantity)),
      updated_at:          now,
    });
  }

  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200);
    const { error } = await supabaseAdmin
      .from("inventory_levels")
      .upsert(batch, { onConflict: "sku_id,shopify_location_id" });

    if (error) {
      console.error(`[syncBsaleStockToSkuBeam] batch ${i}:`, error.message);
      errors += batch.length;
    } else {
      synced += batch.length;
    }
  }

  await refreshSkuAnalytics();
  return { synced, errors };
}
