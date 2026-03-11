-- ============================================
-- EXTENSIONES
-- ============================================
create extension if not exists "uuid-ossp";
create extension if not exists "pg_trgm"; -- Búsqueda fuzzy de SKU codes

-- ============================================
-- SHOPS
-- ============================================
create table shops (
  id uuid primary key default gen_random_uuid(),
  shop_id text not null unique,         -- 'mi-tienda.myshopify.com'
  plan text default 'trial',            -- trial | starter | growth | pro
  is_active boolean default true,
  installed_at timestamptz default now(),
  uninstalled_at timestamptz,
  settings jsonb default '{}'::jsonb
);

alter table shops enable row level security;
-- Sin policies públicas = solo service_role puede acceder

-- ============================================
-- SKUs
-- ============================================
create table skus (
  id uuid primary key default gen_random_uuid(),
  shop_id text not null references shops(shop_id) on delete cascade,
  shopify_variant_id bigint unique,
  shopify_product_id bigint,
  sku_code text not null,
  barcode text,
  barcode_type text default 'CODE128',
  title text,
  vendor text,
  product_type text,
  tags text[],
  cost_price numeric(10,2),
  status text default 'active',          -- active | archived | draft
  created_at timestamptz default now(),
  updated_at timestamptz default now(),

  constraint skus_shop_sku_unique unique (shop_id, sku_code)
);

-- Índices
create index skus_shop_id_idx on skus(shop_id);
create index skus_shop_status_idx on skus(shop_id, status);
create index skus_sku_code_trgm on skus using gin(sku_code gin_trgm_ops);
create index skus_barcode_idx on skus(shop_id, barcode) where barcode is not null;

alter table skus enable row level security;
create policy "shop_isolation_skus" on skus
  for all using (shop_id = current_setting('app.shop_id', true));

-- ============================================
-- INVENTORY LEVELS
-- ============================================
create table inventory_levels (
  id uuid primary key default gen_random_uuid(),
  shop_id text not null,
  sku_id uuid not null references skus(id) on delete cascade,
  shopify_location_id bigint not null,
  location_name text,
  quantity int not null default 0,
  updated_at timestamptz default now(),

  unique(sku_id, shopify_location_id)
);

create index inventory_shop_sku_idx on inventory_levels(shop_id, sku_id);

alter table inventory_levels enable row level security;
create policy "shop_isolation_inventory" on inventory_levels
  for all using (shop_id = current_setting('app.shop_id', true));

-- ============================================
-- SALES HISTORY (para forecasting)
-- ============================================
create table sales_history (
  id uuid primary key default gen_random_uuid(),
  shop_id text not null,
  sku_id uuid not null references skus(id) on delete cascade,
  shopify_order_id bigint,
  quantity_sold int not null,
  sold_at timestamptz not null
);

create index sales_shop_sku_idx on sales_history(shop_id, sku_id);
create index sales_sold_at_idx on sales_history(shop_id, sold_at desc);

alter table sales_history enable row level security;
create policy "shop_isolation_sales" on sales_history
  for all using (shop_id = current_setting('app.shop_id', true));

-- ============================================
-- SYNC JOBS
-- ============================================
create table sync_jobs (
  id uuid primary key default gen_random_uuid(),
  shop_id text not null,
  type text not null,                    -- full_product_sync | inventory_sync | orders_sync
  status text default 'pending',         -- pending | running | completed | failed
  operation_id text,                     -- Shopify bulk operation ID
  records_processed int default 0,
  error_message text,
  started_at timestamptz default now(),
  completed_at timestamptz
);

alter table sync_jobs enable row level security;
create policy "shop_isolation_sync" on sync_jobs
  for all using (shop_id = current_setting('app.shop_id', true));

-- ============================================
-- FORECAST CONFIGS
-- ============================================
create table forecast_configs (
  shop_id text primary key references shops(shop_id) on delete cascade,
  reorder_lead_days int default 14,
  safety_stock_days int default 7,
  forecast_window_days int default 30,
  low_stock_threshold int default 10,
  dead_stock_days int default 90
);

alter table forecast_configs enable row level security;
create policy "shop_isolation_forecast" on forecast_configs
  for all using (shop_id = current_setting('app.shop_id', true));

-- ============================================
-- GDPR REQUESTS (auditoría)
-- ============================================
create table gdpr_requests (
  id uuid primary key default gen_random_uuid(),
  shop_id text not null,
  type text not null,                   -- data_request | customer_redact | shop_redact
  customer_id bigint,
  processed_at timestamptz default now()
);

alter table gdpr_requests enable row level security;
-- Sin policies públicas = solo service_role puede acceder

-- ============================================
-- VISTA MATERIALIZADA: SKU ANALYTICS
-- ============================================
create materialized view sku_analytics as
select
  s.id,
  s.shop_id,
  s.sku_code,
  s.title,
  s.vendor,
  s.status,
  s.cost_price,
  -- Stock total sumando todas las locations
  coalesce(
    (select sum(quantity) from inventory_levels il where il.sku_id = s.id),
    0
  ) as total_stock,
  -- Ventas últimos 30 días
  coalesce(
    (select sum(quantity_sold) from sales_history sh
     where sh.sku_id = s.id and sh.sold_at > now() - interval '30 days'),
    0
  ) as sold_30d,
  -- Ventas últimos 90 días
  coalesce(
    (select sum(quantity_sold) from sales_history sh
     where sh.sku_id = s.id and sh.sold_at > now() - interval '90 days'),
    0
  ) as sold_90d,
  -- Última venta
  (select max(sold_at) from sales_history sh where sh.sku_id = s.id) as last_sold_at
from skus s;

create unique index on sku_analytics(id);
create index sku_analytics_shop_idx on sku_analytics(shop_id);

-- ============================================
-- FUNCIÓN: refresh analytics (llamar con cron o Edge Function)
-- ============================================
create or replace function refresh_sku_analytics()
returns void as $$
begin
  refresh materialized view concurrently sku_analytics;
end;
$$ language plpgsql;
