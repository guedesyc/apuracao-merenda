-- =====================================================================
-- Portal Merenda · Migração 04 · Registro de Gás e Gêneros
-- =====================================================================
-- Cria 3 tabelas novas (só ADICIONA; nenhuma tabela atual é alterada):
--   gas_prices           valores de referência do gás (P13 e P45)
--   gas_records          registros de entrega de gás por escola e mês
--   genero_submissions   arquivo de gêneros enviado por nutricionista e mês
--
-- Pode ser rodado mais de uma vez: tudo usa "if not exists" / "on conflict".
-- Tudo roda numa transação: se algo falhar, nada é aplicado.
--
-- DESFAZER (só se as tabelas novas ainda estiverem vazias ou se aceitar perder esses registros):
--   drop table if exists public.genero_submissions, public.gas_records, public.gas_prices;
-- =====================================================================

begin;

create table if not exists public.gas_prices (
  gas_type    text primary key check (gas_type in ('P13', 'P45')),
  price       numeric(12, 2) not null check (price >= 0),
  updated_at  timestamptz
);

insert into public.gas_prices (gas_type, price, updated_at)
values ('P13', 142.00, now()), ('P45', 516.00, now())
on conflict (gas_type) do nothing;

create table if not exists public.gas_records (
  id               text primary key,
  school_id        text not null references public.schools(id) on update cascade,
  nutritionist_id  text references public.profiles(id) on update cascade,
  month            text not null check (month ~ '^\d{4}-\d{2}$'),
  quantity         integer not null check (quantity between 1 and 5),
  gas_type         text not null references public.gas_prices(gas_type) on update cascade,
  unit_value       numeric(12, 2) not null check (unit_value >= 0),
  total            numeric(14, 2) not null check (total >= 0),
  created_at       timestamptz not null default now(),
  created_by       text,
  updated_at       timestamptz not null default now(),
  updated_by       text
);
create index if not exists gas_records_month_idx on public.gas_records (month);
create index if not exists gas_records_school_idx on public.gas_records (school_id, month);
create index if not exists gas_records_nutri_idx on public.gas_records (nutritionist_id, month);

-- files = [ { id, name, path, size, type } ] (um arquivo só); review = { status, note, by, at }
create table if not exists public.genero_submissions (
  month             text not null check (month ~ '^\d{4}-\d{2}$'),
  nutritionist_id   text not null references public.profiles(id) on update cascade,
  files             jsonb not null default '[]'::jsonb,
  sent_at           timestamptz not null default now(),
  sent_by           text,
  review            jsonb,
  history           jsonb not null default '[]'::jsonb,
  primary key (month, nutritionist_id)
);

-- Segurança igual às demais tabelas: RLS ligado; só o servidor (service_role) acessa.
do $$
declare
  t text;
begin
  foreach t in array array['gas_prices', 'gas_records', 'genero_submissions'] loop
    execute format('alter table public.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = 'service role manages ' || t) then
      execute format(
        'create policy %I on public.%I for all using (auth.role() = ''service_role'') with check (auth.role() = ''service_role'')',
        'service role manages ' || t, t
      );
    end if;
  end loop;
end $$;

commit;
