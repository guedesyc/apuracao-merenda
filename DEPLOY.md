# Deploy Netlify + Supabase

## Supabase

1. Crie um projeto no Supabase.
2. Abra o SQL Editor.
3. Execute o arquivo `supabase/schema.sql`.

O sistema usa a tabela `app_state` para guardar a base operacional em JSON. A primeira chamada a `/api/data` cria o registro inicial usando `demo-data.json`, caso ainda nao exista estado salvo.

## Netlify

Configure as variaveis de ambiente no site do Netlify:

```bash
SUPABASE_URL=https://SEU-PROJETO.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sua-service-role-key
```

Depois publique o repositorio. O arquivo `netlify.toml` ja define:

- pasta publicada: `public`
- functions: `netlify/functions`
- redirecionamento de `/api/*` para a function serverless
- inclusao da planilha modelo `data/templates/Pasta1.xlsx`

## Exportacao

Em producao, `/api/export` gera a planilha Excel dentro da function e devolve o arquivo para download no navegador. O mes exportado sempre vem do campo de competencia selecionado na tela.

## Seguranca

Use a `SUPABASE_SERVICE_ROLE_KEY` apenas como variavel de ambiente do Netlify. Nunca coloque essa chave em arquivos publicos ou no front-end.
