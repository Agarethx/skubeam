-- ── WooCommerce connections ───────────────────────────────────────────────────
-- Stores WooCommerce credentials temporarily for async migration jobs.
-- Credentials are kept server-side only (service role access).

create table if not exists woo_connections (
  id             uuid        primary key default gen_random_uuid(),
  shop_id        text        not null,
  url            text        not null,
  consumer_key   text        not null,
  consumer_secret text       not null,
  product_count  integer,
  order_count    integer,
  analyzed_at    timestamptz default now(),
  migrated_at    timestamptz,
  constraint woo_connections_shop_id_key unique (shop_id)
);

alter table woo_connections enable row level security;

-- Only service role can access credentials
drop policy if exists "service_role_only" on woo_connections;
create policy "service_role_only" on woo_connections
  using (false);
