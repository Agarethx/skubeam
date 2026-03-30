const BASE_URL = "https://api.bsale.io/v1";

interface BsalePage<T> {
  count:   number;
  limit:   number;
  offset:  number;
  items?:  T[];
}

function headers(token: string): Record<string, string> {
  return {
    access_token:   token,
    "Content-Type": "application/json",
  };
}

/** Single GET with a 25-second AbortController timeout. */
export async function get<T>(path: string, token: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      headers: headers(token),
      signal:  controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`Bsale GET ${path}: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Fetches all pages from a Bsale list endpoint.
 * Bsale returns max 50 items per page (limit param).
 */
export async function paginate<T>(
  path:   string,
  token:  string,
  params: Record<string, string> = {},
): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;
  const limit = 50;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const qs = new URLSearchParams({
      ...params,
      limit:  String(limit),
      offset: String(offset),
    });
    const page = await get<BsalePage<T>>(`${path}?${qs}`, token);
    const items = page.items ?? [];
    all.push(...items);
    if (items.length === 0 || all.length >= page.count) break;
    offset += limit;
  }

  return all;
}

/** POST request to Bsale — used for creating documents and other resources. */
export async function post<T>(path: string, token: string, body: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method:  "POST",
      headers: headers(token),
      body:    JSON.stringify(body),
      signal:  controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`Bsale POST ${path}: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

/** PUT request to Bsale — used for stock adjustments. */
export async function put<T>(path: string, token: string, body: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method:  "PUT",
      headers: headers(token),
      body:    JSON.stringify(body),
      signal:  controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`Bsale PUT ${path}: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

interface BsaleWebhook {
  id:          number;
  topic:       string;
  urlEndpoint: string;
}

/** Register a Bsale webhook for document:add, skipping sandbox accounts and duplicates. */
export async function registerBsaleWebhook(
  accessToken: string,
  webhookUrl:  string,
): Promise<{ ok: boolean; skipped?: boolean; reason?: string; id?: number; error?: string }> {
  try {
    // Probe the webhooks endpoint first — sandbox returns 404, production returns 200/items
    const check = await fetch("https://api.bsale.io/v1/webhooks.json", {
      headers: { access_token: accessToken },
    });

    if (check.status === 404) {
      console.log("[bsale] webhooks endpoint not available (sandbox), skipping");
      return { ok: true, skipped: true, reason: "sandbox-no-webhooks" };
    }

    // Check for existing registration to avoid duplicates
    if (check.ok) {
      const existing = await check.json() as BsalePage<BsaleWebhook>;
      const alreadyExists = existing.items?.some(
        (w) => w.urlEndpoint === webhookUrl && w.topic === "document:add",
      );
      if (alreadyExists) {
        console.log("[bsale] webhook already registered, skipping");
        return { ok: true, skipped: true, reason: "duplicate" };
      }
    }

    const res = await fetch("https://api.bsale.io/v1/webhooks.json", {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        access_token:   accessToken,
      },
      body: JSON.stringify({ topic: "document:add", urlEndpoint: webhookUrl }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Bsale register webhook: ${res.status} ${body}`);
    }

    const json = await res.json() as { id?: number };
    console.log("[bsale] webhook registered", { id: json.id, url: webhookUrl });
    return { ok: true, id: json.id };
  } catch (err) {
    console.error("[bsale] webhook registration error", err);
    return { ok: false, error: String(err) };
  }
}

// ── Price list helpers ────────────────────────────────────────────────────────

interface BsalePriceListItem {
  id:    number;
  name:  string;
  state: number;
  base:  number | null;
}

interface BsalePriceListDetail {
  variantValueWithTaxes: number;
  variant?: { id: number };
}

/**
 * Auto-detect the merchant's base price list.
 * Prefers active lists (`state=0`) with `base=0` (standard retail list).
 * Returns the list ID or null if none found / API unavailable.
 */
export async function detectBasePriceList(token: string): Promise<number | null> {
  try {
    const data = await get<BsalePage<BsalePriceListItem>>("/price_lists.json?state=0&limit=50", token);
    const items = data?.items ?? [];
    const found =
      items.find((l) => l.state === 0 && l.base === 0) ??
      items.find((l) => l.state === 0);
    console.log(`[bsale-prices] detectBasePriceList → id=${found?.id ?? null} name="${found?.name ?? "-"}"`);
    return found?.id ?? null;
  } catch (err) {
    console.warn("[bsale-prices] detectBasePriceList failed:", String(err));
    return null;
  }
}

/**
 * Load the full variant→price map from a Bsale price list.
 * Key: bsale variant ID (number). Value: price with taxes (sale price).
 * Skips items with price <= 0.
 */
export async function fetchPriceMap(
  token:       string,
  priceListId: number,
): Promise<Map<number, number>> {
  const priceMap = new Map<number, number>();
  let offset = 0;
  const limit = 50;

  let keepGoing = true;
  while (keepGoing) {
    const data = await get<BsalePage<BsalePriceListDetail>>(
      `/price_lists/${priceListId}/details.json?limit=${limit}&offset=${offset}&expand=[variant]`,
      token,
    );
    const items = data?.items ?? [];

    for (const item of items) {
      if (item.variant?.id && item.variantValueWithTaxes > 0) {
        priceMap.set(item.variant.id, item.variantValueWithTaxes);
      }
    }

    if (items.length < limit) break;
    offset += limit;
  }

  console.log(`[bsale-prices] Loaded ${priceMap.size} prices from price list ${priceListId}`);
  return priceMap;
}

// ── Wizard setup helpers ──────────────────────────────────────────────────────

const COIN_NAMES: Record<string, string> = { "1": "CLP", "2": "USD" };

export interface BsalePriceListOption {
  id:       number;
  name:     string;
  currency: string;
}

export interface BsaleOfficeOption {
  id:      number;
  name:    string;
  address: string;
}

interface RawPriceList {
  id:    number;
  name:  string;
  state: number;
  coin?: { id?: string };
}

interface RawOffice {
  id:      number;
  name:    string;
  state:   number;
  address?: string;
}

/** Return active price lists (state=0) for the merchant — used in setup wizard. */
export async function getPriceLists(token: string): Promise<BsalePriceListOption[]> {
  try {
    const data = await get<BsalePage<RawPriceList>>("/price_lists.json?state=0&limit=50", token);
    return (data?.items ?? [])
      .filter((l) => l.state === 0)
      .map((l) => ({
        id:       l.id,
        name:     l.name,
        currency: COIN_NAMES[l.coin?.id ?? ""] ?? "CLP",
      }));
  } catch (err) {
    console.warn("[bsale] getPriceLists failed:", String(err));
    return [];
  }
}

/** Return active offices (state=0) for the merchant — used in setup wizard. */
export async function getOffices(token: string): Promise<BsaleOfficeOption[]> {
  try {
    const data = await get<BsalePage<RawOffice>>("/offices.json?state=0&limit=50", token);
    return (data?.items ?? [])
      .filter((o) => o.state === 0)
      .map((o) => ({
        id:      o.id,
        name:    o.name,
        address: o.address ?? "",
      }));
  } catch (err) {
    console.warn("[bsale] getOffices failed:", String(err));
    return [];
  }
}

/** Resolve the token to use: merchant-specific first, then env fallback. */
export function resolveToken(bsaleToken: string | null | undefined): string {
  const token = bsaleToken ?? process.env.BSALE_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      "No Bsale token configured. Set BSALE_ACCESS_TOKEN or add a token in Integraciones.",
    );
  }
  return token;
}
