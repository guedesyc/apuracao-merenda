# Apuração de Comandas

Sistema web para lançamento diário/semanal de refeições por escola e cardápio, com painel administrativo, configuração de responsáveis e exportação mensal consolidada para Excel.

## Arquitetura

- Frontend estático em `public/`.
- API em Netlify Functions, em `netlify/functions`.
- Banco relacional no Supabase, com schema em `supabase/schema.sql`.
- Seed inicial em `supabase/seed.sql`.
- Exportação Excel gerada pela Function usando `data/templates/Pasta1.xlsx`.

## Protótipo online

O GitHub Pages serve apenas como protótipo visual:

[https://guedesyc.github.io/apuracao-merenda/](https://guedesyc.github.io/apuracao-merenda/)

A produção real deve ser publicada no Netlify com Supabase configurado.

## Como rodar localmente

1. Instale as dependências:

   ```bash
   npm install
   pip install -r requirements.txt
   ```

2. Para o modo local antigo, gere a base inicial:

   ```bash
   python scripts/import_seed.py
   npm run dev
   ```

3. Para simular produção, configure `.env` e rode:

   ```bash
   npx netlify dev
   ```

## Produção

Veja [DEPLOY.md](DEPLOY.md) para configurar Supabase, variáveis do Netlify e teste local com Netlify CLI antes do deploy.

## Acesso inicial

O seed cria os usuários iniciais para teste. Antes de uso real, a coordenação deve trocar as senhas pelo painel ADM.
