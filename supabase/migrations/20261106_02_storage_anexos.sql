-- =====================================================================
-- Portal Merenda · Migração 02 · Bucket de anexos (Supabase Storage)
-- =====================================================================
-- Cria o bucket PRIVADO "anexos" para os arquivos dos módulos
-- (relatórios de supervisão, fotos, respostas de notificações,
-- documentos e material da capacitação).
--
-- Privado = ninguém baixa pelo link direto. O servidor (service_role)
-- grava os arquivos e gera links temporários para quem tem permissão.
-- Limite por arquivo: 25 MB (o mesmo da tela).
--
-- Não altera nada que já existe. Pode ser rodado mais de uma vez.
-- Desfazer: no painel, Storage → anexos → Delete bucket (só se estiver vazio).
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit)
values ('anexos', 'anexos', false, 26214400)
on conflict (id) do nothing;
