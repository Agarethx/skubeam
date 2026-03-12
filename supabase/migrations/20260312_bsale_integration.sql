-- Bsale integration columns on shops table
alter table shops
  add column if not exists bsale_token text,
  add column if not exists bsale_last_sync timestamptz;
