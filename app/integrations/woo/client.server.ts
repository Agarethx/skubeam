// WooCommerce REST API v3 client

export interface WooCredentials {
  url: string;          // https://mi-tienda.com (no trailing slash)
  consumerKey: string;
  consumerSecret: string;
}

export interface WooCategory {
  id:   number;
  name: string;
  slug: string;
}

export interface WooImage {
  id:  number;
  src: string;
  alt: string;
}

export interface WooSimpleProduct {
  id:                number;
  name:              string;
  sku:               string;
  type:              "simple";
  status:            string;          // publish, draft, etc.
  price:             string;
  regular_price:     string;
  stock_quantity:    number | null;
  manage_stock:      boolean;
  categories:        WooCategory[];
  description:       string;
  short_description: string;
  images:            WooImage[];
}

export interface WooVariableProduct {
  id:                number;
  name:              string;
  sku:               string;
  type:              "variable";
  status:            string;
  price:             string;
  variations:        number[];  // variation IDs
  categories:        WooCategory[];
  description:       string;
  short_description: string;
  images:            WooImage[];
}

export type WooProduct = WooSimpleProduct | WooVariableProduct;

export interface WooVariation {
  id:             number;
  sku:            string;
  price:          string;
  regular_price:  string;
  stock_quantity: number | null;
  manage_stock:   boolean;
  attributes:     Array<{ name: string; option: string }>;
}

export interface WooBillingAddress {
  first_name: string;
  last_name:  string;
  address_1:  string;
  city:       string;
  country:    string;
  phone:      string;
  email:      string;
}

export interface WooShippingLine {
  id:           number;
  method_id:    string;
  method_title: string;
  total:        string;
}

export interface WooMetaData {
  id:    number;
  key:   string;
  value: string;
}

export interface WooOrder {
  id:                   number;
  status:               string;
  date_created:         string;  // ISO
  payment_method_title: string;
  billing:              WooBillingAddress;
  shipping_lines:       WooShippingLine[];
  meta_data:            WooMetaData[];
  line_items: Array<{
    id:           number;
    product_id:   number;
    variation_id: number;
    name:         string;
    sku:          string;
    quantity:     number;
    price:        string;
  }>;
}

function authHeader(creds: WooCredentials): string {
  return "Basic " + Buffer.from(`${creds.consumerKey}:${creds.consumerSecret}`).toString("base64");
}

async function wooFetch<T>(
  creds: WooCredentials,
  path: string,
  params: Record<string, string> = {},
): Promise<{ data: T; total: number }> {
  // Use Authorization header instead of query params (safer)
  const url = new URL(`${creds.url}/wp-json/wc/v3${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { Authorization: authHeader(creds) },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`WooCommerce ${path}: ${res.status} ${res.statusText}`);
  }

  const total = parseInt(res.headers.get("X-WP-Total") ?? "0", 10);
  const data = (await res.json()) as T;
  return { data, total };
}

/** Get counts without fetching full data. */
export async function getWooCounts(
  creds: WooCredentials,
): Promise<{ productCount: number; orderCount: number; simpleCount: number; variableCount: number }> {
  const [products, orders, simples, variables] = await Promise.all([
    wooFetch<unknown[]>(creds, "/products", { per_page: "1" }),
    wooFetch<unknown[]>(creds, "/orders",   { per_page: "1" }).catch(() => ({ total: 0, data: [] })),
    wooFetch<unknown[]>(creds, "/products", { per_page: "1", type: "simple"   }),
    wooFetch<unknown[]>(creds, "/products", { per_page: "1", type: "variable" }),
  ]);
  return {
    productCount:  products.total,
    orderCount:    orders.total,
    simpleCount:   simples.total,
    variableCount: variables.total,
  };
}

/** Paginate all products (simple + variable, page by page). */
export async function* paginateProducts(
  creds: WooCredentials,
  options?: { preview?: boolean },
): AsyncGenerator<WooProduct[]> {
  const perPage = options?.preview ? 5 : 100;
  let page = 1;
  while (true) {
    const { data, total } = await wooFetch<WooProduct[]>(creds, "/products", {
      per_page: String(perPage),
      page:     String(page),
      status:   "publish",
    });
    if (data.length === 0) break;
    yield data;
    if (options?.preview) break;
    if (page * perPage >= total) break;
    page++;
  }
}

/** Fetch all variations for a variable product. */
export async function getVariations(
  creds: WooCredentials,
  productId: number,
): Promise<WooVariation[]> {
  const perPage = 100;
  let page = 1;
  const all: WooVariation[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, total } = await wooFetch<WooVariation[]>(
      creds,
      `/products/${productId}/variations`,
      { per_page: String(perPage), page: String(page) },
    );
    all.push(...data);
    if (data.length === 0 || page * perPage >= total) break;
    page++;
  }
  return all;
}

/** Paginate orders with status=completed|processing for sales history. */
export async function* paginateOrders(
  creds: WooCredentials,
  options?: { preview?: boolean },
): AsyncGenerator<WooOrder[]> {
  const perPage = options?.preview ? 5 : 100;
  let page = 1;
  while (true) {
    const { data, total } = await wooFetch<WooOrder[]>(creds, "/orders", {
      per_page: String(perPage),
      page:     String(page),
      status:   "completed,processing",
      after:    new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
    });
    if (data.length === 0) break;
    yield data;
    if (options?.preview) break;
    if (page * perPage >= total) break;
    page++;
  }
}
