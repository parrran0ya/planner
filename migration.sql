-- Выполни один раз в Supabase SQL Editor

-- 1. Колонка для chat_id в Telegram (кто уже привязал бота)
alter table profiles add column if not exists telegram_chat_id bigint unique;

-- 2. Таблица одноразовых кодов привязки (код -> живёт 10 минут -> удаляется после использования)
create table if not exists telegram_link_codes (
  code text primary key,
  user_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Индекс на всякий случай для быстрой чистки просроченных кодов
create index if not exists telegram_link_codes_created_at_idx on telegram_link_codes(created_at);
