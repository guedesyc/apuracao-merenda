create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id text primary key,
  name text not null,
  username text not null unique,
  password_hash text not null,
  role text not null check (role in ('admin', 'nutritionist')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.routes (
  id text primary key,
  name text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.schools (
  id text primary key,
  row_number integer not null unique,
  code text,
  name text not null,
  short_name text not null,
  route_id text references public.routes(id) on update cascade,
  company text,
  address text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.nutritionist_schools (
  profile_id text not null references public.profiles(id) on delete cascade,
  school_id text not null references public.schools(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (profile_id, school_id)
);

create table if not exists public.cards (
  id text primary key,
  number integer not null unique,
  label text not null,
  description text,
  price numeric(12, 2) not null default 0,
  column_number integer not null,
  active boolean not null default true
);

create table if not exists public.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.entries (
  id text primary key,
  entry_date date not null,
  month text not null,
  school_id text not null references public.schools(id) on delete cascade,
  nutritionist_id text not null references public.profiles(id) on delete cascade,
  status text not null check (status in ('served', 'not_served')),
  reason text,
  notes text,
  updated_at timestamptz not null default now(),
  unique (entry_date, school_id, nutritionist_id)
);

create table if not exists public.entry_items (
  entry_id text not null references public.entries(id) on delete cascade,
  card_id text not null references public.cards(id) on delete cascade,
  quantity numeric(12, 2) not null,
  primary key (entry_id, card_id)
);

create table if not exists public.monthly_closures (
  id text primary key,
  month text not null,
  nutritionist_id text not null references public.profiles(id) on delete cascade,
  nutritionist_name text not null,
  status text not null check (status in ('partial', 'sent')),
  expected integer not null default 0,
  complete integer not null default 0,
  pending integer not null default 0,
  test boolean not null default false,
  sent_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (month, nutritionist_id)
);

create table if not exists public.exports (
  id text primary key,
  month text not null,
  filename text not null,
  rows integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id bigserial primary key,
  actor_id text references public.profiles(id) on delete set null,
  action text not null,
  entity text not null,
  entity_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.routes enable row level security;
alter table public.schools enable row level security;
alter table public.nutritionist_schools enable row level security;
alter table public.cards enable row level security;
alter table public.settings enable row level security;
alter table public.entries enable row level security;
alter table public.entry_items enable row level security;
alter table public.monthly_closures enable row level security;
alter table public.exports enable row level security;
alter table public.audit_logs enable row level security;

drop policy if exists "service role manages profiles" on public.profiles;
create policy "service role manages profiles" on public.profiles for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

drop policy if exists "service role manages routes" on public.routes;
create policy "service role manages routes" on public.routes for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

drop policy if exists "service role manages schools" on public.schools;
create policy "service role manages schools" on public.schools for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

drop policy if exists "service role manages nutritionist_schools" on public.nutritionist_schools;
create policy "service role manages nutritionist_schools" on public.nutritionist_schools for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

drop policy if exists "service role manages cards" on public.cards;
create policy "service role manages cards" on public.cards for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

drop policy if exists "service role manages settings" on public.settings;
create policy "service role manages settings" on public.settings for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

drop policy if exists "service role manages entries" on public.entries;
create policy "service role manages entries" on public.entries for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

drop policy if exists "service role manages entry_items" on public.entry_items;
create policy "service role manages entry_items" on public.entry_items for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

drop policy if exists "service role manages monthly_closures" on public.monthly_closures;
create policy "service role manages monthly_closures" on public.monthly_closures for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

drop policy if exists "service role manages exports" on public.exports;
create policy "service role manages exports" on public.exports for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

drop policy if exists "service role manages audit_logs" on public.audit_logs;
create policy "service role manages audit_logs" on public.audit_logs for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
