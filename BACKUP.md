# Backup manual do Supabase

O plano Free do Supabase nao oferece backup automatico. Este projeto possui uma rotina de backup local que exporta as tabelas usadas pela aplicacao para arquivos JSON.

## Preparar

Mantenha um arquivo `env.env` na raiz do projeto com:

```env
SUPABASE_URL=sua_url_do_supabase
SUPABASE_SERVICE_ROLE_KEY=sua_chave_service_role
```

Esse arquivo nunca deve ser enviado ao GitHub.

## Criar backup

No PowerShell, dentro da pasta do projeto:

```powershell
npm.cmd run backup:prod
```

O backup sera criado em `backups\DATA-E-HORA\`. Copie essa pasta para outro local, como HD externo ou armazenamento em nuvem.

## Conferir antes de restaurar

Para comparar um backup com o Supabase atual:

```powershell
npm.cmd run backup:audit
```

O relatorio sera salvo dentro da pasta do backup como `recovery-audit.json`.

## Restaurar itens ausentes

Depois de conferir o relatorio:

```powershell
npm.cmd run backup:restore-items
```

Essa rotina insere somente `entry_items` que existem no backup e continuam ausentes no Supabase. Ela nao apaga nem sobrescreve itens atuais.

Para usar outra pasta de backup:

```powershell
node scripts/audit_backup_recovery.js backups\2026-07-27T14-21-04-037Z
node scripts/restore_backup_items.js backups\2026-07-27T14-21-04-037Z
```

## Rotina recomendada

Faça um backup antes de qualquer alteracao estrutural ou manutencao importante e, enquanto o projeto estiver no plano Free, mantenha pelo menos uma copia semanal fora do computador.

Nao restaure o banco inteiro por cima do Supabase sem uma comparacao previa. Isso poderia substituir dados novos por dados antigos.
