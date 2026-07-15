# Deploy Netlify + Supabase

## Supabase

1. Crie um projeto no Supabase.
2. Abra o SQL Editor.
3. Execute `supabase/schema.sql`.
4. Execute `supabase/seed.sql`.

O banco usa tabelas relacionais para perfis, rotas, escolas, cards, vínculos, lançamentos, fechamentos e exportações. A tela não acessa o banco diretamente; tudo passa pelas Netlify Functions.

## Variáveis do Netlify

Configure no site do Netlify:

```bash
SUPABASE_URL=https://SEU-PROJETO.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sua-service-role-key
SESSION_SECRET=uma-string-longa-aleatoria
```

Nunca coloque a `SUPABASE_SERVICE_ROLE_KEY` no front-end ou em arquivos públicos.

## Teste local antes de deploy

1. Instale as dependências:

   ```bash
   npm install
   ```

2. Configure as variáveis em `.env` local.

3. Rode com Netlify CLI:

   ```bash
   npx netlify dev
   ```

4. Teste:
   - login admin;
   - login de uma nutricionista;
   - se a nutricionista só vê escolas dela;
   - salvar lançamento;
   - salvar sem atendimento;
   - alterar vínculo no ADM;
   - exportar Excel.

## Exportação

Em produção, `/api/export` gera a planilha Excel dentro da Function e devolve o arquivo para download no navegador.
