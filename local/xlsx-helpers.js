// Utilitários de planilha usados pelos módulos locais (exportações e leitura de pedidos).
const ExcelJS = require("exceljs");

const BRAND = "FF146B5B";
const HEAD = "FF257B6A";

function normalize(value) {
  return String(value ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
}

function fmtDateBR(iso) {
  if (!iso) return "";
  const [year, month, day] = String(iso).slice(0, 10).split("-");
  return day ? `${day}/${month}/${year}` : String(iso);
}

function monthLabel(month) {
  const names = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
  const [year, number] = String(month || "").split("-").map(Number);
  return year && number ? `${names[number - 1]} de ${year}` : String(month || "Sem data");
}

// Nome de aba válido no Excel (até 31 caracteres, sem : \ / ? * [ ]) e sem repetir.
function sheetName(workbook, wanted) {
  const base = String(wanted || "Planilha").replace(/[:\\/?*[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) || "Planilha";
  let name = base;
  let index = 2;
  while (workbook.getWorksheet(name)) {
    const suffix = ` (${index++})`;
    name = base.slice(0, 31 - suffix.length) + suffix;
  }
  return name;
}

// Aba no padrão visual das exportações já existentes: título, subtítulo e cabeçalho na linha 4.
function styledSheet(workbook, name, { title, subtitle = "", columns }) {
  const sheet = workbook.addWorksheet(sheetName(workbook, name));
  sheet.columns = columns.map(column => ({ key: column.key, width: column.width || 16 }));
  sheet.mergeCells(1, 1, 1, columns.length);
  Object.assign(sheet.getCell(1, 1), {
    value: title,
    font: { bold: true, size: 14, color: { argb: "FFFFFFFF" } },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: BRAND } },
    alignment: { horizontal: "center" }
  });
  if (subtitle) {
    sheet.mergeCells(2, 1, 2, columns.length);
    sheet.getCell(2, 1).value = subtitle;
    sheet.getCell(2, 1).font = { italic: true, color: { argb: "FF53635D" } };
  }
  const header = sheet.getRow(4);
  header.values = columns.map(column => column.header);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEAD } };
  header.alignment = { wrapText: true, vertical: "middle" };
  header.height = 30;
  sheet.views = [{ state: "frozen", ySplit: 4 }];
  return sheet;
}

function finishSheet(sheet, columns) {
  const last = Math.max(sheet.rowCount, 4);
  sheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: last, column: columns.length } };
  columns.forEach((column, index) => {
    if (column.numFmt) sheet.getColumn(index + 1).eachCell((cell, row) => { if (row > 4) cell.numFmt = column.numFmt; });
  });
}

async function toPayload(workbook, filename) {
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return { ok: true, filename, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", base64: buffer.toString("base64") };
}

// Valor de célula do ExcelJS em texto simples (rich text, fórmula, hyperlink, data).
function cellText(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if (Array.isArray(value.richText)) return value.richText.map(part => part.text).join("").trim();
    if (value.result !== undefined) return cellText(value.result);
    if (value.text !== undefined) return cellText(value.text);
    if (value.error) return "";
    return "";
  }
  return String(value).trim();
}

// Quantidade escrita como número ou texto ("1.234,5", "12 kg").
function parseQuantity(value) {
  if (typeof value === "number") return value;
  const text = cellText(value);
  if (!text) return NaN;
  const cleaned = text.replace(/[^\d.,-]/g, "");
  if (!cleaned) return NaN;
  const normalized = cleaned.includes(",") ? cleaned.replace(/\./g, "").replace(",", ".") : cleaned;
  return Number(normalized);
}

module.exports = { ExcelJS, normalize, stamp, fmtDateBR, monthLabel, styledSheet, finishSheet, toPayload, cellText, parseQuantity };
