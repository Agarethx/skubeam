/**
 * scripts/debug-bsale-stock.ts
 *
 * Standalone diagnostic for "algunos SKUs no se encuentran al sincronizar stock
 * desde Bsale". Reproduces the exact matching logic of
 * syncBsaleStockToSkuBeam() (app/integrations/bsale/stocks.server.ts) but,
 * instead of writing to Supabase/Shopify, dumps every raw record it gets from
 * Bsale to disk and classifies every skipped SKU so you can tell apart:
 *
 *   - MISSING_EVERYWHERE   → code doesn't appear in stocks.json for ANY office,
 *                            nor in the configured price list. Doesn't exist
 *                            in Bsale under that code — likely a real data gap
 *                            (typo, deleted variant, code mismatch).
 *   - WRONG_OFFICE         → code has a stock row, but only under an office
 *                            OTHER than the one configured in Integraciones.
 *   - IN_PRICE_LIST_ONLY   → code exists in the price list (so product sync
 *                            picks it up) but has NO stock row at all in
 *                            Bsale, in any office — Bsale simply never
 *                            returns a stocks.json row for that variant.
 *   - CODE_MISMATCH        → an exact-normalized match wasn't found, but a
 *                            case-insensitive / whitespace-insensitive near
 *                            match exists — points at a data entry issue in
 *                            Shopify or Bsale.
 *
 * Nothing here writes to Supabase or Shopify — read-only against Bsale +
 * a read-only select against Supabase (via REST) for the shop's SKUs.
 *
 * Usage:
 *   npx tsx scripts/debug-bsale-stock.ts <SHOP_ID> [--all-offices]
 *
 * Example:
 *   npx tsx scripts/debug-bsale-stock.ts mi-tienda.myshopify.com --all-offices
 *
 * Reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / BSALE_ACCESS_TOKEN from
 * .env in the project root (same values `npm run dev` uses). The shop's own
 * bsale_token + bsale_office_id (saved via the Integraciones wizard) take
 * precedence over the .env fallback, exactly like production.
 *
 * Output:
 *   debug-output/<timestamp>/stocks-raw-office-<id>.json   → every raw record Bsale returned for that office
 *   debug-output/<timestamp>/price-list-raw.json           → every raw record from the configured price list
 *   debug-output/<timestamp>/summary.json                  → classified skipped SKUs + counts
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ── .env loader (no dotenv dependency in this project) ────────────────────────

function loadEnv(): Record<string, string> {
  const path = join(process.cwd(), ".env");
  const env: Record<string, string> = {};
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

const env = { ...loadEnv(), ...process.env };

const SUPABASE_URL = env.SUPABASE_URL;
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const ENV_BSALE_TOKEN = env.BSALE_ACCESS_TOKEN;

const SHOP_ID = process.argv[2];
const ALL_OFFICES = process.argv.includes("--all-offices");

if (!SHOP_ID) {
  console.error("Usage: npx tsx scripts/debug-bsale-stock.ts <SHOP_ID> [--all-offices]");
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

// ── Supabase REST helpers ──────────────────────────────────────────────────────

const sbHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
};

async function sbSelect<T>(table: string, query: string): Promise<T[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, { headers: sbHeaders });
  if (!res.ok) throw new Error(`Supabase ${table}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T[]>;
}

// ── Bsale REST helpers ──────────────────────────────────────────────────────

const BSALE_BASE = "https://api.bsale.io/v1";

async function bsaleGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${BSALE_BASE}${path}`, {
    headers: { access_token: token, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Bsale GET ${path}: ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

interface BsalePage<T> {
  count: number;
  limit: number;
  offset: number;
  items?: T[];
}

// ── Types matching production shape ────────────────────────────────────────────

interface BsaleStockRecord {
  quantity: number;
  variant?: { id: number; code?: string };
  office?: { id: number; name?: string };
}

interface BsaleOffice {
  id: number;
  name: string;
  state: number;
}

interface BsalePriceDetail {
  variantValueWithTaxes: number;
  variant?: { id: number; code?: string; description?: string; barCode?: string | null };
}

interface ShopifySkuRow {
  id: string;
  sku_code: string;
  title: string | null;
  bsale_variant_id: string | null;
  shopify_variant_id: number | null;
}

// ── Paginate every stocks.json row for one office, no dedup, no aggregation ───

async function fetchAllStocksRaw(token: string, officeId: number): Promise<BsaleStockRecord[]> {
  const all: BsaleStockRecord[] = [];
  const LIMIT = 50;
  let offset = 0;
  let bsaleCountField = 0;

  for (;;) {
    const qs = new URLSearchParams({
      expand: "[variant]",
      limit: String(LIMIT),
      offset: String(offset),
      officeid: String(officeId),
    });
    const page = await bsaleGet<BsalePage<BsaleStockRecord>>(`/stocks.json?${qs}`, token);
    if (offset === 0) bsaleCountField = page.count ?? 0;
    const items = page.items ?? [];
    all.push(...items);
    console.log(`  [office ${officeId}] offset=${offset} → +${items.length} (total ${all.length}, bsale count field=${bsaleCountField})`);
    if (items.length < LIMIT) break;
    offset += LIMIT;
  }

  return all;
}

async function fetchPriceListRaw(token: string, priceListId: number): Promise<BsalePriceDetail[]> {
  const all: BsalePriceDetail[] = [];
  const LIMIT = 50;
  let offset = 0;

  for (;;) {
    const page = await bsaleGet<BsalePage<BsalePriceDetail>>(
      `/price_lists/${priceListId}/details.json?expand=[variant]&limit=${LIMIT}&offset=${offset}`,
      token,
    );
    const items = page.items ?? [];
    all.push(...items);
    console.log(`  [price list ${priceListId}] offset=${offset} → +${items.length} (total ${all.length})`);
    if (items.length < LIMIT) break;
    offset += LIMIT;
  }

  return all;
}

function normCode(code: string | null | undefined): string {
  return (code ?? "").trim().toUpperCase();
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n[debug-bsale-stock] shop=${SHOP_ID} all-offices=${ALL_OFFICES}\n`);

  const [shopRows] = await Promise.all([
    sbSelect<{ bsale_token: string | null; bsale_office_id: number | null; bsale_price_list_id: number | null }>(
      "shops",
      `shop_id=eq.${SHOP_ID}&select=bsale_token,bsale_office_id,bsale_price_list_id`,
    ),
  ]);
  const shop = shopRows[0];
  if (!shop) throw new Error(`No row in shops for shop_id=${SHOP_ID}`);

  const token = shop.bsale_token ?? ENV_BSALE_TOKEN;
  if (!token) throw new Error("No Bsale token: not on shops.bsale_token nor BSALE_ACCESS_TOKEN in .env");
  const configuredOfficeId = shop.bsale_office_id;
  const priceListId = shop.bsale_price_list_id;

  console.log(`configured office_id=${configuredOfficeId ?? "NONE"}  price_list_id=${priceListId ?? "NONE"}\n`);

  // 1. All Shopify-published SKUs in Supabase (same filter as production)
  const shopifySkus = await sbSelect<ShopifySkuRow>(
    "skus",
    `shop_id=eq.${SHOP_ID}&shopify_variant_id=not.is.null&select=id,sku_code,title,bsale_variant_id,shopify_variant_id`,
  );
  console.log(`Supabase SKUs (published in Shopify): ${shopifySkus.length}\n`);

  // 2. All Bsale offices (to know what "other offices" even exist)
  const officesPage = await bsaleGet<BsalePage<BsaleOffice>>("/offices.json?state=0&limit=50", token);
  const offices = (officesPage.items ?? []).filter((o) => o.state === 0);
  console.log(`Bsale active offices: ${offices.map((o) => `${o.id}:${o.name}`).join(", ")}\n`);

  const officesToFetch = ALL_OFFICES
    ? offices.map((o) => o.id)
    : configuredOfficeId
      ? [configuredOfficeId]
      : offices.map((o) => o.id);

  // 3. Raw stock dump per office
  const stocksByOffice = new Map<number, BsaleStockRecord[]>();
  for (const officeId of officesToFetch) {
    console.log(`Fetching stocks.json for office ${officeId}…`);
    const raw = await fetchAllStocksRaw(token, officeId);
    stocksByOffice.set(officeId, raw);
    console.log(`  → ${raw.length} raw rows\n`);
  }

  // 4. Raw price list dump (product-catalog source of truth)
  let priceListRaw: BsalePriceDetail[] = [];
  if (priceListId) {
    console.log(`Fetching price_lists/${priceListId}/details.json…`);
    priceListRaw = await fetchPriceListRaw(token, priceListId);
    console.log(`  → ${priceListRaw.length} raw rows\n`);
  } else {
    console.log("No price_list_id configured — skipping price list dump.\n");
  }

  // ── Build indices exactly like production stocks.server.ts ──────────────────

  function buildIndex(records: BsaleStockRecord[]) {
    const byVariantId = new Map<string, number>();
    const byCode = new Map<string, { variantId: string; quantity: number }>();
    for (const item of records) {
      const variantId = item.variant?.id != null ? String(item.variant.id) : null;
      const code = normCode(item.variant?.code);
      const qty = Math.max(0, Math.round(item.quantity));
      if (!variantId) continue;
      byVariantId.set(variantId, Math.max(byVariantId.get(variantId) ?? 0, qty));
      if (code) {
        const prev = byCode.get(code);
        if (!prev || qty > prev.quantity) byCode.set(code, { variantId, quantity: qty });
      }
    }
    return { byVariantId, byCode };
  }

  const configuredIndex = configuredOfficeId
    ? buildIndex(stocksByOffice.get(configuredOfficeId) ?? [])
    : buildIndex([...stocksByOffice.values()].flat());

  // Codes present anywhere across ALL fetched offices (union)
  const anyOfficeCodeSet = new Set<string>();
  const codeToOffices = new Map<string, number[]>();
  for (const [officeId, records] of stocksByOffice.entries()) {
    for (const r of records) {
      const code = normCode(r.variant?.code);
      if (!code) continue;
      anyOfficeCodeSet.add(code);
      const list = codeToOffices.get(code) ?? [];
      if (!list.includes(officeId)) list.push(officeId);
      codeToOffices.set(code, list);
    }
  }

  const priceListCodeSet = new Set(priceListRaw.map((r) => normCode(r.variant?.code)).filter(Boolean));

  // ── Reproduce production matching + classify skips ─────────────────────────

  type Classification =
    | "MATCHED"
    | "MISSING_EVERYWHERE"
    | "WRONG_OFFICE"
    | "IN_PRICE_LIST_ONLY"
    | "CODE_MISMATCH";

  const classified: Array<{
    sku_code: string;
    title: string | null;
    bsale_variant_id: string | null;
    classification: Classification;
    detail: string;
  }> = [];

  for (const sku of shopifySkus) {
    const code = normCode(sku.sku_code);
    let matched = false;

    if (sku.bsale_variant_id && configuredIndex.byVariantId.has(sku.bsale_variant_id)) matched = true;
    if (!matched && configuredIndex.byCode.has(code)) matched = true;

    if (matched) {
      classified.push({ sku_code: sku.sku_code, title: sku.title, bsale_variant_id: sku.bsale_variant_id, classification: "MATCHED", detail: "" });
      continue;
    }

    // Not matched in configured office — classify why.
    if (anyOfficeCodeSet.has(code)) {
      const offs = codeToOffices.get(code) ?? [];
      classified.push({
        sku_code: sku.sku_code,
        title: sku.title,
        bsale_variant_id: sku.bsale_variant_id,
        classification: "WRONG_OFFICE",
        detail: `Tiene stock en oficina(s) ${offs.join(", ")} pero no en la configurada (${configuredOfficeId ?? "ninguna"})`,
      });
      continue;
    }

    if (priceListCodeSet.has(code)) {
      classified.push({
        sku_code: sku.sku_code,
        title: sku.title,
        bsale_variant_id: sku.bsale_variant_id,
        classification: "IN_PRICE_LIST_ONLY",
        detail: "Existe en la lista de precios (producto sync lo trae) pero Bsale no devuelve ninguna fila en /stocks.json para este código, en ninguna oficina consultada.",
      });
      continue;
    }

    // Near-match check (case/whitespace already normalized above, so this
    // catches things like leading zeros, hyphens, or partial codes).
    const near = [...anyOfficeCodeSet, ...priceListCodeSet].find(
      (c) => c.replace(/[-_\s]/g, "") === code.replace(/[-_\s]/g, "") && c !== code,
    );
    if (near) {
      classified.push({
        sku_code: sku.sku_code,
        title: sku.title,
        bsale_variant_id: sku.bsale_variant_id,
        classification: "CODE_MISMATCH",
        detail: `Código similar encontrado en Bsale: "${near}" (probablemente guiones/espacios distintos)`,
      });
      continue;
    }

    classified.push({
      sku_code: sku.sku_code,
      title: sku.title,
      bsale_variant_id: sku.bsale_variant_id,
      classification: "MISSING_EVERYWHERE",
      detail: "No aparece en stocks.json (ninguna oficina consultada) ni en la lista de precios configurada.",
    });
  }

  const counts = classified.reduce<Record<string, number>>((acc, c) => {
    acc[c.classification] = (acc[c.classification] ?? 0) + 1;
    return acc;
  }, {});

  // ── Write output ──────────────────────────────────────────────────────────

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(process.cwd(), "debug-output", stamp);
  mkdirSync(outDir, { recursive: true });

  for (const [officeId, records] of stocksByOffice.entries()) {
    writeFileSync(join(outDir, `stocks-raw-office-${officeId}.json`), JSON.stringify(records, null, 2));
  }
  if (priceListId) {
    writeFileSync(join(outDir, "price-list-raw.json"), JSON.stringify(priceListRaw, null, 2));
  }
  writeFileSync(
    join(outDir, "summary.json"),
    JSON.stringify(
      {
        shop_id: SHOP_ID,
        configured_office_id: configuredOfficeId,
        price_list_id: priceListId,
        offices_fetched: officesToFetch,
        total_shopify_skus: shopifySkus.length,
        counts,
        skipped: classified.filter((c) => c.classification !== "MATCHED"),
      },
      null,
      2,
    ),
  );

  console.log(`\n═══ RESUMEN ═══`);
  console.log(`Total SKUs Shopify:        ${shopifySkus.length}`);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(20)} ${v}`);
  console.log(`\nArchivos escritos en: ${outDir}`);
  console.log(`  - summary.json           → lista clasificada de SKUs no encontrados + por qué`);
  console.log(`  - stocks-raw-office-*.json → dump crudo de /stocks.json por oficina`);
  if (priceListId) console.log(`  - price-list-raw.json     → dump crudo de la lista de precios`);
}

main().catch((err) => {
  console.error("[debug-bsale-stock] fatal:", err);
  process.exit(1);
});
