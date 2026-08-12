import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getBsaleDocumentsPage } from "../integrations/bsale/documents.server";

/** GET /api/bsale/documents?q=&page= — listado paginado de documentos emitidos. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);

  return getBsaleDocumentsPage(session.shop, {
    q:    url.searchParams.get("q") ?? "",
    page: Number(url.searchParams.get("page") ?? 1) || 1,
  });
};
