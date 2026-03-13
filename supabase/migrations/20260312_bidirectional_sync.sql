-- Bidirectional Bsale ↔ Shopify sync support

-- 1. processed_webhooks — idempotency table for real-time webhook handlers
create table if not exists processed_webhooks (
  id           uuid primary key default gen_random_uuid(),
  shop_id      text not null,
  source       text not null,       -- 'shopify' | 'bsale'
  external_id  text not null,       -- 'order_{id}' | 'doc_{id}'
  processed_at timestamptz not null default now()
);

-- Unique constraint: one record per (shop, source, external_id)
create unique index if not exists processed_webhooks_shop_source_ext_idx
  on processed_webhooks (shop_id, source, external_id);

alter table processed_webhooks enable row level security;

create policy "Service role only" on processed_webhooks
  for all using (true) with check (true);

-- 2. bsale_variant_id on skus — populated during Bsale product sync
alter table skus
  add column if not exists bsale_variant_id text;

-- Index for reverse lookup (Bsale doc → Shopify variant)
create index if not exists skus_bsale_variant_id_idx
  on skus (shop_id, bsale_variant_id)
  where bsale_variant_id is not null;
