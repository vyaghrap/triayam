-- TriAyam Stall Tracker - database schema
-- Paste this whole file into Supabase > SQL Editor > New query, then click RUN.
-- It is safe to run more than once.

-- ---------- tables ----------
create table if not exists app_meta (
  id      int primary key default 1 check (id = 1),
  rev     bigint not null default 1,      -- bumped on every change; lets devices detect updates cheaply
  counter bigint not null default 1000    -- last invoice sequence number
);
insert into app_meta (id) values (1) on conflict do nothing;

create table if not exists brand (
  id   int primary key default 1 check (id = 1),
  data jsonb not null default '{}'::jsonb
);
insert into brand (id, data) values (1, '{}'::jsonb) on conflict do nothing;

create table if not exists app_users (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  email         text not null unique,
  password_hash text not null,
  role          text not null check (role in ('Staff', 'Admin', 'SuperAdmin')),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

create table if not exists sessions (
  key_hash text primary key,
  user_id  uuid not null references app_users (id) on delete cascade,
  exp      timestamptz not null
);
create index if not exists sessions_user_idx on sessions (user_id);

create table if not exists login_attempts (
  key   text primary key,
  count int not null default 0,
  until timestamptz not null
);

create table if not exists catalog (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  category   text not null,
  price      numeric(12, 2) not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists transactions (
  id             uuid primary key default gen_random_uuid(),
  invoice_no     text not null unique,
  executive      text not null default '',
  version        int  not null default 1,
  customer_name  text not null,
  customer_phone text not null,
  date_time      text not null,                -- 'YYYY-MM-DDTHH:MM' as entered at the stall
  items          jsonb not null default '[]'::jsonb,
  subtotal       numeric(12, 2) not null default 0,
  discount       numeric(12, 2) not null default 0,
  total          numeric(12, 2) not null default 0,
  amount_paid    numeric(12, 2) not null default 0,
  gst_rate       numeric(6, 2)  not null default 18,
  payment_method text not null default 'UPI',
  payment_status text not null default 'Paid',
  txn_ref        text not null default '',
  created_at     timestamptz not null default now()
);
create index if not exists transactions_date_idx on transactions (date_time desc);

-- ---------- change counter ----------
create or replace function bump_rev() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update app_meta set rev = rev + 1 where id = 1;
  return null;
end $$;

drop trigger if exists t_rev on app_users;
create trigger t_rev after insert or update or delete on app_users    for each statement execute function bump_rev();
drop trigger if exists t_rev on brand;
create trigger t_rev after insert or update or delete on brand        for each statement execute function bump_rev();
drop trigger if exists t_rev on catalog;
create trigger t_rev after insert or update or delete on catalog      for each statement execute function bump_rev();
drop trigger if exists t_rev on transactions;
create trigger t_rev after insert or update or delete on transactions for each statement execute function bump_rev();

-- ---------- atomic invoice numbering ----------
create or replace function next_counter() returns bigint
language sql security definer set search_path = public as $$
  update app_meta set counter = counter + 1 where id = 1 returning counter;
$$;

create or replace function bump_counter(min_val bigint) returns bigint
language sql security definer set search_path = public as $$
  update app_meta set counter = greatest(counter, min_val) where id = 1 returning counter;
$$;

-- ---------- lock everything down ----------
-- The website never talks to the database directly; only the Netlify function does,
-- using the secret key. Turning on row-level security with no policies means the
-- public (publishable / anon) key can read and write NOTHING.
alter table app_meta        enable row level security;
alter table brand           enable row level security;
alter table app_users       enable row level security;
alter table sessions        enable row level security;
alter table login_attempts  enable row level security;
alter table catalog         enable row level security;
alter table transactions    enable row level security;

revoke all on app_meta, brand, app_users, sessions, login_attempts, catalog, transactions from anon, authenticated;
revoke execute on function next_counter(), bump_counter(bigint), bump_rev() from public, anon, authenticated;
