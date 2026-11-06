# Versão local (sem Supabase e sem Hostinger)

Esta cópia roda 100% no computador. Nada é enviado ao Supabase nem à Hostinger:
o repositório clonado está **sem remote** (`git remote -v` vazio) e na branch `local-modulos`.

## Como rodar

```bash
npm install
npm run local
```

Abra `http://localhost:3000`.

Na primeira execução a base é gerada automaticamente em `local-data/` (ignorada pelo Git).

| Comando | O que faz |
|---|---|
| `npm run local` | Sobe o servidor em modo local |
| `npm run local:reset` | Recria a base: cadastros reais + lançamentos fictícios de ago–out/2026 |
| `npm run local:regen-entries` | Regera só os lançamentos fictícios (ago–out/2026) mantendo o resto da base |
| `npm run local:reset-empty` | Recria a base só com cadastros reais (sem lançamentos) |

Pare o servidor antes de rodar um `local:reset`.

## Acessos de teste (apenas locais)

- Coordenação: `admin` / `admin123`
- ADM (confere KM e Capacitação): `adm` / `adm123` — novos usuários ADM em Configurações → Perfil ADM
- Nutricionistas: usuário de cada uma (ex.: `dione.cibele`, `tassia.virginia`, `leticia.miranda`) / `nutri123`

## De onde vêm os dados

- Escolas (165), cards e endereços: `public/demo-data.json`
- Nutricionistas, GREs e vínculos escola ↔ nutricionista: `data/official-route-assignments.json`
  (os 165 vínculos oficiais foram encontrados; LETICIA MIRANDA substitui EVELYN LOUISE)
- Matriculados por escola e segmento: `data/matriculados-2026.json` (da planilha "ME SSA- NÚMERO DE MATRICULADOS.xlsx")
- Catálogo de insumos: `data/inventario-2026.json` (da "Planilha de inventario 2026.xlsx", aba "Planilha de Inventário (2)")
- Lançamentos de ago–out/2026 são **fictícios** (não vêm da produção): cada card recebe por dia entre ~78% e 97% dos matriculados reais da escola.
  A competência ativa é nov/2026 (vazia, para testar o preenchimento).

## O que mudou em relação à produção

- `local/local-supabase.js`: cliente que imita o supabase-js gravando em `local-data/db.json`.
  `netlify/functions/api.js` usa esse cliente quando `LOCAL_MODE=1` ou quando não há `SUPABASE_URL`.
- `local/modules-api.js`: API dos novos módulos (`/api/m/*`), dados em `local-data/modules.json`,
  anexos em `local-data/uploads/`.
- `public/modules.js` e `public/modern.css`: novos módulos, novo login, nova sidebar.
- `public/app.js`: login, shell e roteamento atualizados; telas originais preservadas.

## Módulos

Regra de eventos no faturamento: entram apenas os eventos **aprovados e confirmados como realizados** pela nutricionista, com data no mês. Alunos vão sempre para o **card 10** (DESJEJUM/LANCHE), e só quando o campo **Será faturado?** do evento = Sim (com Não, os alunos não são calculados nem faturados); adultos vão para o **CARD 11** (almoço) ou **card 10** (lanche). A planilha ganha a aba "Eventos no faturamento" com o detalhe.


| Módulo | Admin | Nutricionista |
|---|---|---|
| Apurações / Lançamentos / Meu mês / Painel | como antes | como antes |
| Exportações | uma tela com: **Exportar - Faturamento** (modelo SMED + eventos aprovados do mês), Máximo, Sem Atendimento, **Inventário Geral** (aba geral + uma por nutricionista, por rota) e **Eventos** (uma aba por mês) | — |
| Relatório de Supervisão | vê todas, pode registrar por qualquer uma | registra data + relatório + fotos das suas escolas |
| Analytics | filtros por nutricionista, região, escola, período, card; comparação sem limite ("Comparar todos"); ranking de **KM por nutricionista** com o abastecimento real lançado pelo ADM; Pedidos em **R$** com colunas ordenáveis (clique no título); Inventário × Pedidos × Matriculados com Pedido e Estoque em R$ | — |
| Matriculados | preenche a tabela por segmento; filtro por nutricionista, GRE e segmento com o total de alunos da seleção | visualiza as suas escolas |
| Eventos | cadastra (escola, nutricionista responsável, público alvo **Alunos / Adultos / Alunos/Adultos** com quantidades separadas, refeição dos adultos, possui fruta, aprovado, alimentação, observações), edita (não aprova nem conclui). Contador no menu | vê os eventos em que é responsável e faz toda a tratativa: **Aprovado**, atendimento Realizado / Não Realizado e **Concluído**; recebe as pendências |
| Notificações | cria perguntas → recebe respostas → anexa arquivo final | responde |
| Inventário de Insumos | ativa/inativa itens (Secos, Congelados, Produtos de Limpeza / Descartáveis, Aprender+) define o **valor unitário** de cada insumo (o Registro de Inventário e a exportação mostram o gasto) e o **prazo por GRE** (depois da data o preenchimento fecha sozinho) | preenche, por escola e mês, a quantidade dos itens ativos; salva rascunho e clica em **Enviar Inventário** (pop-up de confirmação). Depois de enviado, fica travado |
| Registro de Inventário | inventário por nutricionista → escolas → itens; status Enviado / Em preenchimento / Não iniciado; pode reabrir um enviado para correção | — |
| Pedidos | envia o Excel do pedido. Modelos reconhecidos sozinhos: **Secos / Congelados** (aba Resumo, escolas na linha 8) e **Horti** (abas Resumo ROTA 1 e 2, escolas na linha 3); outras planilhas: o sistema reconhece as colunas e as escolas (código ou nome) e distribui por nutricionista; finaliza ou devolve cada ajuste; baixa o Excel final | **Ajuste de Pedido**: vê a quantidade do **inventário mais recente** da escola (à esquerda) e a prevista por escola e item e preenche o ajuste onde precisar; envia com pop-up de confirmação e fica travado |
| Controle de KM | coordenação e **ADM** ( vê todos, confere, devolve com motivo, troca placa, lança o **abastecimento (L)** e o **valor do abastecimento** de cada dia e baixa o Excel do mês) | cadastra a placa uma vez; lança KM inicial e final por dia (total automático) e uma **observação** opcional; **Salvar** e, no fim do mês, **Enviar para ADM** (trava o mês) |
| Capacitação | define em **Configurações** o tema, o prazo e os **anexos** do mês (a nutri vê e baixa); coordenação e ADM conferem os arquivos | envia uma vez por mês os documentos, até o prazo; se o ADM devolver, reenvia |
| Calculadora Per Capita | desabilitada ("Em breve") | desabilitada |
| Pendências | notificações, eventos sem atendimento, matriculados, inventário e supervisões | supervisões, notificações, eventos a confirmar e inventário do mês |
