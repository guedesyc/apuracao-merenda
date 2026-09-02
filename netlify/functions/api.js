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

async function selectEntriesPaged(client, actor) {
  const pageSize = 1000;
  const rows = [];
  let from = 0;

  while (true) {
    let query = client
      .from("entries")
      .select("*, entry_items(card_id, quantity)")
      .order("entry_date", { ascending: true })
      .range(from, from + pageSize - 1);
    if (actor.role !== "admin") query = query.eq("nutritionist_id", actor.id);

    const { data, error } = await query;
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }

  return rows;
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

  const entriesData = await selectEntriesPaged(client, actor);

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

function entryIdentityKey(entry) {
  const date = entry?.date || entry?.entry_date || "";
  const schoolId = entry?.schoolId || entry?.school_id || "";
  const nutritionistId = entry?.nutritionistId || entry?.nutritionist_id || "";
  return `${date}:${schoolId}:${nutritionistId}`;
}

function reconcileEntriesWithExisting(incomingEntries, existingEntries, nutritionistId) {
  const existingByKey = new Map((existingEntries || [])
    .map(entry => [entryIdentityKey(entry), entry]));
  const reconciledByKey = new Map();

  for (const entry of incomingEntries || []) {
    if (entry.nutritionistId !== nutritionistId) continue;
    const key = entryIdentityKey(entry);
    const existing = existingByKey.get(key);
    reconciledByKey.set(key, existing ? { ...entry, id: existing.id } : entry);
  }

  return [
    ...(incomingEntries || []).filter(entry => entry.nutritionistId !== nutritionistId),
    ...reconciledByKey.values()
  ];
}

async function reconcileEntryIds(client, actor, db) {
  const { data: existingEntries, error } = await client
    .from("entries")
    .select("id, entry_date, school_id, nutritionist_id")
    .eq("nutritionist_id", actor.id);
  if (error) throw error;
  return {
    ...db,
    entries: reconcileEntriesWithExisting(db.entries, existingEntries || [], actor.id)
  };
}

function isEntryIdentityConflict(error) {
  return error?.code === "23505"
    && String(error.message || "").includes("entries_entry_date_school_id_nutritionist_id_key");
}

async function upsertNutritionistEntries(client, actor, db) {
  let reconciledDb = await reconcileEntryIds(client, actor, db);
  try {
    await replaceRows(client, "entries", entryRowsFromDb(reconciledDb, actor), "id");
  } catch (error) {
    if (!isEntryIdentityConflict(error)) throw error;
    reconciledDb = await reconcileEntryIds(client, actor, reconciledDb);
    await replaceRows(client, "entries", entryRowsFromDb(reconciledDb, actor), "id");
  }
  return reconciledDb;
}

function hasValidQuantities(entry) {
  if (!entry || entry.status === "not_served") return false;
  const quantities = entry.quantities;
  if (!quantities || typeof quantities !== "object" || Array.isArray(quantities)) return false;
  const values = Object.values(quantities);
  if (!values.length) return false;
  return values.every(value => {
    if (value === "" || value === null || value === undefined) return false;
    return Number.isFinite(Number(String(value).replace(",", ".")));
  });
}

function comparableEntry(entry) {
  const quantities = entry.quantities || Object.fromEntries((entry.entry_items || []).map(item => [item.card_id, item.quantity]));
  return {
    date: entry.date || entry.entry_date || "",
    status: entry.status || "",
    reason: entry.reason || "",
    notes: entry.notes || "",
    quantities: Object.fromEntries(Object.entries(quantities)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([cardId, quantity]) => [cardId, Number(quantity) || 0]))
  };
}

