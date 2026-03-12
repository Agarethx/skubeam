create table shops (
  id uuid primary key default gen_random_uuid(),
  shop_id text not null unique,
  plan text default 'trial',
  sku_limit int default 500,
  is_active boolean default true,
  installed_at timestamptz default now(),
  uninstalled_at timestamptz,
  settings jsonb default '{}'::jsonb
);

alter table shops enable row level security;
-- Sin policies públicas = solo service_role puede acceder
