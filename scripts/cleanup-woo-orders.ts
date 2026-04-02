/**
 * scripts/cleanup-woo-orders.ts
 *
 * Deletes all Shopify orders tagged "migrado-woocommerce" from the store,
 * then resets the Supabase migration state so the next run starts clean.
 *
 * Usage:
 *   pnpm tsx scripts/cleanup-woo-orders.ts <ACCESS_TOKEN> [SUPABASE_URL] [SUPABASE_SERVICE_ROLE_KEY]
 *
 * The Supabase args are optional — if omitted, only the Shopify orders are
 * deleted (no Supabase reset).  When provided, resetOrderMigration() also
 * clears processed_webhooks and orders_migrated_at so the next run is clean.
 *
 * Example (full reset):
 *   pnpm tsx scripts/cleanup-woo-orders.ts shpat_xxx https://xxx.supabase.co eyJhbGci...
 */

const SHOP                = "terraoutdoorcl.myshopify.com";
const SHOP_ID             = "terraoutdoorcl.myshopify.com";
const ACCESS_TOKEN        = process.argv[2];
const SUPABASE_URL        = process.argv[3];
const SUPABASE_KEY        = process.argv[4];
const DELAY_MS            = 500;

const headers = {
  "X-Shopify-Access-Token": ACCESS_TOKEN ?? "",
  "Content-Type": "application/json",
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchOrders(): Promise<{ id: number }[]> {
  const all: { id: number }[] = [];
  let url: string | null =
    `https://${SHOP}/admin/api/2025-10/orders.json?tag=migrado-woocommerce&status=any&limit=250`;

  while (url) {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`GET orders failed: ${res.status} ${await res.text()}`);
    }

    const body = (await res.json()) as { orders: { id: number }[] };
    all.push(...body.orders);
    console.log(`[cleanup] fetched ${all.length} orders so far…`);

    // Follow Link header for pagination
    const link = res.headers.get("Link") ?? "";
    const next = link.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
    url = next;

    if (next) await sleep(DELAY_MS);
  }

  return all;
}

async function deleteOrder(id: number): Promise<void> {
  const res = await fetch(
    `https://${SHOP}/admin/api/2025-10/orders/${id}.json`,
    { method: "DELETE", headers },
  );
  if (!res.ok && res.status !== 404) {
    const body = await res.text();
    throw new Error(`DELETE order ${id} failed: ${res.status} ${body}`);
  }
}

/**
 * Resets Supabase migration state so the next run starts clean:
 *  - Removes all processed_webhooks entries for woo_order_migration
 *  - Clears orders_migrated_at on woo_connections
 */
async function resetOrderMigration(): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.log("[cleanup] no Supabase credentials provided — skipping DB reset.");
    return;
  }

  const headers = {
    "apikey":        SUPABASE_KEY,
    "Authorization": `Bearer ${SUPABASE_KEY}`,
    "Content-Type":  "application/json",
    "Prefer":        "return=minimal",
  };

  // Delete all woo_order_migration entries from processed_webhooks
  const pwRes = await fetch(
    `${SUPABASE_URL}/rest/v1/processed_webhooks?source=eq.woo_order_migration`,
    { method: "DELETE", headers },
  );
  if (!pwRes.ok) {
    throw new Error(`DELETE processed_webhooks failed: ${pwRes.status} ${await pwRes.text()}`);
  }
  console.log("[cleanup] processed_webhooks cleared for woo_order_migration");

  // Clear orders_migrated_at on woo_connections
  const wcRes = await fetch(
    `${SUPABASE_URL}/rest/v1/woo_connections?shop_id=eq.${SHOP_ID}`,
    {
      method:  "PATCH",
      headers,
      body:    JSON.stringify({ orders_migrated_at: null }),
    },
  );
  if (!wcRes.ok) {
    throw new Error(`PATCH woo_connections failed: ${wcRes.status} ${await wcRes.text()}`);
  }
  console.log(`[cleanup] orders_migrated_at reset for ${SHOP_ID}`);
}

async function main() {
  if (!ACCESS_TOKEN) {
    console.error("Usage: pnpm tsx scripts/cleanup-woo-orders.ts <ACCESS_TOKEN> [SUPABASE_URL] [SUPABASE_KEY]");
    process.exit(1);
  }

  console.log(`[cleanup] fetching orders tagged "migrado-woocommerce" from ${SHOP}…`);
  const orders = await fetchOrders();
  const total  = orders.length;

  if (total === 0) {
    console.log("[cleanup] no Shopify orders found — skipping delete.");
  } else {
    console.log(`[cleanup] found ${total} orders to delete.`);
    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];
      await deleteOrder(order.id);
      console.log(`[cleanup] deleted order ${order.id} (${i + 1}/${total})`);
      if (i < orders.length - 1) await sleep(DELAY_MS);
    }
    console.log(`[cleanup] done — ${total} Shopify orders deleted.`);
  }

  await resetOrderMigration();
  console.log("[cleanup] reset complete — ready for a clean re-run.");
}

main().catch((err) => {
  console.error("[cleanup] fatal error:", err);
  process.exit(1);
});