async function assertFinalizedMonthsUnchanged(client, actor, db) {
  if (actor.role === "admin") return;
  const { data: finalizedClosures, error: closuresError } = await client
    .from("monthly_closures")
    .select("month")
    .eq("nutritionist_id", actor.id)
    .eq("status", "sent");
  if (closuresError) throw closuresError;
  const finalizedMonths = new Set((finalizedClosures || []).map(item => item.month));
  if (!finalizedMonths.size) return;

  for (const month of finalizedMonths) {
    const incomingClosure = (db.closures || []).find(item => item.month === month && item.nutritionistId === actor.id);
    if (!incomingClosure || incomingClosure.status !== "sent") {
      const error = new Error(`A competência ${month} já foi encerrada e não pode mais ser alterada.`);
      error.statusCode = 409;
      throw error;
    }
  }

  const { data: existingEntries, error: entriesError } = await client
    .from("entries")
    .select("id, entry_date, month, status, reason, notes, entry_items(card_id, quantity)")
    .eq("nutritionist_id", actor.id)
    .in("month", [...finalizedMonths]);
  if (entriesError) throw entriesError;

  for (const month of finalizedMonths) {
    const current = new Map((existingEntries || [])
      .filter(entry => entry.month === month)
      .map(entry => [entry.id, comparableEntry(entry)]));
    const incoming = new Map((db.entries || [])
      .filter(entry => (entry.month || String(entry.date || "").slice(0, 7)) === month)
      .filter(entry => entry.id)
      .map(entry => [entry.id, comparableEntry(entry)]));
    if (current.size !== incoming.size || [...current].some(([id, value]) => JSON.stringify(value) !== JSON.stringify(incoming.get(id)))) {
      const error = new Error(`A competência ${month} já foi encerrada e não pode mais ser alterada.`);
      error.statusCode = 409;
      throw error;
    }
  }
}

async function entryIdsWithChangedQuantities(client, actor, db) {
  const { data: existingEntries, error } = await client
    .from("entries")
    .select("id, entry_items(card_id, quantity)")
    .eq("nutritionist_id", actor.id);
  if (error) throw error;
  const existingById = new Map((existingEntries || []).map(entry => [entry.id, entry]));

  return (db.entries || [])
    .filter(entry => entry.nutritionistId === actor.id && entry.id)
    .filter(entry => {
      const existing = existingById.get(entry.id);
      if (entry.status === "not_served") return Boolean(existing?.entry_items?.length);
      if (!hasValidQuantities(entry)) return false;
      const currentQuantities = comparableEntry(existing || {}).quantities;
      const incomingQuantities = comparableEntry(entry).quantities;
      return JSON.stringify(currentQuantities) !== JSON.stringify(incomingQuantities);
    })
    .map(entry => entry.id);
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
    const schoolIds = (db.schools || []).map(school => school.id).filter(Boolean);
    if (schoolIds.length) await client.from("nutritionist_schools").delete().in("school_id", schoolIds);
    const assignmentRows = [];
    for (const school of db.schools || []) {
      for (const profileId of school.nutritionistIds || []) assignmentRows.push({ school_id: school.id, profile_id: profileId });
    }
    await replaceRows(client, "nutritionist_schools", assignmentRows, "profile_id,school_id");
    await client.from("settings").upsert({ key: "app", value: db.settings || {}, updated_at: new Date().toISOString() }, { onConflict: "key" });
  }

  if (actor.role === "admin") {
    if (options.seed) {
      await client.from("entry_items").delete().neq("entry_id", "__never__");
      await client.from("entries").delete().neq("id", "__never__");
      await client.from("monthly_closures").delete().neq("id", "__never__");
      await replaceRows(client, "entries", entryRowsFromDb(db, actor), "id");
      await replaceRows(client, "entry_items", entryItemRowsFromDb(db, actor), "entry_id,card_id");
      await replaceRows(client, "monthly_closures", closureRowsFromDb(db, actor), "month,nutritionist_id");
    }
  } else {
    const reconciledDb = await upsertNutritionistEntries(client, actor, db);
    const entriesToReplace = await entryIdsWithChangedQuantities(client, actor, reconciledDb);
    if (entriesToReplace.length) await client.from("entry_items").delete().in("entry_id", entriesToReplace);
    await replaceRows(
      client,
      "entry_items",
      entryItemRowsFromDb(reconciledDb, actor).filter(row => entriesToReplace.includes(row.entry_id)),
      "entry_id,card_id"
    );
    await replaceRows(client, "monthly_closures", closureRowsFromDb(reconciledDb, actor), "month,nutritionist_id");
  }

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

function businessDaysForMonth(db, month) {
  const configured = db.settings?.workingDaysByMonth?.[month];
  if (configured) return Number(configured);
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(year, monthNumber, 0).getDate();
  let total = 0;
  for (let day = 1; day <= lastDay; day += 1) {
    const weekday = new Date(year, monthNumber - 1, day).getDay();
    if (weekday !== 0 && weekday !== 6) total += 1;
  }
  return total || 22;
}

