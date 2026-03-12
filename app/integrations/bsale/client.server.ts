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
