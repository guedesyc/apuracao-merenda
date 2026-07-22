const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const WebSocket = require("ws");
const { createClient } = require("@supabase/supabase-js");

const ROOT = process.cwd();
const TEMPLATE = path.join(ROOT, "data", "templates", "Pasta1.xlsx");
const DEMO_DATA = path.join(ROOT, "public", "demo-data.json");

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
  if (!url || !key) throw new Error("Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY na hospedagem.");
  return createClient(url, key, {
    auth: { persistSession: false },
    realtime: { transport: WebSocket }
  });
}

function secret() {
  return process.env.SESSION_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "dev-secret";
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(String(password)).digest("hex");
}

function routeId(name) {
  return `route-${String(name || "sem-rota")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "sem-rota"}`;
}

function createToken(user) {
  const payload = base64url(JSON.stringify({
    sub: user.id,
    role: user.role,
    exp: Date.now() + 1000 * 60 * 60 * 12
  }));
  const signature = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyToken(event) {
  const header = event.headers.authorization || event.headers.Authorization || "";
  const token = header.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (Date.now() > data.exp) return null;
  return data;
}

async function actorFromEvent(client, event) {
  const token = verifyToken(event);
  if (!token) return null;
  const { data, error } = await client.from("profiles").select("*").eq("id", token.sub).eq("active", true).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function logAudit(client, actor, action, entity, entityId, details = {}) {
  await client.from("audit_logs").insert({
    actor_id: actor?.id || null,
    action,
    entity,
    entity_id: entityId || null,
    details
  });
}

async function selectAll(client, table, columns = "*") {
  const { data, error } = await client.from(table).select(columns);
  if (error) throw error;
  return data || [];
}

async function ensureSeeded(client) {
  const { count, error } = await client.from("profiles").select("id", { count: "exact", head: true });
  if (error) throw error;
  if (count && count > 0) return;
  const seed = JSON.parse(fs.readFileSync(DEMO_DATA, "utf8"));
  await saveRelationalState(client, { id: "seed", role: "admin", name: "Seed" }, seed, { seed: true });
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    password: "",
    role: user.role,
    active: user.active
  };
}

async function loadRelationalState(client, actor) {
  await ensureSeeded(client);

  const [
    profiles,
    routes,
    cards,
    settingsRows,
    assignments,
    closures,
    exportsRows
  ] = await Promise.all([
    selectAll(client, "profiles"),
    selectAll(client, "routes"),
    selectAll(client, "cards"),
    selectAll(client, "settings"),
    selectAll(client, "nutritionist_schools"),
    selectAll(client, "monthly_closures"),
    selectAll(client, "exports")
  ]);

  const routeById = new Map(routes.map(route => [route.id, route.name]));
  const profileById = new Map(profiles.map(profile => [profile.id, profile]));
  const assignmentsBySchool = new Map();
  for (const item of assignments) {
    if (!assignmentsBySchool.has(item.school_id)) assignmentsBySchool.set(item.school_id, []);
    assignmentsBySchool.get(item.school_id).push(item.profile_id);
  }

  let schoolsQuery = client.from("schools").select("*").order("row_number", { ascending: true });
  if (actor.role !== "admin") {
    const ownSchoolIds = assignments.filter(item => item.profile_id === actor.id).map(item => item.school_id);
    schoolsQuery = ownSchoolIds.length ? schoolsQuery.in("id", ownSchoolIds) : schoolsQuery.eq("id", "__none__");
  }
  const { data: schoolsData, error: schoolsError } = await schoolsQuery;
  if (schoolsError) throw schoolsError;
  const visibleSchoolIds = new Set((schoolsData || []).map(school => school.id));

  let entriesQuery = client.from("entries").select("*, entry_items(card_id, quantity)").order("entry_date", { ascending: true });
  if (actor.role !== "admin") entriesQuery = entriesQuery.eq("nutritionist_id", actor.id);
  const { data: entriesData, error: entriesError } = await entriesQuery;
  if (entriesError) throw entriesError;

  const settings = settingsRows.find(row => row.key === "app")?.value || { currentMonth: "2026-07", reasons: ["Sem aula", "Segurança", "Greve", "Feriado", "Outro"], workingDaysByMonth: { "2026-07": 22 } };

  return {
    version: 2,
    currentUser: publicUser(actor),
    createdAt: "",
    updatedAt: new Date().toISOString(),
    settings,
    cards: cards
      .filter(card => card.active !== false)
      .sort((a, b) => a.number - b.number)
      .map(card => ({
        id: card.id,
        number: card.number,
        label: card.label,
        description: card.description || "",
        price: Number(card.price || 0),
        column: card.column_number
      })),
    schools: (schoolsData || []).map(school => ({
      id: school.id,
      row: school.row_number,
      name: school.name,
      shortName: school.short_name,
      route: routeById.get(school.route_id) || "SEM ROTA",
      company: school.company || "",
      address: school.address || "",
      active: school.active,
      nutritionistIds: assignmentsBySchool.get(school.id) || []
    })),
    users: actor.role === "admin"
      ? profiles.map(publicUser)
      : [publicUser(actor)],
    entries: (entriesData || [])
      .filter(entry => visibleSchoolIds.has(entry.school_id))
      .map(entry => ({
        id: entry.id,
        date: entry.entry_date,
        month: entry.month,
        schoolId: entry.school_id,
        nutritionistId: entry.nutritionist_id,
        nutritionistName: profileById.get(entry.nutritionist_id)?.name || "",
        status: entry.status,
        reason: entry.reason || "",
        notes: entry.notes || "",
        quantities: Object.fromEntries((entry.entry_items || []).map(item => [item.card_id, Number(item.quantity)])),
        updatedAt: entry.updated_at
      })),
    closures: closures
      .filter(item => actor.role === "admin" || item.nutritionist_id === actor.id)
      .map(item => ({
        id: item.id,
        month: item.month,
        nutritionistId: item.nutritionist_id,
        nutritionistName: item.nutritionist_name,
        status: item.status,
        expected: item.expected,
        complete: item.complete,
        pending: item.pending,
        test: item.test,
        sentAt: item.sent_at,
        updatedAt: item.updated_at
      })),
    exports: actor.role === "admin"
      ? exportsRows.map(item => ({ id: item.id, month: item.month, filename: item.filename, rows: item.rows, createdAt: item.created_at }))
      : []
  };
}

async function replaceRows(client, table, rows, conflictTarget) {
  if (!rows.length) return;
  const { error } = await client.from(table).upsert(rows, { onConflict: conflictTarget });
  if (error) throw error;
}

function profileRowsFromDb(db, existingProfiles) {
  const existingById = new Map(existingProfiles.map(profile => [profile.id, profile]));
  return (db.users || []).map(user => {
    const existing = existingById.get(user.id);
    const password = String(user.password || "").trim();
    return {
      id: user.id,
      name: user.name,
      username: user.username,
      password_hash: password ? hashPassword(password) : existing?.password_hash || hashPassword("123"),
      role: user.role,
      active: user.active !== false,
      updated_at: new Date().toISOString()
    };
  });
}

function routeRowsFromDb(db) {
  const names = [...new Set((db.schools || []).map(school => school.route || "SEM ROTA"))];
  return names.map(name => ({ id: routeId(name), name }));
}

function schoolRowsFromDb(db) {
  return (db.schools || []).map(school => ({
    id: school.id,
    row_number: school.row,
    code: String(school.name || "").includes(" - ") ? String(school.name).split(" - ", 1)[0] : null,
    name: school.name,
    short_name: school.shortName || school.name,
    route_id: routeId(school.route || "SEM ROTA"),
    company: school.company || "",
    address: school.address || "",
    active: school.active !== false,
    updated_at: new Date().toISOString()
  }));
}

function cardRowsFromDb(db) {
  return (db.cards || []).map(card => ({
    id: card.id,
    number: card.number,
    label: card.label,
    description: card.description || "",
    price: card.price || 0,
    column_number: card.column,
    active: true
  }));
}

function entryRowsFromDb(db, actor) {
  return (db.entries || [])
    .filter(entry => actor.role === "admin" || entry.nutritionistId === actor.id)
    .map(entry => ({
      id: entry.id,
      entry_date: entry.date,
      month: entry.month || String(entry.date || "").slice(0, 7),
      school_id: entry.schoolId,
      nutritionist_id: entry.nutritionistId,
      status: entry.status,
      reason: entry.reason || "",
      notes: entry.notes || "",
      updated_at: new Date().toISOString()
    }));
}

function entryItemRowsFromDb(db, actor) {
  const rows = [];
  for (const entry of db.entries || []) {
    if (actor.role !== "admin" && entry.nutritionistId !== actor.id) continue;
    for (const [cardId, quantity] of Object.entries(entry.quantities || {})) {
      if (quantity === "" || quantity === null || quantity === undefined) continue;
      rows.push({ entry_id: entry.id, card_id: cardId, quantity: Number(String(quantity).replace(",", ".")) || 0 });
    }
  }
  return rows;
}

function closureRowsFromDb(db, actor) {
  return (db.closures || [])
    .filter(item => actor.role === "admin" || item.nutritionistId === actor.id)
    .map(item => ({
      id: item.id,
      month: item.month,
      nutritionist_id: item.nutritionistId,
      nutritionist_name: item.nutritionistName,
      status: item.status,
      expected: item.expected || 0,
      complete: item.complete || 0,
      pending: item.pending || 0,
      test: Boolean(item.test),
      sent_at: item.sentAt || null,
      updated_at: new Date().toISOString()
    }));
}

async function saveRelationalState(client, actor, db, options = {}) {
  if (actor.role === "admin") {
    const existingProfiles = await selectAll(client, "profiles");
    await replaceRows(client, "profiles", profileRowsFromDb(db, existingProfiles), "id");
    await replaceRows(client, "routes", routeRowsFromDb(db), "id");
    await replaceRows(client, "schools", schoolRowsFromDb(db), "id");
    await replaceRows(client, "cards", cardRowsFromDb(db), "id");
    await client.from("nutritionist_schools").delete().neq("school_id", "__never__");
    const assignmentRows = [];
    for (const school of db.schools || []) {
      for (const profileId of school.nutritionistIds || []) assignmentRows.push({ school_id: school.id, profile_id: profileId });
    }
    await replaceRows(client, "nutritionist_schools", assignmentRows, "profile_id,school_id");
    await client.from("settings").upsert({ key: "app", value: db.settings || {}, updated_at: new Date().toISOString() }, { onConflict: "key" });
  }

  if (actor.role === "admin") {
    await client.from("entry_items").delete().neq("entry_id", "__never__");
    await client.from("entries").delete().neq("id", "__never__");
    await client.from("monthly_closures").delete().neq("id", "__never__");
  } else {
    const { data: ownEntries, error } = await client.from("entries").select("id").eq("nutritionist_id", actor.id);
    if (error) throw error;
    const ids = (ownEntries || []).map(item => item.id);
    if (ids.length) {
      await client.from("entry_items").delete().in("entry_id", ids);
      await client.from("entries").delete().eq("nutritionist_id", actor.id);
    }
    await client.from("monthly_closures").delete().eq("nutritionist_id", actor.id);
  }

  await replaceRows(client, "entries", entryRowsFromDb(db, actor), "id");
  await replaceRows(client, "entry_items", entryItemRowsFromDb(db, actor), "entry_id,card_id");
  await replaceRows(client, "monthly_closures", closureRowsFromDb(db, actor), "month,nutritionist_id");
  if (!options.seed) await logAudit(client, actor, "save", "app_state", null, { role: actor.role });
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

    if (event.httpMethod === "POST" && action === "login") {
      await ensureSeeded(client);
      const body = parseBody(event);
      const { data: user, error } = await client.from("profiles").select("*").eq("username", body.username).eq("active", true).maybeSingle();
      if (error) throw error;
      if (!user || user.password_hash !== hashPassword(body.password || "")) {
        return json(401, { error: "Usuario ou senha invalidos." });
      }
      return json(200, { token: createToken(user), user: publicUser(user) });
    }

    const actor = await actorFromEvent(client, event);
    if (!actor) return json(401, { error: "Sessao expirada. Entre novamente." });

    if (event.httpMethod === "GET" && (action === "data" || action === "bootstrap")) {
      return json(200, await loadRelationalState(client, actor));
    }

    if (event.httpMethod === "POST" && action === "save") {
      const db = parseBody(event);
      if (!Array.isArray(db.schools) || !Array.isArray(db.entries) || !Array.isArray(db.users)) {
        return json(400, { error: "Formato de dados invalido." });
      }
      await saveRelationalState(client, actor, db);
      return json(200, { ok: true });
    }

    if (event.httpMethod === "POST" && action === "export") {
      if (actor.role !== "admin") return json(403, { error: "Apenas a coordenação pode exportar." });
      const body = parseBody(event);
      if (!body.month || !/^\d{4}-\d{2}$/.test(body.month)) {
        return json(400, { error: "Informe a competencia no formato AAAA-MM." });
      }
      const db = await loadRelationalState(client, actor);
      const buffer = await exportWorkbook(db, body.month);
      const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
      const filename = `apuracao-consolidada-${body.month}-${stamp}.xlsx`;
      await client.from("exports").insert({ id: `export-${Date.now()}`, month: body.month, filename, rows: db.schools.length });
      await logAudit(client, actor, "export", "xlsx", filename, { month: body.month });
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
