const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const { createClient } = require("@supabase/supabase-js");

const STATE_ID = "production";
const ROOT = process.cwd();
const TEMPLATE = path.join(ROOT, "data", "templates", "Pasta1.xlsx");
const DEMO_DATA = path.join(ROOT, "demo-data.json");

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body)
  };
}

function parseBody(event) {
  if (!event.body) return {};
  return JSON.parse(event.body);
}

function supabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no Netlify.");
  return createClient(url, key, { auth: { persistSession: false } });
}

async function loadDb(client) {
  const { data, error } = await client.from("app_state").select("data").eq("id", STATE_ID).maybeSingle();
  if (error) throw error;
  if (data?.data) return data.data;

  const seed = JSON.parse(fs.readFileSync(DEMO_DATA, "utf8"));
  const { error: insertError } = await client.from("app_state").insert({ id: STATE_ID, data: seed });
  if (insertError) throw insertError;
  return seed;
}

async function saveDb(client, db) {
  db.updatedAt = new Date().toISOString();
  const { error } = await client
    .from("app_state")
    .upsert({ id: STATE_ID, data: db, updated_at: new Date().toISOString() });
  if (error) throw error;
}

function isCompleteEntry(entry) {
  if (!entry) return false;
  if (entry.status === "not_served") return Boolean(entry.reason);
  const values = Object.values(entry.quantities || {});
  return values.length > 0 && values.every(value => {
    if (value === "" || value === null || value === undefined) return false;
    return Number.isFinite(Number(String(value).replace(",", ".")));
  });
}

function quantityToInt(value) {
  return Math.trunc(Number(String(value ?? 0).replace(",", ".")) || 0);
}

function columnLetter(columnNumber) {
  let letter = "";
  let number = columnNumber;
  while (number > 0) {
    const mod = (number - 1) % 26;
    letter = String.fromCharCode(65 + mod) + letter;
    number = Math.floor((number - mod) / 26);
  }
  return letter;
}

async function exportWorkbook(db, month) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(TEMPLATE);
  const worksheet = workbook.worksheets[0];
  const schoolsByRow = new Map(db.schools.map(school => [school.row, school]));
  const totals = new Map();
  const nutritionists = new Map();

  for (const entry of db.entries || []) {
    if (!String(entry.date || "").startsWith(month)) continue;
    if (!isCompleteEntry(entry) || entry.status === "not_served") continue;
    if (!totals.has(entry.schoolId)) totals.set(entry.schoolId, new Map());
    if (!nutritionists.has(entry.schoolId)) nutritionists.set(entry.schoolId, new Set());
    if (entry.nutritionistName) nutritionists.get(entry.schoolId).add(entry.nutritionistName);
    for (const [cardId, qty] of Object.entries(entry.quantities || {})) {
      const schoolTotals = totals.get(entry.schoolId);
      schoolTotals.set(cardId, (schoolTotals.get(cardId) || 0) + quantityToInt(qty));
    }
  }

  for (let row = 5; row < 170; row += 1) {
    const school = schoolsByRow.get(row);
    if (!school) continue;
    worksheet.getCell(row, 1).value = [...(nutritionists.get(school.id) || [])].sort().join(", ") || null;
    for (const card of db.cards || []) {
      worksheet.getCell(row, card.column).value = totals.get(school.id)?.get(card.id) || 0;
    }
  }

  for (const card of db.cards || []) {
    const col = columnLetter(card.column);
    worksheet.getCell(173, card.column).value = { formula: `${col}171*${col}172` };
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

exports.handler = async event => {
  try {
    const client = supabase();
    const segments = event.path.split("/").filter(Boolean);
    const action = segments[segments.length - 1];

    if (event.httpMethod === "GET" && action === "data") {
      return json(200, await loadDb(client));
    }

    if (event.httpMethod === "POST" && action === "login") {
      const body = parseBody(event);
      const db = await loadDb(client);
      const user = db.users?.find(item => item.username === body.username && item.password === body.password);
      if (!user) return json(401, { error: "Usuario ou senha invalidos." });
      return json(200, { user: { id: user.id, name: user.name, username: user.username, role: user.role } });
    }

    if (event.httpMethod === "POST" && action === "save") {
      const db = parseBody(event);
      if (!Array.isArray(db.schools) || !Array.isArray(db.entries) || !Array.isArray(db.users)) {
        return json(400, { error: "Formato de dados invalido." });
      }
      await saveDb(client, db);
      return json(200, { ok: true });
    }

    if (event.httpMethod === "POST" && action === "export") {
      const body = parseBody(event);
      if (!body.month || !/^\d{4}-\d{2}$/.test(body.month)) {
        return json(400, { error: "Informe a competencia no formato AAAA-MM." });
      }
      const db = await loadDb(client);
      const buffer = await exportWorkbook(db, body.month);
      const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
      const filename = `apuracao-consolidada-${body.month}-${stamp}.xlsx`;
      db.exports = db.exports || [];
      db.exports.push({ month: body.month, filename, createdAt: new Date().toISOString(), rows: db.schools.length });
      await saveDb(client, db);
      return json(200, {
        ok: true,
        filename,
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        base64: buffer.toString("base64")
      });
    }

    return json(404, { error: "Rota nao encontrada." });
  } catch (error) {
    return json(500, { error: error.message });
  }
};
