import type { HeadersFunction } from "react-router";
import { Outlet } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

/**
 * Layout for /app/integrations/bsale and its children.
 * Content lives in _index.tsx (main page) and diff.tsx (publish diff page).
 */
export default function BsaleLayout() {
  return <Outlet />;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
