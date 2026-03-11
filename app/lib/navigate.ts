import { useNavigate, useLocation } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";

/**
 * Hook for navigating within SkuBeam's embedded Shopify context.
 *
 * App Bridge v4 (ShopifyGlobal) does NOT expose a `navigate()` method —
 * confirmed against the @shopify/app-bridge-types ShopifyGlobal interface.
 * The correct pattern is:
 *   1. React Router `useNavigate()` for SPA client-side navigation
 *      (no page reload → App Bridge iframe context always preserved).
 *   2. `shopify.loading(true)` to light up the Shopify admin loading bar
 *      while the new route's loader runs.
 *   3. Preserve `?shop=` and `?host=` as a safety net for any hard
 *      reload that could be triggered by an ancestor.
 *
 * Usage:
 *   const navigate = useSkuBeamNavigate();
 *   navigate("/app/skus");
 */
export function useSkuBeamNavigate() {
  const shopify = useAppBridge();
  const rrNavigate = useNavigate();
  const location = useLocation();

  return (path: string) => {
    // Build target preserving auth params
    const current = new URLSearchParams(location.search);
    const shop = current.get("shop");
    const host = current.get("host");

    const preserved = new URLSearchParams();
    if (shop) preserved.set("shop", shop);
    if (host) preserved.set("host", host);

    const qs = preserved.toString();
    const target = qs ? `${path}?${qs}` : path;

    // Signal App Bridge to show the Shopify admin loading indicator.
    // React Router's transition will complete synchronously (pushState),
    // so the async loader running in the new route naturally follows.
    shopify.loading(true);

    // SPA navigation: pushState only, no iframe reload.
    // App Bridge postMessage channel stays alive.
    rrNavigate(target);
  };
}

/**
 * Returns `?shop=X&host=Y` (or `""`) from the current URL, ready to
 * append to static hrefs so hard-navigation links keep their context.
 *
 * Use this for `s-link` / `<a>` elements whose `href` must be a string:
 *   const qs = useShopifyParams();
 *   <s-link href={`/app/skus/${id}${qs}`}>...</s-link>
 */
export function useShopifyParams(): string {
  const location = useLocation();
  const current = new URLSearchParams(location.search);
  const shop = current.get("shop");
  const host = current.get("host");

  const preserved = new URLSearchParams();
  if (shop) preserved.set("shop", shop);
  if (host) preserved.set("host", host);

  const qs = preserved.toString();
  return qs ? `?${qs}` : "";
}
