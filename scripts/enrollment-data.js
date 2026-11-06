// Matriculados por escola e segmento (card).
// Fonte: data/matriculados-2026.json, extraído de "ME SSA- NÚMERO DE MATRICULADOS.xlsx" (aba "Matriculados por segmento").
// As escolas são casadas pelo código (4 primeiros dígitos do nome, ex.: "0101").
const path = require("path");
const fs = require("fs");

const SOURCE = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "matriculados-2026.json"), "utf8"));
const BY_CODE = new Map(SOURCE.schools.map(row => [row.code, row]));

function schoolCode(school) {
  const name = String(school.name || "");
  return /^\d{4}\b/.test(name) ? name.slice(0, 4) : String(school.code || "");
}

function segmentsFor(school) {
  return BY_CODE.get(schoolCode(school))?.segments || {};
}

function enrollmentsFor(schools, updatedBy = "Planilha de matriculados") {
  const result = {};
  const updatedAt = new Date().toISOString();
  for (const school of schools) {
    const segments = segmentsFor(school);
    if (Object.keys(segments).length) result[school.id] = { segments: { ...segments }, updatedAt, updatedBy };
  }
  return result;
}

module.exports = { segmentsFor, enrollmentsFor, schoolCode };
