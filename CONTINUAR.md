# Continuar em outro computador

Este repositório (`guedesyc/apuracao-merenda-modulos`, **privado**) é a versão local com os novos
módulos. Ele **não** é o repositório de produção (`guedesyc/apuracao-merenda`) e não publica nada.

## Primeira vez no outro computador

Precisa de Node 18 ou mais novo.

```bash
git clone https://github.com/guedesyc/apuracao-merenda-modulos.git apuracao-merenda
cd apuracao-merenda
git checkout local-modulos
npm install
```

Dados locais (escolas, apurações de teste, eventos, KM, capacitações, anexos): descompacte o
`local-data-AAAAMMDD.zip` **dentro da pasta do projeto**, de modo que fique `apuracao-merenda/local-data/db.json`.
A pasta `local-data/` não vai para o Git (está no `.gitignore`).

Sem o zip, `npm run local` gera uma base nova de demonstração automaticamente.

```bash
npm run local
```

Abra http://localhost:3000. Acessos em `LOCAL.md` (admin/admin123, adm/adm123, nutricionistas/nutri123).

## Sincronizar entre os computadores

- Antes de começar: `git pull`
- Ao terminar: `git add -A && git commit -m "..." && git push`
- Os dados de `local-data/` não sincronizam pelo Git: se precisar deles do outro lado, gere um novo zip.

## Para o Claude retomar o trabalho

Leia `LOCAL.md` (módulos e regras). Resumo das decisões já tomadas com o usuário:

- **Nunca mexer na produção** (Supabase/Hostinger/repo `guedesyc/apuracao-merenda`). Tudo roda em modo local
  (`server.js --local`, dados em `local-data/`). O usuário revisa antes de qualquer commit.
- Respostas em **português do Brasil**.
- Código novo: `local/modules-api.js` (API `/api/m/*`), `local/orders-reader.js` (leitura de pedidos),
  `local/xlsx-helpers.js`, `public/modules.js` + `public/modern.css` (telas). Telas originais em `public/app.js`.
  Arquivos usam CRLF. Depois de mudar a API ou os dados, reinicie o servidor (ele guarda tudo em memória).
- Perfis: `admin` (coordenação, acesso a tudo), `adm` (confere KM e Capacitação), `nutritionist`.
- **Eventos**: a coordenação só cria; aprovação, atendimento (Realizado/Não realizado) e "Concluído" são da nutri.
  Faturamento soma só eventos **aprovados e realizados**: alunos no card de aluno mais caro da escola
  (segmentos de Matriculados × valor contratual do card, editável em Configurações → Valores dos cards,
  escrito na linha 172 da planilha da SMED); adultos almoço → CARD 11, lanche → card 10.
- **Pedidos**: modelos fixos reconhecidos sozinhos — Secos/Congelados (aba Resumo, escolas na linha 8, insumos
  nas linhas abaixo; nome do insumo pode vir da aba Cadastro G:H pelo código) e Horti (abas Resumo ROTA 1 e 2,
  escolas na linha 3). Escolas casadas por nome (com aproximação). Saturnino Cabral e Dr. Fernando Montanha
  Pondé não estão cadastradas. A nutri ajusta (quantidade nova, em branco = sem ajuste) e a coordenação finaliza.
- **Inventário**: 4 categorias, admin ativa/inativa e define valor unitário e prazo por GRE; nutri envia e trava.
- **KM**: placa uma vez; KM inicial/final por dia; Enviar para ADM trava o mês; ADM/coordenação conferem ou
  devolvem. Ranking de KM no Analytics (segue o período do filtro).
- **Capacitação**: tema e prazo em Configurações; nutri envia uma vez por mês; ADM/coordenação conferem.
- Testes: `npm test` (8 testes).
