-- TriayamPay - add multiple stall locations
-- Paste this whole file into Supabase > SQL Editor > New query, then click RUN.
-- Safe to run more than once. Your existing sales are kept and become "Direct Sale" (no stall).

create table if not exists stalls (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

alter table transactions add column if not exists stall_id uuid references stalls (id) on delete set null;
-- name saved on a sale when its stall is deleted, so the sale keeps its location
alter table transactions add column if not exists stall_name text not null default '';
-- deleting a stall keeps its sales (older runs of this file created the link as "restrict")
alter table transactions drop constraint if exists transactions_stall_id_fkey;
alter table transactions add constraint transactions_stall_id_fkey foreign key (stall_id) references stalls (id) on delete set null;
create index if not exists transactions_stall_idx on transactions (stall_id);

drop trigger if exists t_rev on stalls;
create trigger t_rev after insert or update or delete on stalls for each statement execute function bump_rev();

alter table stalls enable row level security;
revoke all on stalls from anon, authenticated;
grant all on stalls to service_role;

-- make the website pick up the change on every device
update app_meta set rev = rev + 1 where id = 1;
