-- =====================================================================
-- Registro de Gás: data da entrega (para o filtro De/Até).
--
-- Só ADICIONA uma coluna opcional em gas_records. Nenhum dado é apagado
-- ou alterado; registros antigos ficam com a data vazia (a tela usa o dia
-- do lançamento para eles).
-- Pode ser rodado mais de uma vez (if not exists).
--
-- DESFAZER: alter table public.gas_records drop column if exists delivery_date;
-- =====================================================================

begin;

alter table public.gas_records add column if not exists delivery_date date;
create index if not exists gas_records_date_idx on public.gas_records (delivery_date);

commit;
