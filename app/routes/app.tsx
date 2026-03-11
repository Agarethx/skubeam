import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError, useNavigation } from "react-router";
import { useEffect } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { ensureShopExists } from "../models/sync.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await ensureShopExists(session.shop);
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

function AppLayout() {
  const shopify = useAppBridge();
  const navigation = useNavigation();

  // Clear the App Bridge loading indicator once the route transition settles.
  // useSkuBeamNavigate() calls shopify.loading(true) before navigating;
  // this effect turns it off when React Router finishes loading the new route.
  useEffect(() => {
    if (navigation.state === "idle") {
      shopify.loading(false);
    }
  }, [navigation.state, shopify]);

  return (
    <>
      <s-app-nav>
        <s-link href="/app">Home</s-link>
        <s-link href="/app/skus">SKUs</s-link>
      </s-app-nav>
      <Outlet />
    </>
  );
}

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();
  return (
    <AppProvider embedded apiKey={apiKey}>
      <AppLayout />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
