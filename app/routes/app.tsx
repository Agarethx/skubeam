import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError, useNavigation } from "react-router";
import { useEffect } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useTranslation } from 'react-i18next';
import { authenticate } from "../shopify.server";
import { upsertShop } from "../models/shop.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await upsertShop(session.shop);
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

function AppLayout() {
  const shopify = useAppBridge();
  const navigation = useNavigation();
  const { t } = useTranslation();

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
        <s-link href="/app">{t('nav.home')}</s-link>
        <s-link href="/app/skus">{t('nav.skus')}</s-link>
        <s-link href="/app/forecast">{t('nav.forecast')}</s-link>
        <s-link href="/app/analytics">{t('nav.analytics')}</s-link>
        <s-link href="/app/assistant">{t('nav.assistant')}</s-link>
        <s-link href="/app/integrations">{t('nav.integrations')}</s-link>
        <s-link href="/app/billing">{t('nav.billing')}</s-link>
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
