# Homologacao offline

Use este modo para testar telas e fluxos sem acessar o Supabase de producao.

## Como abrir

Rode o servidor local:

```bash
npm run dev
```

Abra:

```text
http://localhost:3000/?hml=1
```

O modo HML usa `public/hml-data.json`, salva alteracoes apenas no `localStorage`
do navegador e nao chama `/api/*` real. Para limpar os dados de teste desse
navegador, abra:

```text
http://localhost:3000/?hml=1&reset=1
```

## Acessos ficticios

- Coordenacao: `admin` / `adminhml`
- Nutricionista: `nutri` / `nutrihml`
- Apoio: `apoio` / `apoiohml`

## Garantia de isolamento

No modo HML, login, leitura, salvamento e exportacao usam a API estatica no
navegador. O backend Node e o Supabase de producao nao recebem escrita nenhuma.

## Antes de mexer em producao

Gere um backup manual local do Supabase:

```bash
npm run backup:prod
```

No PowerShell do Windows, se `npm` for bloqueado pela politica de execucao,
use:

```powershell
npm.cmd run backup:prod
```

Esse comando apenas le tabelas e salva arquivos JSON em `backups/`, que nao e
versionado no GitHub.

Para comparar as rotas validadas com o cadastro atual de producao, rode:

```bash
npm run routes:preview
```

Ou, no PowerShell:

```powershell
npm.cmd run routes:preview
```

Esse comando apenas le o Supabase e gera um relatorio em `route-previews/`.
Nenhuma alteracao de rota ou vinculo deve ser aplicada antes de esse relatorio
ficar sem escolas ou nutricionistas pendentes de correspondencia.
