# Apuração de Comandas

Sistema web para lançamento diário/semanal de refeições por escola e cardápio, com painel administrativo, configuração de responsáveis e exportação mensal consolidada para Excel.

## Acessar protótipo online

Após o GitHub Pages publicar a última versão:

[https://guedesyc.github.io/apuracao-merenda/](https://guedesyc.github.io/apuracao-merenda/)

A versão online é estática: permite testar a interface e salva dados no navegador. A exportação Excel real precisa da versão local com servidor.

## Como rodar

1. Instale a dependência Python:

   ```bash
   pip install -r requirements.txt
   ```

2. Gere a base inicial a partir das planilhas:

   ```bash
   python scripts/import_seed.py
   ```

3. Inicie o sistema:

   ```bash
   npm run dev
   ```

3. Abra `http://localhost:3000`.

## Logins iniciais

- Coordenação: `admin` / `admin`
- Nutricionistas: senha inicial `123`

| Usuário | Nome |
| --- | --- |
| `dione.cibele` | DIONE CIBELE |
| `beatriz.baiao` | BEATRIZ BAIÃO |
| `rebecca.tranquilli` | REBECCA TRANQUILLI |
| `evelyn.louise` | EVELYN LOUISE |
| `rafaela.anjos` | RAFAELA ANJOS |
| `flavia.franco` | FLÁVIA FRANCO |
| `carla.amparo` | CARLA AMPARO |
| `isadora.cardim` | ISADORA CARDIM |
| `vanessa.galvao` | VANESSA GALVÃO |
| `tassia.virginia` | TÁSSIA VIRGINIA |
| `mercia.nolair` | MÉRCIA NOLAIR |
| `claudia.brim` | CLAUDIA BRIM |
| `ana.silvana` | ANA SILVANA |

## Observações

- Os dados ficam salvos em `data/db.json`.
- A planilha modelo usada na exportação fica em `data/templates/Pasta1.xlsx`.
- As exportações geradas ficam em `data/exports`.
