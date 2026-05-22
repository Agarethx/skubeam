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
  const url = `${BASE_URL}${path}`;
  console.log(`[bsale-client] POST ${url}`, JSON.stringify(body));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);

  let res: Response;
  try {
    res = await fetch(url, {
      method:  "POST",
      headers: headers(token),
      body:    JSON.stringify(body),
      signal:  controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const rawText = await res.text();
  console.log(`[bsale-client] POST ${path} → HTTP ${res.status}`, rawText.slice(0, 500));

  if (!res.ok) {
    throw new Error(`Bsale POST ${path}: ${res.status} ${res.statusText} — ${rawText}`);
  }
  return JSON.parse(rawText) as T;
}

/** PUT request to Bsale — used for stock adjustments. */
export async function put<T>(path: string, token: string, body: unknown): Promise<T> {
  const url = `${BASE_URL}${path}`;
  console.log(`[bsale-client] PUT ${url}`, JSON.stringify(body));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);

  let res: Response;
  try {
    res = await fetch(url, {
      method:  "PUT",
      headers: headers(token),
      body:    JSON.stringify(body),
      signal:  controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const rawText = await res.text();
  console.log(`[bsale-client] PUT ${path} → HTTP ${res.status}`, rawText.slice(0, 500));

  if (!res.ok) {
    throw new Error(`Bsale PUT ${path}: ${res.status} ${res.statusText} — ${rawText}`);
  }
  return JSON.parse(rawText) as T;
}

interface BsaleWebhook {
  id:          number;
  topic:       string;
  urlEndpoint: string;
}

/** Register a Bsale webhook for document:add, deduplicating against existing registrations. */
export async function registerBsaleWebhook(
  accessToken: string,
  webhookUrl:  string,
): Promise<{ ok: boolean; skipped?: boolean; reason?: string; id?: number; error?: string }> {
  const BASE = "https://api.bsale.io/v1/webhooks.json";

  try {
    // Try to list existing webhooks — may fail on some plans (not sandbox-specific)
    const checkRes = await fetch(BASE, {
      headers: { access_token: accessToken },
    });

    console.log("[bsale] GET webhooks.json →", checkRes.status);

    if (checkRes.ok) {
      const existing = await checkRes.json() as BsalePage<BsaleWebhook>;
      const alreadyExists = existing.items?.some(
        (w) => w.urlEndpoint === webhookUrl && w.topic === "document:add",
      );
      if (alreadyExists) {
        console.log("[bsale] webhook ya registrado — saltando");
        return { ok: true, skipped: true, reason: "duplicate" };
      }
      console.log("[bsale] webhooks existentes:", existing.items?.length ?? 0);
    } else {
      // 404 or other — log but continue to attempt registration anyway
      const errBody = await checkRes.text();
      console.warn(`[bsale] GET webhooks.json falló (${checkRes.status}): ${errBody}. Intentando registro de todas formas.`);
    }

    // Attempt registration
    const postRes = await fetch(BASE, {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        access_token:   accessToken,
      },
      body: JSON.stringify({ topic: "document:add", urlEndpoint: webhookUrl }),
    });

    const postBody = await postRes.text();
    console.log(`[bsale] POST webhooks.json → ${postRes.status}:`, postBody.slice(0, 300));

    if (!postRes.ok) {
      // Some Bsale plans don't support API webhook registration — not a fatal error
      // The merchant can register the webhook manually from the Bsale panel
      console.warn("[bsale] Registro automático no disponible — registrar manualmente en Bsale → Configuración → Webhooks");
      return { ok: false, error: `HTTP ${postRes.status}: ${postBody}` };
    }

    const json = JSON.parse(postBody) as { id?: number };
    console.log("[bsale] webhook registrado exitosamente", { id: json.id, url: webhookUrl });
    return { ok: true, id: json.id };

  } catch (err) {
    console.error("[bsale] webhook registration error:", err);
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

  const keepGoing = true;
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

// ── Document type helpers ─────────────────────────────────────────────────────

export interface BsaleDocumentTypeOption {
  id:      number;
  name:    string;
  codeSii: number | null;
}

interface RawDocumentType {
  id:       number;
  name:     string;
  codeSii?: number | null;
  state:    number;
}

/** Return active document types (state=0) for the merchant — used in boleta setup. */
export async function getDocumentTypes(token: string): Promise<BsaleDocumentTypeOption[]> {
  try {
    const data = await get<BsalePage<RawDocumentType>>("/document_types.json?state=0&limit=50", token);
    return (data?.items ?? [])
      .filter((dt) => dt.state === 0)
      .map((dt) => ({
        id:      dt.id,
        name:    dt.name,
        codeSii: dt.codeSii ?? null,
      }));
  } catch (err) {
    console.warn("[bsale] getDocumentTypes failed:", String(err));
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
