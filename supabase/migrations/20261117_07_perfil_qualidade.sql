-- =====================================================================
-- Portal Merenda · Migração 07 · Perfil "qualidade"
-- =====================================================================
-- Libera o perfil "qualidade": vê e confere o módulo de Capacitação com a
-- mesma tela da coordenação, e mais nada.
--
-- O que faz: troca a regra (check) de profiles.role para aceitar também
-- 'qualidade'. Só AMPLIA a regra: nenhum usuário ou dado é alterado.
--
-- Pode ser rodado mais de uma vez. Tudo numa transação.
--
-- DESFAZER (só se não existir nenhum usuário com esse perfil):
--   select count(*) from public.profiles where role = 'qualidade';  -- tem que dar 0
--   alter table public.profiles drop constraint if exists profiles_role_check;
--   alter table public.profiles add constraint profiles_role_check
--     check (role in ('admin', 'nutritionist', 'adm', 'manutencao'));
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
    add constraint profiles_role_check check (role in ('admin', 'nutritionist', 'adm', 'manutencao', 'qualidade'));
end $$;

commit;
