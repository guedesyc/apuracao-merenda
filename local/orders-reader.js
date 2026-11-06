// Leitura da planilha de pedidos: encontra o cabeçalho, sugere as colunas e casa as escolas.
// Aceita dois formatos:
//  - "linhas": uma linha por escola + item (colunas Escola / Item / Unidade / Quantidade);
//  - "colunas": uma linha por item e uma coluna por escola (cabeçalho com o código ou nome da escola).
const { ExcelJS, normalize, cellText, parseQuantity } = require("./xlsx-helpers");

const GUESS = {
  code: [/^C[OÓ]D(IGO)?\.?\s*(DA\s+)?(ESCOLA|UE|UNIDADE|INEP)/i, /^C[OÓ]D(IGO)?\.?$/i, /^INEP$/i],
  school: [/ESCOLA/i, /UNIDADE\s+ESCOLAR/i, /^U\.?E\.?$/i, /INSTITUI/i, /CRECHE/i],
  item: [/ITEM/i, /PRODUTO/i, /G[EÊ]NERO/i, /DESCRI/i, /INSUMO/i, /ALIMENTO/i, /MATERIAL/i],
  unit: [/^UNID(ADE)?\.?(\s+DE\s+MEDIDA)?$/i, /^UN\.?$/i, /^UND\.?$/i, /MEDIDA/i, /^EMBALAGEM$/i],
  qty: [/QTD/i, /QUANT/i, /^TOTAL$/i, /PREVIS/i, /PEDIDO/i]
};

async function readWorkbook(base64) {
  const workbook = new ExcelJS.Workbook();
  const buffer = Buffer.from(String(base64 || "").replace(/^data:[^;]+;base64,/, ""), "base64");
  if (!buffer.length) throw Object.assign(new Error("Arquivo vazio."), { statusCode: 400 });
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw Object.assign(new Error("Não consegui ler o arquivo. Envie uma planilha .xlsx (Excel)."), { statusCode: 400 });
  }
  return workbook;
}

function sheetRows(sheet) {
  const rows = [];
  sheet.eachRow({ includeEmpty: false }, (row, number) => {
    const values = [];
    for (let col = 1; col <= sheet.columnCount; col += 1) values.push(row.getCell(col).value);
    rows.push({ number, values });
  });
  return rows;
}

function headerScore(texts) {
  let score = 0;
  for (const text of texts) if (text && Object.values(GUESS).some(list => list.some(regex => regex.test(text)))) score += 1;
  return score;
}

function findHeader(rows) {
  let best = null;
  for (const row of rows.slice(0, 25)) {
    const texts = row.values.map(cellText);
    const score = headerScore(texts);
    if (!best || score > best.score) best = { row, score };
  }
  if (best && best.score >= 2) return best.row;
  return rows.find(row => row.values.filter(value => cellText(value)).length >= 2) || rows[0] || null;
}

function guessColumn(headers, kind, taken) {
  for (const regex of GUESS[kind]) {
    const index = headers.findIndex((text, i) => !taken.has(i) && text && regex.test(text) && !(kind === "unit" && /ESCOLAR/i.test(text)) && !(kind === "school" && /C[OÓ]D/i.test(text)));
    if (index >= 0) return index;
  }
  return -1;
}

// Palavras genéricas ignoradas na comparação aproximada de nomes de escola.
const GENERIC_WORDS = new Set(["CENTRO", "MUNICIPAL", "MINICIPAL", "MUNICIAPAL", "EDUCACAO", "EDUCACIONAL", "INFANTIL", "ESCOLA", "CMEI", "EM", "DE", "DA", "DO", "DOS", "DAS", "E", "DONA", "DOM", "PROF", "PROFESSOR", "PROFESSORA", "UNIDADE", "ESCOLAR"]);

function nameTokens(text) {
  return normalize(text).replace(/^\d+\s+/, "").split(" ")
    .map(word => word.replace(/(.)\1+/g, "$1"))
    .filter(word => word && !GENERIC_WORDS.has(word));
}

