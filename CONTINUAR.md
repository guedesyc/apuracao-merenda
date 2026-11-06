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
  `local/xlsx-helpers.js`, `public/modules.js` + `public/modern.css` (telas), `public/insights.js`
  (Histórico de Pedidos e abas do Analytics). Telas originais em `public/app.js`.
  Arquivos usam CRLF. Depois de mudar a API ou os dados, reinicie o servidor (ele guarda tudo em memória).
- Perfis: `admin` (coordenação, acesso a tudo), `adm` (confere KM e Capacitação), `nutritionist`.
- **Eventos**: a coordenação cria e **aprova** (coluna Aprovado); atendimento (Realizado/Não realizado) e "Concluído" são da nutri.
  Faturamento soma só eventos **aprovados e realizados**: alunos sempre no **card 10**, só se "Será faturado?" = Sim
  (`studentBilled`; eventos antigos sem o campo contam como Sim); adultos almoço → CARD 11, lanche → card 10.
  Valor contratual dos cards editável em Configurações → Valores dos cards (linha 172 da planilha da SMED).
- **Pedidos**: modelos fixos reconhecidos sozinhos — Secos/Congelados (aba Resumo, escolas na linha 8, insumos
  nas linhas abaixo; nome do insumo pode vir da aba Cadastro G:H pelo código) e Horti (abas Resumo ROTA 1 e 2,
  escolas na linha 3). Escolas casadas por nome (com aproximação). "Saturnino Cabral" é lida como ESCOLA MUNICIPAL AILTON SOARES
  (`SCHOOL_ALIASES` em `local/orders-reader.js`); Dr. Fernando Montanha Pondé não está cadastrada. A nutri ajusta (quantidade nova, em branco = sem ajuste) e a coordenação finaliza.
- **Item do pedido × insumo do inventário**: `inventoryItemFor()` em `public/modules.js` casa os nomes (sem acento, embalagem e
  palavras genéricas; aceita plural e 1 letra de diferença). Usado na coluna Inventário do Ajuste de Pedido e nos R$ do Analytics
  (valor unitário do insumo). Horti e itens sem correspondente ficam sem valor.
- **Inventário**: 4 categorias, admin ativa/inativa e define valor unitário e prazo por GRE; nutri envia e trava.
- **KM**: placa uma vez; KM inicial/final por dia + observação opcional (`days[data].note`); o ADM lança abastecimento (L) e
  valor por dia (`logs[mês][nutri].fuel[data]`, rota `km/fuel`) — o cálculo estimado de gasolina saiu; Enviar para ADM trava o mês; ADM/coordenação conferem ou
  devolvem. Ranking de KM no Analytics (segue o período do filtro).
- **Pedidos → Histórico** (admin e nutri): cada salvar/enviar/devolver/finalizar grava `order.history`
  com escola, item, previsto, antes e depois. Ajustes que já existiam viraram registros "anterior" (migração v5).
- **Analytics** (só admin) é um grupo do menu lateral com as seções: Faturamento, Controle de KM (custo da gasolina = KM ÷ km/l × R$/l;
  padrão R$ 6,20 e 10 km/l, editáveis em `settings`), Pedidos (previsto × final, por mês/nutri/escola/GRE/item),
  Inventário, Inventário × Pedidos × Matriculados (compara com a mediana da rede) e Notificações.
- **Notificações**: são para **escolas**; a nutricionista responsável pela escola responde. Ícone "!".
  Filtro por escola na lista. Notificações antigas (sem escola) continuam por nutricionista.
- **Capacitação**: tema, prazo e anexos (`training.files`, a nutri vê no topo da tela) em Configurações; nutri envia uma vez por mês; ADM/coordenação conferem.
- Celular primeiro: o sistema é usado principalmente no celular; confira toda tela em 375px. Confirmações usam
  `askConfirm()` (modal da aplicação), nunca `confirm()` do navegador.
- Dados fictícios de nov/dez (apuração, pedidos com ajustes, inventário, KM, eventos, notificações, supervisão,
  capacitação): `npm run local:demo`; para tirar só eles: `npm run local:demo-remove`. Tudo leva a marca `demo`.
  Pare o servidor antes. Cópia da base de antes dos dados fictícios: `local-data-backup-antes-demo/`.
- Testes: `npm test` (8 testes).
