create table shopify_sessions (
  id text primary key,
  shop text not null,
  state text not null,
  is_online boolean default false,
  scope text,
  expires timestamptz,
  access_token text,
  user_id text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Índice para buscar sesiones por shop (usado en findSessionsByShop)
create index shopify_sessions_shop_idx on shopify_sessions(shop);

-- RLS: las sesiones son internas, solo acceso via service_role
alter table shopify_sessions enable row level security;
-- Sin políticas públicas = nadie accede salvo service_role