// Nomes que aparecem nas planilhas de pedido mas correspondem a outra escola cadastrada.
// "de" e "para" já normalizados (maiúsculas, sem acento); basta o nome conter "de".
const SCHOOL_ALIASES = [
  { de: "SATURNINO CABRAL", para: "ESCOLA MUNICIPAL AILTON SOARES" }
];

function schoolMatcher(schools) {
  const aliasTargets = SCHOOL_ALIASES
    .map(alias => ({ de: alias.de, school: schools.find(school => normalize(school.shortName) === alias.para) }))
    .filter(alias => alias.school);
  const tokenized = schools.map(school => ({ school, tokens: new Set(nameTokens(school.shortName)) }));
  const fuzzy = text => {
    const tokens = [...new Set(nameTokens(text))];
    if (tokens.length < 2) return null;
    let best = null;
    let tie = false;
    for (const candidate of tokenized) {
      const shared = tokens.filter(token => candidate.tokens.has(token)).length;
      const score = shared / Math.max(tokens.length, candidate.tokens.size);
      if (!best || score > best.score) { best = { score, school: candidate.school }; tie = false; }
      else if (score === best.score) tie = true;
    }
    return best && best.score >= 0.75 && !tie ? best.school : null;
  };
  const byCode = new Map();
  const byName = new Map();
  for (const school of schools) {
    if (school.code) byCode.set(String(school.code).padStart(4, "0"), school);
    byName.set(normalize(school.shortName), school);
    byName.set(normalize(school.name), school);
  }
  return (...texts) => {
    for (const raw of texts) {
      const text = cellText(raw);
      if (!text) continue;
      const code = text.match(/^\s*(\d{1,5})(?!\d)/);
      if (code && byCode.has(code[1].padStart(4, "0"))) return byCode.get(code[1].padStart(4, "0"));
      const name = normalize(text.replace(/^\s*\d+\s*[-–.]\s*/, ""));
      if (!name) continue;
      const alias = aliasTargets.find(item => name.includes(item.de));
      if (alias) return alias.school;
      if (byName.has(name)) return byName.get(name);
      if (name.length >= 8) {
        const hits = schools.filter(school => {
          const short = normalize(school.shortName);
          return short.includes(name) || name.includes(short);
        });
        if (hits.length === 1) return hits[0];
      }
      const approx = fuzzy(text);
      if (approx) return approx;
    }
    return null;
  };
}

// Resumo de cada aba + mapeamento sugerido (usado na pré-visualização do admin).
function describeSheet(sheet, match) {
  const rows = sheetRows(sheet);
  const header = findHeader(rows);
  if (!header) return null;
  const headers = header.values.map(cellText);
  const taken = new Set();
  const mapping = {};
  for (const kind of ["code", "school", "item", "unit", "qty"]) {
    const index = guessColumn(headers, kind, taken);
    mapping[kind] = index;
    if (index >= 0) taken.add(index);
  }
  const schoolColumns = headers.map((text, index) => (match(text) ? index : -1)).filter(index => index >= 0 && !taken.has(index));
  const mode = schoolColumns.length >= 2 && mapping.school < 0 && mapping.code < 0 ? "colunas" : "linhas";
  const body = rows.filter(row => row.number > header.number);
  return {
    name: sheet.name,
    headerRow: header.number,
    headers: headers.map((text, index) => text || `Coluna ${index + 1}`),
    rowCount: body.length,
    mode,
    mapping,
    schoolColumns,
    sample: body.slice(0, 6).map(row => row.values.map(cellText))
  };
}


// ---------- Modelos fixos da coordenação ----------
// Secos / Congelados: aba "Resumo"; linha 8 = escolas (uma por coluna, a partir da F); insumos nas linhas abaixo
//   (coluna A = código, B = insumo, C = unidade). Quando o nome do insumo é fórmula sem valor salvo,
//   ele é buscado na aba "Cadastro" (G = código, H = item, I = unidade).
// Horti: abas "Resumo ROTA 1" e "Resumo ROTA 2"; linha 3 = escolas; insumos nas linhas abaixo.
const LAYOUTS = [
  { kind: "resumo", label: "Pedido (aba Resumo · escolas na linha 8)", sheets: wb => [wb.getWorksheet("Resumo") || wb.getWorksheet("RESUMO")].filter(Boolean), headerRow: 8, test: sheet => [1, 2].some(col => /ESCOLAS/i.test(cellText(sheet.getRow(8).getCell(col).value))) },
  { kind: "horti", label: "Horti (abas Resumo ROTA 1 e 2 · escolas na linha 3)", sheets: wb => wb.worksheets.filter(sheet => /^RESUMO\s+ROTA\s*\d+$/i.test(sheet.name.trim())), headerRow: 3, test: sheet => [1, 2].some(col => /ESCOLAS/i.test(cellText(sheet.getRow(3).getCell(col).value))) }
];

