# Apuração de Comandas

Sistema web para lançamento e acompanhamento mensal das refeições servidas nas escolas, com acesso separado para nutricionistas e coordenação.

Produção: [https://apuracaomerendaescolar.ygsystems.com.br](https://apuracaomerendaescolar.ygsystems.com.br)

## Arquitetura atual

- Aplicação Node.js hospedada na Hostinger e iniciada por `server.js`.
- Frontend estático em `public/`.
- API HTTP implementada em `netlify/functions/api.js` e carregada pelo servidor Node. O nome da pasta é histórico; a produção não depende da Netlify.
- Banco relacional no Supabase, com estrutura em `supabase/schema.sql`.
- Exportação mensal consolidada em Excel.

## Regras de acesso

### Coordenação

- Define a competência global e a quantidade de dias úteis no Painel ADM.
- A competência salva passa a valer para todas as nutricionistas.
- Acompanha preenchimentos por rota, nutricionista, escola e data.
- Visualiza valores, cards, quantidades, pendências e nutricionistas que realizaram o envio final.
- Administra nutricionistas, escolas, rotas e vínculos.
- Exporta a consolidação selecionando o mês desejado.
- Usa a `Exportação - Máximo` para gerar uma planilha com o maior valor diário de cada card, por escola e por mês, reunindo todos os meses para filtragem no Excel.

### Nutricionista

- Em `Lançamentos`, trabalha somente na competência global definida pela coordenação.
- Não pode alterar o mês nessa tela.
- Escolas e datas começam recolhidas e podem ser abertas individualmente.
- Pode salvar o preenchimento em andamento.
- O envio final só é liberado quando todas as datas de todas as escolas vinculadas estiverem registradas.
- Depois do envio final, a competência fica bloqueada para edição.
- Em `Meu Mês`, pode selecionar a competência atual ou meses anteriores apenas para consulta.
- No resumo `Total por escola`, cada card pode ser aberto para consultar as quantidades registradas dia a dia.
- Rascunhos e salvamentos concorrentes são reconciliados por data, escola e nutricionista, preservando o registro já existente no banco.

## Como rodar localmente

Instale as dependências e inicie o servidor:

```bash
npm install
npm start
```

Por padrão, o sistema abre em `http://localhost:3000`.

Para conectar ao Supabase, configure as variáveis descritas em `.env.example` no ambiente do processo Node.

No PowerShell, caso a execução de `npm.ps1` esteja bloqueada, use `npm.cmd`:

```powershell
npm.cmd install
npm.cmd start
```

## Homologação isolada

Para testar sem acessar o Supabase de produção, abra:

```text
http://localhost:3000/?hml=1
```

O HML usa dados fictícios e salva as alterações somente no navegador. Consulte [HML.md](HML.md) para acessos e instruções completas.

## Produção e segurança

- Nunca publique `SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SECRET`, `.env` ou `env.env`.
- Não execute `supabase/seed.sql` sobre uma produção que já contém dados reais.
- Faça backup antes de alterações estruturais ou manutenções importantes.
- A chave única dos lançamentos é `data + escola + nutricionista`; o backend reutiliza o `id` existente antes de salvar e não exige alteração de schema para isso.
- Consulte [DEPLOY.md](DEPLOY.md) para a configuração da Hostinger e [BACKUP.md](BACKUP.md) para a rotina de backup do Supabase.
