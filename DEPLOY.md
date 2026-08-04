# Deploy Hostinger + Supabase

A produção atual utiliza uma aplicação Node.js na Hostinger e banco relacional no Supabase.

## Variáveis de ambiente

Configure no ambiente da aplicação Node da Hostinger:

```env
SUPABASE_URL=https://SEU-PROJETO.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sua-service-role-key
SESSION_SECRET=uma-string-longa-aleatoria
```

O `PORT` normalmente é fornecido pela hospedagem. Localmente, o servidor usa a porta `3000` quando essa variável não está definida.

Nunca coloque a `SUPABASE_SERVICE_ROLE_KEY` no frontend, no GitHub ou em arquivos públicos.

## Configuração da aplicação Node

- Diretório da aplicação: raiz deste repositório.
- Arquivo de inicialização: `server.js`.
- Instalação: `npm install`.
- Inicialização: `npm start`.
- Arquivos públicos: diretório `public/`.

O `server.js` entrega o frontend e encaminha as rotas `/api/*` para a implementação da API. Embora essa implementação permaneça em `netlify/functions/api.js`, a produção não utiliza Netlify Functions.

## Supabase

O schema do projeto está em `supabase/schema.sql`. O arquivo `supabase/seed.sql` serve apenas para uma base inicial vazia.

Em uma produção com dados reais:

- não execute o seed novamente;
- não substitua tabelas inteiras;
- faça backup antes de qualquer migração;
- aplique somente alterações SQL revisadas e necessárias.

## Publicação

1. Gere um backup conforme [BACKUP.md](BACKUP.md).
2. Envie o commit aprovado ao GitHub.
3. Atualize a aplicação na Hostinger a partir da branch `main`.
4. Confirme que as variáveis de ambiente continuam cadastradas.
5. Reinstale dependências caso `package.json` ou `package-lock.json` tenham mudado.
6. Reinicie a aplicação Node.

## Validação após deploy

- confirmar login ADM e de uma nutricionista;
- confirmar a competência global e os dias úteis;
- confirmar que `Lançamentos` não permite trocar o mês;
- confirmar que `Meu Mês` permite consulta histórica;
- conferir os nomes abaixo de `Envios finais`;
- abrir uma escola e uma data no Painel ADM;
- validar a tela de exportação sem gerar arquivos desnecessários;
- verificar se o navegador não apresenta erros.

Para testes com escrita, prefira o HML descrito em [HML.md](HML.md).