async function exportAverageWorkbook(db, month) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Médias");
  const days = businessDaysForMonth(db, month);
  const columns = [
    { header: "Escola", key: "school", width: 42 },
    { header: "Rota", key: "route", width: 22 },
    { header: "Nutricionista(s)", key: "nutritionists", width: 34 },
    { header: "Dias úteis", key: "days", width: 12 },
    ...(db.cards || []).map(card => ({ header: `${card.label} - Média diária`, key: card.id, width: 19 })),
    { header: "Total geral - Média diária", key: "generalAverage", width: 25 }
  ];
  worksheet.columns = columns;
  worksheet.mergeCells(1, 1, 1, columns.length);
  worksheet.getCell(1, 1).value = `Médias por escola e card - ${month}`;
  worksheet.getCell(1, 1).font = { bold: true, size: 14, color: { argb: "FFFFFFFF" } };
  worksheet.getCell(1, 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF146B5B" } };
  worksheet.getCell(1, 1).alignment = { horizontal: "center" };
  worksheet.mergeCells(2, 1, 2, columns.length);
  worksheet.getCell(2, 1).value = `Média diária = total registrado no card dividido por ${days} dias úteis.`;
  worksheet.getCell(2, 1).font = { italic: true, color: { argb: "FF53635D" } };
  worksheet.getRow(4).values = columns.map(column => column.header);
  worksheet.getRow(4).font = { bold: true, color: { argb: "FFFFFFFF" } };
  worksheet.getRow(4).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF257B6A" } };
  worksheet.getRow(4).alignment = { wrapText: true, vertical: "middle" };
  worksheet.getRow(4).height = 32;

  const totalsBySchool = new Map();
  const nutritionistsBySchool = new Map();
  for (const entry of db.entries || []) {
    if (!String(entry.date || "").startsWith(month)) continue;
    if (!isCompleteEntry(entry) || entry.status === "not_served") continue;
    if (!totalsBySchool.has(entry.schoolId)) totalsBySchool.set(entry.schoolId, new Map());
    if (!nutritionistsBySchool.has(entry.schoolId)) nutritionistsBySchool.set(entry.schoolId, new Set());
    if (entry.nutritionistName) nutritionistsBySchool.get(entry.schoolId).add(entry.nutritionistName);
    for (const [cardId, quantity] of Object.entries(entry.quantities || {})) {
      const numericQuantity = Number(String(quantity ?? "").replace(",", ".")) || 0;
      const schoolTotals = totalsBySchool.get(entry.schoolId);
      schoolTotals.set(cardId, (schoolTotals.get(cardId) || 0) + numericQuantity);
    }
  }

  for (const school of db.schools || []) {
    const totals = totalsBySchool.get(school.id) || new Map();
    const values = [school.shortName, school.route, [...(nutritionistsBySchool.get(school.id) || [])].sort().join(", "), days];
    let generalTotal = 0;
    for (const card of db.cards || []) {
      const total = totals.get(card.id) || 0;
      generalTotal += total;
      values.push(Number((total / days).toFixed(2)));
    }
    values.push(Number((generalTotal / days).toFixed(2)));
    worksheet.addRow(values);
  }
  for (let rowNumber = 5; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    worksheet.getRow(rowNumber).eachCell((cell, columnNumber) => {
      if (columnNumber >= 5) cell.numFmt = "0.00";
    });
  }
  worksheet.autoFilter = { from: "A4", to: `${String.fromCharCode(64 + columns.length)}${worksheet.rowCount}` };
  worksheet.views = [{ state: "frozen", ySplit: 4 }];
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
      await assertFinalizedMonthsUnchanged(client, actor, db);
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

    if (event.httpMethod === "POST" && action === "export-media") {
      if (actor.role !== "admin") return json(403, { error: "Apenas a coordenação pode exportar." });
      const body = parseBody(event);
      if (!body.month || !/^\d{4}-\d{2}$/.test(body.month)) {
        return json(400, { error: "Informe a competência no formato AAAA-MM." });
      }
      const db = await loadRelationalState(client, actor);
      const buffer = await exportAverageWorkbook(db, body.month);
      const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
      const filename = `apuracao-medias-${body.month}-${stamp}.xlsx`;
      await client.from("exports").insert({ id: `export-media-${Date.now()}`, month: body.month, filename, rows: db.schools.length });
      await logAudit(client, actor, "export", "xlsx-media", filename, { month: body.month });
      return json(200, {
        ok: true,
        filename,
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        base64: buffer.toString("base64")
      });
    }

    return json(404, { error: "Rota nao encontrada." });
  } catch (error) {
    return json(error.statusCode || 500, { error: error.message });
  }
};

exports._test = {
  entryIdentityKey,
  reconcileEntriesWithExisting,
  isEntryIdentityConflict,
  businessDaysForMonth,
  exportAverageWorkbook
};