function cadastroItems(workbook) {
  const sheet = workbook.getWorksheet("Cadastro");
  const map = new Map();
  if (!sheet) return map;
  sheet.eachRow((row, number) => {
    if (number === 1) return;
    const code = cellText(row.getCell(7).value);
    const name = cellText(row.getCell(8).value);
    if (code && name) map.set(code, { name, unit: cellText(row.getCell(9).value) });
  });
  return map;
}

function detectLayout(workbook) {
  for (const layout of LAYOUTS) {
    const sheets = layout.sheets(workbook).filter(sheet => layout.test(sheet));
    if (sheets.length) return { layout, sheets };
  }
  return null;
}

const SKIP_ITEM = /^(INSUMO|TOTAL|SUBTOTAL)\b/i;

function readLayout(workbook, schools) {
  const found = detectLayout(workbook);
  if (!found) return null;
  const { layout, sheets } = found;
  const match = schoolMatcher(schools);
  const catalog = cadastroItems(workbook);
  const lines = new Map();
  const unmatched = new Map();
  const matchedSchools = new Set();
  let skipped = 0;
  let itemRows = 0;
  for (const sheet of sheets) {
    const header = sheet.getRow(layout.headerRow);
    const columns = [];
    for (let col = 6; col <= sheet.columnCount; col += 1) {
      const label = cellText(header.getCell(col).value);
      if (!label || !/[A-Za-zÀ-ú]{3}/.test(label) || /VERIFICAR|TOTAL|PRE[ÇC]O|CUSTO|^ADD\b/i.test(label)) continue;
      const school = match(label);
      columns.push({ col, label, school });
      if (school) matchedSchools.add(school.id);
      else if (!unmatched.has(label)) unmatched.set(label, { label, rows: 0, qty: 0 });
    }
    for (let number = layout.headerRow + 1; number <= sheet.rowCount; number += 1) {
      const row = sheet.getRow(number);
      const code = cellText(row.getCell(1).value);
      let item = cellText(row.getCell(2).value).replace(/\s*\n\s*/g, " ");
      let unit = cellText(row.getCell(3).value);
      if (!item && code && catalog.has(code)) { item = catalog.get(code).name; unit ||= catalog.get(code).unit; }
      if (!item || SKIP_ITEM.test(item)) continue;
      itemRows += 1;
      for (const { col, label, school } of columns) {
        const qty = parseQuantity(row.getCell(col).value);
        if (!Number.isFinite(qty) || qty <= 0) { skipped += 1; continue; }
        const rounded = Math.round(qty * 1000) / 1000;
        if (!school) {
          const entry = unmatched.get(label);
          entry.rows += 1;
          entry.qty += rounded;
          continue;
        }
        const key = `${school.id}|${normalize(item)}|${normalize(unit)}`;
        const line = lines.get(key) || { schoolId: school.id, item, unit, qty: 0 };
        line.qty = Math.round((line.qty + rounded) * 1000) / 1000;
        lines.set(key, line);
      }
    }
  }
  return {
    layout: { kind: layout.kind, label: layout.label, sheets: sheets.map(sheet => sheet.name), schools: matchedSchools.size, items: itemRows },
    lines: [...lines.values()],
    unmatched: [...unmatched.values()].sort((a, b) => b.qty - a.qty),
    skipped,
    sheet: sheets.map(sheet => sheet.name).join(" + ")
  };
}

