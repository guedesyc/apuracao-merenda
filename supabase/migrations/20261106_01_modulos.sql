-- =====================================================================
-- Portal Merenda · Migração 01 · Tabelas dos módulos novos
-- =====================================================================
-- O que este script faz:
--   * CRIA as tabelas dos módulos novos (Matriculados, Supervisão, Eventos,
--     Notificações, Inventário, Pedidos, Controle de KM e Capacitação);
--   * CRIA índices e liga o RLS (só o servidor, com a service_role, acessa);
--   * AMPLIA a regra de profiles.role para aceitar também 'adm'.
--
-- O que este script NÃO faz:
--   * não apaga tabela nem linha, não faz truncate, não altera nenhum dado
--     existente. As 11 tabelas atuais continuam iguais.
--   * a única alteração em tabela existente é a regra (check) de
--     profiles.role: a regra antiga ('admin','nutritionist') é trocada por
--     uma que aceita ('admin','nutritionist','adm'). Nenhuma linha muda.
--
-- Pode ser rodado mais de uma vez: tudo usa "if not exists".
-- Tudo roda numa transação: se algo falhar, nada é aplicado.
--
-- Como desfazer: ver o bloco "DESFAZER" no final (comentado).
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- Perfis: aceitar o perfil ADM (confere KM e Capacitação)
-- ---------------------------------------------------------------------
do $$
declare
  c record;
begin
  -- remove só as regras (check) de profiles que falam de "role"
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%role%'
  loop
    execute format('alter table public.profiles drop constraint %I', c.conname);
  end loop;
  alter table public.profiles
    add constraint profiles_role_check check (role in ('admin', 'nutritionist', 'adm'));
end $$;

