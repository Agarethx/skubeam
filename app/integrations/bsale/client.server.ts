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
