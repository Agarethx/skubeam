import { redirect } from "react-router";

/**
 * Server-side redirect that preserves ?shop= and ?host= from the
 * original request URL.
 *
 * Plain redirect("/app/skus") loses these params, which causes
 * Shopify App Bridge to lose its iframe context and logs "shop: null".
 *
 * Usage (in an action):
 *   return safeRedirect(request, "/app/skus");
 */
export function safeRedirect(request: Request, path: string): Response {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const host = url.searchParams.get("host");

  const params = new URLSearchParams();
  if (shop) params.set("shop", shop);
  if (host) params.set("host", host);

  const qs = params.toString();
  return redirect(qs ? `${path}?${qs}` : path);
}