-- ---------------------------------------------------------------------
-- Matriculados: 1 linha por escola; segments = { "card7": 158, "card9": 106 }
-- ---------------------------------------------------------------------
create table if not exists public.enrollments (
  school_id   text primary key references public.schools(id) on update cascade,
  segments    jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

-- ---------------------------------------------------------------------
-- Relatório de Supervisão
-- report_file = { id, name, path, size, type }; photos = [ {...}, ... ]
-- ---------------------------------------------------------------------
create table if not exists public.supervision_reports (
  id               text primary key,
  school_id        text not null references public.schools(id) on update cascade,
  nutritionist_id  text not null references public.profiles(id) on update cascade,
  report_date      date not null,
  notes            text not null default '',
  report_file      jsonb,
  photos           jsonb not null default '[]'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists supervision_reports_nutri_idx  on public.supervision_reports (nutritionist_id, report_date desc);
create index if not exists supervision_reports_school_idx on public.supervision_reports (school_id);

-- ---------------------------------------------------------------------
-- Eventos
-- A coordenação cria e aprova; a nutricionista confirma o atendimento e conclui.
-- Faturamento: só aprovados e realizados; alunos no card 10 quando student_billed.
-- ---------------------------------------------------------------------
create table if not exists public.events (
  id               text primary key,
  school_id        text not null references public.schools(id) on update cascade,
  nutritionist_id  text references public.profiles(id) on update cascade,
  request_date     date,
  event_date       date,
  event            text not null,
  audience         text not null default 'alunos' check (audience in ('alunos', 'adultos', 'ambos')),
  student_qty      integer not null default 0 check (student_qty >= 0),
  student_billed   boolean not null default true,
  adult_qty        integer not null default 0 check (adult_qty >= 0),
  adult_meal       text not null default '' check (adult_meal in ('', 'almoco', 'lanche')),
  has_fruit        boolean not null default false,
  food             text not null default '',
  notes            text not null default '',
  approval         text not null default 'pendente' check (approval in ('pendente', 'aprovado', 'reprovado')),
  approval_at      timestamptz,
  approval_by      text,
  attendance       text check (attendance in ('realizado', 'nao_realizado')),
  attendance_at    timestamptz,
  attendance_by    text,
  done             boolean not null default false,
  done_at          timestamptz,
  created_at       timestamptz not null default now(),
  created_by       text,
  updated_at       timestamptz not null default now()
);
create index if not exists events_event_date_idx on public.events (event_date);
create index if not exists events_nutri_idx      on public.events (nutritionist_id);
create index if not exists events_school_idx     on public.events (school_id);

-- ---------------------------------------------------------------------
-- Notificações (para escolas; responde a nutricionista responsável)
-- questions = [ { id, text } ]; final_file = { id, name, path, size, type }
-- school_ids vazio = notificação antiga, enviada direto para nutricionistas
-- ---------------------------------------------------------------------
create table if not exists public.notifications (
  id           text primary key,
  title        text not null,
  description  text not null default '',
  due_date     date,
  questions    jsonb not null default '[]'::jsonb,
  school_ids   text[] not null default '{}',
  target_ids   text[] not null default '{}',
  final_file   jsonb,
  created_by   text,
  created_at   timestamptz not null default now(),
  closed_at    timestamptz
);
create index if not exists notifications_targets_idx on public.notifications using gin (target_ids);
create index if not exists notifications_created_idx on public.notifications (created_at desc);

-- answers = { "<id da pergunta>": "resposta" }; attachments = [ {...} ]
create table if not exists public.notification_responses (
  notification_id  text not null references public.notifications(id) on delete cascade,
  nutritionist_id  text not null references public.profiles(id) on update cascade,
  answers          jsonb not null default '{}'::jsonb,
  attachments      jsonb not null default '[]'::jsonb,
  name             text,
  responded_at     timestamptz not null default now(),
  primary key (notification_id, nutritionist_id)
);
create index if not exists notification_responses_nutri_idx on public.notification_responses (nutritionist_id);

-- ---------------------------------------------------------------------
-- Inventário
-- ---------------------------------------------------------------------
create table if not exists public.inventory_items (
  id          text primary key,
  name        text not null,
  category    text not null check (category in ('Secos', 'Congelados', 'Produtos de Limpeza / Descartáveis', 'Aprender+')),
  unit        text not null default 'KG',
  price       numeric(12, 2) check (price is null or price >= 0),
  active      boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists inventory_items_category_idx on public.inventory_items (category, sort_order);

-- contagem: 1 linha por mês × escola × insumo
create table if not exists public.inventory_counts (
  month       text not null check (month ~ '^\d{4}-\d{2}$'),
  school_id   text not null references public.schools(id) on update cascade,
  item_id     text not null references public.inventory_items(id) on update cascade on delete cascade,
  quantity    numeric(14, 3) not null check (quantity >= 0),
  updated_at  timestamptz not null default now(),
  updated_by  text,
  primary key (month, school_id, item_id)
);
create index if not exists inventory_counts_school_idx on public.inventory_counts (school_id, month);

-- envio (trava o inventário da escola no mês)
create table if not exists public.inventory_submissions (
  month       text not null check (month ~ '^\d{4}-\d{2}$'),
  school_id   text not null references public.schools(id) on update cascade,
  sent_at     timestamptz not null default now(),
  sent_by     text,
  sent_by_id  text,
  items       integer not null default 0,
  primary key (month, school_id)
);

-- prazo por GRE (nome da rota, como aparece na tela; ligado a routes.name, que é único)
create table if not exists public.inventory_deadlines (
  month       text not null check (month ~ '^\d{4}-\d{2}$'),
  route_name  text not null references public.routes(name) on update cascade,
  deadline    date not null,
  primary key (month, route_name)
);

-- ---------------------------------------------------------------------
-- Pedidos
-- ---------------------------------------------------------------------
create table if not exists public.orders (
  id             text primary key,
  title          text not null,
  month          text not null check (month ~ '^\d{4}-\d{2}$'),
  delivery_date  date,
  file_name      text not null default '',
  sheet          text not null default '',
  unmatched      jsonb not null default '[]'::jsonb,
  skipped        integer not null default 0,
  created_at     timestamptz not null default now(),
  created_by     text
);
create index if not exists orders_month_idx on public.orders (month desc);

-- linhas do pedido (escola × item); id é sequencial dentro do pedido (l1, l2, ...)
create table if not exists public.order_lines (
  order_id         text not null references public.orders(id) on delete cascade,
  id               text not null,
  school_id        text not null references public.schools(id) on update cascade,
  item             text not null,
  unit             text not null default '',
  qty              numeric(14, 3) not null default 0,
  nutritionist_id  text references public.profiles(id) on update cascade,
  primary key (order_id, id)
);
create index if not exists order_lines_nutri_idx  on public.order_lines (nutritionist_id, order_id);
create index if not exists order_lines_school_idx on public.order_lines (school_id);

-- ajuste de cada nutricionista no pedido; adj_values = { "l216": 30, "l58": 4 }
create table if not exists public.order_adjustments (
  order_id         text not null references public.orders(id) on delete cascade,
  nutritionist_id  text not null references public.profiles(id) on update cascade,
  adj_values       jsonb not null default '{}'::jsonb,
  saved_at         timestamptz,
  sent_at          timestamptz,
  sent_by          text,
  finalized_at     timestamptz,
  finalized_by     text,
  primary key (order_id, nutritionist_id)
);

-- histórico: rascunho, envio, devolução e finalização
-- changes = [ { lineId, schoolId, item, unit, qty, from, to } ]
create table if not exists public.order_history (
  id               text primary key,
  order_id         text not null references public.orders(id) on delete cascade,
  at               timestamptz not null default now(),
  nutritionist_id  text references public.profiles(id) on update cascade,
  by_name          text,
  action           text not null check (action in ('draft', 'sent', 'returned', 'finalized')),
  changes          jsonb not null default '[]'::jsonb,
  imported         boolean not null default false
);
create index if not exists order_history_order_idx on public.order_history (order_id, at);
create index if not exists order_history_nutri_idx on public.order_history (nutritionist_id, at desc);

-- ---------------------------------------------------------------------
-- Controle de KM
-- ---------------------------------------------------------------------
create table if not exists public.km_vehicles (
  nutritionist_id  text primary key references public.profiles(id) on update cascade,
  plate            text not null,
  set_at           timestamptz not null default now(),
  set_by           text
);

-- 1 linha por mês × nutricionista
-- days = { "2026-11-03": { start, end, note } }   (nutricionista)
-- fuel = { "2026-11-03": { liters, value, by, at } } (abastecimento lançado pelo ADM)
-- review = { status: 'conferido'|'devolvido', note, by, at }
create table if not exists public.km_logs (
  month            text not null check (month ~ '^\d{4}-\d{2}$'),
  nutritionist_id  text not null references public.profiles(id) on update cascade,
  days             jsonb not null default '{}'::jsonb,
  fuel             jsonb not null default '{}'::jsonb,
  saved_at         timestamptz,
  sent_at          timestamptz,
  sent_by          text,
  review           jsonb,
  primary key (month, nutritionist_id)
);
create index if not exists km_logs_nutri_idx on public.km_logs (nutritionist_id, month);

-- ---------------------------------------------------------------------
-- Capacitação
-- ---------------------------------------------------------------------
-- files = anexos da coordenação (a nutricionista vê e baixa)
create table if not exists public.trainings (
  month       text primary key check (month ~ '^\d{4}-\d{2}$'),
  theme       text not null,
  deadline    date not null,
  files       jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  text
);

-- history = envios anteriores devolvidos [ { files, sentAt, review } ]
create table if not exists public.training_submissions (
  month            text not null references public.trainings(month) on update cascade,
  nutritionist_id  text not null references public.profiles(id) on update cascade,
  files            jsonb not null default '[]'::jsonb,
  notes            text not null default '',
  sent_at          timestamptz not null default now(),
  sent_by          text,
  review           jsonb,
  history          jsonb not null default '[]'::jsonb,
  primary key (month, nutritionist_id)
);

-- ---------------------------------------------------------------------
-- Segurança (mesmo padrão das tabelas atuais): RLS ligado e acesso só
-- pela service_role (o servidor). O navegador nunca acessa direto.
-- ---------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'enrollments', 'supervision_reports', 'events', 'notifications', 'notification_responses',
    'inventory_items', 'inventory_counts', 'inventory_submissions', 'inventory_deadlines',
    'orders', 'order_lines', 'order_adjustments', 'order_history',
    'km_vehicles', 'km_logs', 'trainings', 'training_submissions'
  ] loop
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

-- =====================================================================
-- DESFAZER (só se precisar voltar atrás; apaga as tabelas NOVAS e o que
-- foi gravado nelas — as 11 tabelas originais não são tocadas):
--
-- begin;
-- drop table if exists public.training_submissions, public.trainings,
--   public.km_logs, public.km_vehicles,
--   public.order_history, public.order_adjustments, public.order_lines, public.orders,
--   public.inventory_deadlines, public.inventory_submissions, public.inventory_counts, public.inventory_items,
--   public.notification_responses, public.notifications,
--   public.events, public.supervision_reports, public.enrollments;
-- -- antes de voltar a regra antiga, confira que não há perfil 'adm':
-- --   select count(*) from public.profiles where role = 'adm';
-- alter table public.profiles drop constraint if exists profiles_role_check;
-- alter table public.profiles add constraint profiles_role_check check (role in ('admin', 'nutritionist'));
-- commit;
-- =====================================================================
