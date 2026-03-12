import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  checkAndAdvanceBulkSync,
  startBulkSync,
  startOrdersSync,
} from "../models/sync.server";

// GET /api/sync  — poll status and advance if complete
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const job = await checkAndAdvanceBulkSync(admin, session.shop);
  return { job };
};

// POST /api/sync — start a new sync
// Body: type=products (default) | type=orders
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const type = (formData.get("type") as string) || "products";

  const job =
    type === "orders"
      ? await startOrdersSync(admin, session.shop)
      : await startBulkSync(admin, session.shop);

  return { job };
};
