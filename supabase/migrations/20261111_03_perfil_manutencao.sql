-- =====================================================================
-- Portal Merenda · Migração 03 · Perfil "manutenção"
-- =====================================================================
-- Libera um novo perfil de usuário, "manutencao", que só enxerga o
-- Controle de KM (com a mesma tela da nutricionista).
--
-- O que faz: troca a regra (check) de profiles.role para aceitar também
-- 'manutencao'. Só AMPLIA a regra: nenhum usuário ou dado é alterado.
--
-- Pode ser rodado mais de uma vez. Tudo numa transação.
--
-- DESFAZER (só se não existir nenhum usuário com esse perfil):
--   select count(*) from public.profiles where role = 'manutencao';  -- tem que dar 0
--   alter table public.profiles drop constraint if exists profiles_role_check;
--   alter table public.profiles add constraint profiles_role_check
--     check (role in ('admin', 'nutritionist', 'adm'));
-- =====================================================================

begin;

do $$
declare
  c record;
begin
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
    add constraint profiles_role_check check (role in ('admin', 'nutritionist', 'adm', 'manutencao'));
end $$;

commit;
