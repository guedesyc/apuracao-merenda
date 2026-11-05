# Migração para produção (Supabase + Hostinger + novo domínio)

Este arquivo tem o prompt para colar no Claude no dia da migração e o contexto que ele precisa.
O prompt está na seção **"Prompt para colar"**. O restante é referência.

---

## Prompt para colar

```text
Hoje vamos colocar em PRODUÇÃO tudo o que foi feito na versão local do Portal Merenda
(módulos novos + Analytics), ligando ao Supabase e à Hostinger, e trocar o domínio.
Responda sempre em português do Brasil. O sistema é usado principalmente no CELULAR.

CONTEXTO
- Repositório com o trabalho: github.com/guedesyc/apuracao-merenda-modulos (privado), branch main.
  Clone/abra ele e leia MIGRACAO-PRODUCAO.md, CONTINUAR.md, LOCAL.md, DEPLOY.md e BACKUP.md antes de tudo.
- Repositório de PRODUÇÃO (o que a Hostinger publica): github.com/guedesyc/apuracao-merenda, branch main.
- Produção hoje: Node na Hostinger (server.js) + Supabase. Domínio atual:
  apuracaomerendaescolar.ygsystems.com.br. Domínio novo: portalmerenda.ygsystems.com.br.
- Hoje os módulos novos só funcionam em modo local: a API local/modules-api.js grava em
  local-data/modules.json e os anexos em local-data/uploads/. Em produção ela nem é carregada
  (server.js só a usa com --local). O Supabase só tem as 11 tabelas do sistema original.

OBJETIVO DO DIA (nesta ordem, um passo de cada vez, me mostrando antes de aplicar)
1. Backup da produção (npm run backup:prod, com env.env que EU preencho) e conferência do backup.
2. Escrever o SQL de migração em supabase/migrations/ com as tabelas dos módulos novos
   (lista em MIGRACAO-PRODUCAO.md), índices, e ajuste do check de profiles.role para aceitar 'adm'.
   Só ADICIONAR: nada de drop, truncate ou alterar dados existentes. Me mostre o SQL para eu revisar.
   Eu aplico no SQL Editor do Supabase (ou você aplica, se eu liberar o acesso).
3. Criar o bucket de anexos no Supabase Storage (privado) e trocar o upload/download de arquivos
   para usar o Storage em vez do disco.
4. Reescrever a camada de dados de local/modules-api.js para usar o Supabase (mesmas rotas /api/m/*,
   mesmas regras de negócio e mesmos formatos de resposta, para as telas não mudarem). Manter o modo
   local funcionando (LOCAL_MODE=1 continua usando o JSON). Fazer o server.js carregar a API dos módulos
   também em produção.
5. Script de carga inicial (idempotente) para a produção: catálogo de insumos (data/inventario-2026.json),
   matriculados (data/matriculados-2026.json), configuração da gasolina (R$ 6,20 e 10 km/l) e o perfil ADM.
   NÃO levar nada de local-data/ (lá é só teste e dado fictício marcado como demo).
6. Testar tudo contra um Supabase de TESTE antes da produção, se possível (ou, no mínimo, rodar os testes
   + subir o servidor apontando para a produção só em leitura e conferir as telas). npm test tem que passar.
7. Levar o código para o repositório de produção (guedesyc/apuracao-merenda): branch nova, commit,
   push e PR para eu revisar. Não fazer merge sem eu mandar.
8. Publicar na Hostinger (eu clico onde precisar), conferir variáveis de ambiente, reinstalar
   dependências e reiniciar a aplicação. Validar com o checklist do DEPLOY.md + telas novas.
9. Só depois de tudo funcionando: domínio novo portalmerenda.ygsystems.com.br na MESMA aplicação Node,
   SSL ativo, e o domínio antigo redirecionando para o novo. Atualizar README.md.

REGRAS
- Nunca apagar nem sobrescrever dados de produção. Backup antes de qualquer mudança no banco.
- Nunca colocar chaves (SUPABASE_SERVICE_ROLE_KEY, SESSION_SECRET) no código, no Git ou no chat.
  Elas ficam no env.env local (já está no .gitignore) e nas variáveis da Hostinger.
- Me peça os acessos quando precisar (painel do Supabase, hPanel da Hostinger, DNS, push no repo de produção).
  Os logins eu mesmo faço.
- Antes de cada passo que mexe em produção, me diga o que vai fazer e espere meu OK.
- Ao final, me entregue um resumo do que foi feito, do que ficou pendente e de como desfazer cada passo.
```

---

## Referência para o dia

### Tabelas novas sugeridas (o Claude deve revisar contra `local/modules-api.js`)

| Módulo | Tabela(s) | Observações |
|---|---|---|
| Configurações | `module_settings` (key, value jsonb) | gasolina: `fuelPrice` 6.2, `kmPerLiter` 10 |
| Matriculados | `enrollments` (school_id, segments jsonb, updated_at, updated_by) | 1 linha por escola |
| Supervisão | `supervision_reports` | escola, nutricionista, data, notas, arquivo e fotos (jsonb com referências do Storage) |
| Eventos | `events` | público, quantidades, refeição de adultos, aprovação (coordenação), atendimento e conclusão (nutri) |
| Notificações | `notifications`, `notification_responses` | `school_ids` + `target_ids` (nutris derivadas das escolas); resposta por nutricionista |
| Inventário | `inventory_items`, `inventory_counts`, `inventory_submissions`, `inventory_deadlines` | contagem por mês/escola/item; prazo por GRE |
| Pedidos | `orders`, `order_lines`, `order_adjustments`, `order_history` | ajustes por nutricionista; histórico de rascunho/envio/devolução/finalização |
| KM | `km_vehicles`, `km_logs` (mês/nutri) e dias (jsonb ou `km_days`) | envio e conferência pelo ADM |
| Capacitação | `trainings`, `training_submissions` | tema e prazo por mês; envio, revisão e histórico |
| Perfis | alterar `profiles.role` para aceitar `adm` | hoje só aceita `admin` e `nutritionist` |

Anexos: hoje vão para `local-data/uploads/`. Na produção devem ir para o **Supabase Storage**
(o disco da Hostinger pode ser apagado a cada atualização).

### Acessos que vão ser pedidos

- **Supabase**: painel do projeto de produção (SQL Editor e Storage). A `SUPABASE_URL` e a
  `SUPABASE_SERVICE_ROLE_KEY` vão no `env.env` local para o backup e os testes.
- **Hostinger (hPanel)**: aplicação Node (variáveis de ambiente, reinstalar, reiniciar), domínios e SSL.
- **DNS de ygsystems.com.br**: criar `portalmerenda` apontando para a Hostinger.
- **GitHub**: permissão de push no `guedesyc/apuracao-merenda` (para abrir o PR).

### Troca de domínio: o que muda

- Nada de API, Supabase ou variáveis muda: a API é chamada por caminho relativo e o Supabase é
  acessado pelo servidor.
- Todos precisam entrar de novo uma vez (a sessão fica guardada no navegador por endereço).
- Manter o domínio antigo **redirecionando** para o novo por um tempo; avisar as nutricionistas.
- Fazer a troca de domínio **depois** que a migração estiver funcionando.

### Como desfazer

- Banco: as mudanças são só adições (tabelas novas e o check de `role`). O backup do passo 1 restaura os dados.
- Código: o deploy é um merge no repositório de produção; reverter o merge e republicar volta a versão anterior.
- Domínio: o antigo continua configurado; basta tirar o redirecionamento.