async function previewOrderFile(base64, schools) {
  const workbook = await readWorkbook(base64);
  const fixed = readLayout(workbook, schools);
  if (fixed) {
    const bySchool = new Map();
    for (const line of fixed.lines) bySchool.set(line.schoolId, (bySchool.get(line.schoolId) || 0) + 1);
    return {
      layout: fixed.layout, lines: fixed.lines.length, unmatched: fixed.unmatched, skipped: fixed.skipped,
      sample: fixed.lines.slice(0, 8).map(line => ({ school: schools.find(school => school.id === line.schoolId)?.shortName || line.schoolId, item: line.item, unit: line.unit, qty: line.qty })),
      sheets: []
    };
  }
  const match = schoolMatcher(schools);
  const sheets = workbook.worksheets.map(sheet => describeSheet(sheet, match)).filter(Boolean).filter(sheet => sheet.rowCount);
  if (!sheets.length) throw Object.assign(new Error("A planilha não tem linhas de dados."), { statusCode: 400 });
  sheets.sort((a, b) => b.rowCount - a.rowCount);
  return { sheets };
}

// Lê as linhas com o mapeamento escolhido e devolve itens por escola + o que não foi reconhecido.
async function parseOrderFile(base64, schools, { sheet: sheetNameWanted, mode, mapping }) {
  const workbook = await readWorkbook(base64);
  const fixed = readLayout(workbook, schools);
  if (fixed) return fixed;
  const sheet = workbook.getWorksheet(sheetNameWanted) || workbook.worksheets[0];
  const match = schoolMatcher(schools);
  const described = describeSheet(sheet, match);
  if (!described) throw Object.assign(new Error("Aba sem dados."), { statusCode: 400 });
  const map = { ...described.mapping, ...(mapping || {}) };
  const col = key => (Number.isInteger(Number(map[key])) ? Number(map[key]) : -1);
  const rows = sheetRows(sheet).filter(row => row.number > described.headerRow);
  const lines = new Map();
  const unmatched = new Map();
  let skipped = 0;
  const add = (school, item, unit, qty, label) => {
    if (!item || !Number.isFinite(qty) || qty <= 0) { skipped += 1; return; }
    if (!school) {
      const entry = unmatched.get(label) || { label, rows: 0, qty: 0 };
      entry.rows += 1;
      entry.qty += qty;
      unmatched.set(label, entry);
      return;
    }
    const key = `${school.id}|${normalize(item)}|${normalize(unit)}`;
    const line = lines.get(key) || { schoolId: school.id, item, unit, qty: 0 };
    line.qty = Math.round((line.qty + qty) * 1000) / 1000;
    lines.set(key, line);
  };

  if ((mode || described.mode) === "colunas") {
    const itemCol = col("item");
    if (itemCol < 0) throw Object.assign(new Error("Indique a coluna do item."), { statusCode: 400 });
    const schoolCols = described.schoolColumns;
    if (!schoolCols.length) throw Object.assign(new Error("Nenhuma coluna com código ou nome de escola foi reconhecida."), { statusCode: 400 });
    for (const row of rows) {
      const item = cellText(row.values[itemCol]);
      const unit = col("unit") >= 0 ? cellText(row.values[col("unit")]) : "";
      for (const index of schoolCols) add(match(described.headers[index]), item, unit, parseQuantity(row.values[index]), described.headers[index]);
    }
  } else {
    if (col("item") < 0 || col("qty") < 0 || (col("school") < 0 && col("code") < 0)) {
      throw Object.assign(new Error("Indique as colunas de escola, item e quantidade."), { statusCode: 400 });
    }
    for (const row of rows) {
      const codeText = col("code") >= 0 ? cellText(row.values[col("code")]) : "";
      const schoolText = col("school") >= 0 ? cellText(row.values[col("school")]) : "";
      const label = [codeText, schoolText].filter(Boolean).join(" - ") || "(sem escola)";
      add(match(codeText, schoolText), cellText(row.values[col("item")]), col("unit") >= 0 ? cellText(row.values[col("unit")]) : "", parseQuantity(row.values[col("qty")]), label);
    }
  }
  return { lines: [...lines.values()], unmatched: [...unmatched.values()].sort((a, b) => b.rows - a.rows), skipped, sheet: sheet.name };
}

module.exports = { previewOrderFile, parseOrderFile, schoolMatcher };
