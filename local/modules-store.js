// Persistência dos módulos novos no Supabase (produção).
//
// A API dos módulos (local/modules-api.js) trabalha com um "documento" em memória, no mesmo
// formato do local-data/modules.json. Este arquivo converte esse documento para as tabelas do
// Supabase (supabase/migrations/20261106_01_modulos.sql) e de volta, e grava só o que mudou:
// depois de cada ação, compara cada linha com a última versão gravada e faz upsert das linhas
// novas/alteradas e delete das que saíram.
//
// Premissa: um único processo Node (Hostinger). O documento em memória é carregado do banco
// quando o servidor sobe e depois de qualquer falha ao gravar.
const { createClient } = require("@supabase/supabase-js");

const BUCKET = "anexos";
const PAGE = 1000;
const CHUNK = 500;
const AUDIENCE_LABELS = { alunos: "Alunos", adultos: "Adultos", ambos: "Alunos/Adultos" };

let client = null;
// Testes podem trocar o cliente por um banco falso.
function setClient(fake) {
  client = fake;
}

function db() {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY na hospedagem.");
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}

const nul = value => (value === "" || value === undefined ? null : value);
const str = value => (value === null || value === undefined ? "" : String(value));
const num = value => (value === null || value === undefined || value === "" ? null : Number(value));

// ------------------------------------------------------------------ tabelas
// Ordem = ordem de gravação (pais antes dos filhos). O delete usa a ordem inversa.
// parent: tabela-mãe com "on delete cascade" (se a mãe saiu, os filhos saem sozinhos).
const TABLES = [
  { name: "enrollments", pk: ["school_id"] },
  { name: "supervision_reports", pk: ["id"] },
  { name: "events", pk: ["id"] },
  { name: "notifications", pk: ["id"] },
  { name: "notification_responses", pk: ["notification_id", "nutritionist_id"], parent: ["notifications", "notification_id"] },
  { name: "inventory_items", pk: ["id"] },
  { name: "inventory_counts", pk: ["month", "school_id", "item_id"], parent: ["inventory_items", "item_id"] },
  { name: "inventory_submissions", pk: ["month", "school_id"] },
  { name: "inventory_deadlines", pk: ["month", "route_name"] },
  { name: "orders", pk: ["id"] },
  { name: "order_lines", pk: ["order_id", "id"], parent: ["orders", "order_id"] },
  { name: "order_adjustments", pk: ["order_id", "nutritionist_id"], parent: ["orders", "order_id"] },
  { name: "order_history", pk: ["id"], parent: ["orders", "order_id"] },
  { name: "km_vehicles", pk: ["nutritionist_id"] },
  { name: "km_logs", pk: ["month", "nutritionist_id"] },
  { name: "trainings", pk: ["month"] },
  { name: "training_submissions", pk: ["month", "nutritionist_id"] }
];

// Arquivo guardado no banco: sem o link (o link temporário é gerado a cada leitura).
function fileRow(file) {
  if (!file) return null;
  const { url, ...rest } = file;
  return rest.path ? rest : file;
}
const fileRows = files => (Array.isArray(files) ? files.map(fileRow).filter(Boolean) : []);

// ------------------------------------------------------------------ documento -> linhas
function toRows(doc) {
  const rows = Object.fromEntries(TABLES.map(table => [table.name, []]));
  for (const [schoolId, item] of Object.entries(doc.enrollments || {})) {
    rows.enrollments.push({ school_id: schoolId, segments: item.segments || {}, updated_at: item.updatedAt || null, updated_by: nul(item.updatedBy) });
  }
  for (const item of doc.supervisionReports || []) {
    rows.supervision_reports.push({
      id: item.id, school_id: item.schoolId, nutritionist_id: item.nutritionistId, report_date: item.date, notes: str(item.notes),
      report_file: fileRow(item.reportFile), photos: fileRows(item.photos), created_at: item.createdAt, updated_at: item.updatedAt || item.createdAt
    });
  }
  for (const evt of doc.events || []) {
    rows.events.push({
      id: evt.id, school_id: evt.schoolId, nutritionist_id: nul(evt.nutritionistId), request_date: nul(evt.requestDate), event_date: nul(evt.eventDate),
      event: str(evt.event), audience: evt.audience || "alunos", student_qty: Number(evt.studentQty) || 0, student_billed: evt.studentBilled !== false,
      adult_qty: Number(evt.adultQty) || 0, adult_meal: str(evt.adultMeal), has_fruit: Boolean(evt.hasFruit), food: str(evt.food), notes: str(evt.notes),
      approval: evt.approval || "pendente", approval_at: nul(evt.approvalAt), approval_by: nul(evt.approvalBy),
      attendance: nul(evt.attendance), attendance_at: nul(evt.attendanceAt), attendance_by: nul(evt.attendanceBy),
      done: Boolean(evt.done), done_at: nul(evt.doneAt), created_at: evt.createdAt, created_by: nul(evt.createdBy), updated_at: evt.updatedAt || evt.createdAt
    });
  }
  for (const item of doc.notifications || []) {
    rows.notifications.push({
      id: item.id, title: str(item.title), description: str(item.description), due_date: nul(item.dueDate), questions: item.questions || [],
      school_ids: item.schoolIds || [], target_ids: item.targetIds || [], final_file: fileRow(item.finalFile),
      created_by: nul(item.createdBy), created_at: item.createdAt, closed_at: nul(item.closedAt)
    });
    for (const [nutriId, response] of Object.entries(item.responses || {})) {
      if (!response) continue;
      rows.notification_responses.push({
        notification_id: item.id, nutritionist_id: nutriId, answers: response.answers || {}, attachments: fileRows(response.attachments),
        name: nul(response.name), responded_at: response.respondedAt
      });
    }
  }
  (doc.inventoryItems || []).forEach((item, index) => {
    rows.inventory_items.push({
      id: item.id, name: item.name, category: item.category, unit: item.unit || "KG", price: num(item.price), active: item.active !== false,
      sort_order: index, created_at: item.createdAt, updated_at: item.updatedAt || item.createdAt
    });
  });
  for (const [month, bySchool] of Object.entries(doc.inventoryCounts || {})) {
    for (const [schoolId, counts] of Object.entries(bySchool || {})) {
      for (const [itemId, row] of Object.entries(counts || {})) {
        rows.inventory_counts.push({ month, school_id: schoolId, item_id: itemId, quantity: Number(row.quantity) || 0, updated_at: row.updatedAt || null, updated_by: nul(row.updatedBy) });
      }
    }
  }
  for (const [month, bySchool] of Object.entries(doc.inventorySubmissions || {})) {
    for (const [schoolId, sub] of Object.entries(bySchool || {})) {
      if (!sub) continue;
      rows.inventory_submissions.push({ month, school_id: schoolId, sent_at: sub.sentAt, sent_by: nul(sub.sentBy), sent_by_id: nul(sub.sentById), items: Number(sub.items) || 0 });
    }
  }
  for (const [month, byRoute] of Object.entries(doc.inventoryDeadlines || {})) {
    for (const [route, date] of Object.entries(byRoute || {})) {
      if (date) rows.inventory_deadlines.push({ month, route_name: route, deadline: date });
    }
  }
  for (const order of doc.orders || []) {
    rows.orders.push({
      id: order.id, title: order.title, month: order.month, delivery_date: nul(order.deliveryDate), file_name: str(order.fileName), sheet: str(order.sheet),
      unmatched: order.unmatched || [], skipped: Number(order.skipped) || 0, created_at: order.createdAt, created_by: nul(order.createdBy)
    });
    for (const line of order.lines || []) {
      rows.order_lines.push({ order_id: order.id, id: line.id, school_id: line.schoolId, item: line.item, unit: str(line.unit), qty: Number(line.qty) || 0, nutritionist_id: nul(line.nutritionistId) });
    }
    for (const [nutriId, adj] of Object.entries(order.adjustments || {})) {
      if (!adj) continue;
      rows.order_adjustments.push({
        order_id: order.id, nutritionist_id: nutriId, adj_values: adj.values || {}, saved_at: nul(adj.savedAt), sent_at: nul(adj.sentAt), sent_by: nul(adj.sentBy),
        finalized_at: nul(adj.finalizedAt), finalized_by: nul(adj.finalizedBy)
      });
    }
    for (const entry of order.history || []) {
      rows.order_history.push({ id: entry.id, order_id: order.id, at: entry.at, nutritionist_id: nul(entry.nutritionistId), by_name: nul(entry.by), action: entry.action, changes: entry.changes || [], imported: Boolean(entry.imported) });
    }
  }
  for (const [nutriId, vehicle] of Object.entries(doc.km?.vehicles || {})) {
    rows.km_vehicles.push({ nutritionist_id: nutriId, plate: vehicle.plate, set_at: vehicle.setAt, set_by: nul(vehicle.setBy) });
  }
  for (const [month, byNutri] of Object.entries(doc.km?.logs || {})) {
    for (const [nutriId, log] of Object.entries(byNutri || {})) {
      if (!log) continue;
      rows.km_logs.push({
        month, nutritionist_id: nutriId, days: log.days || {}, fuel: log.fuel || {}, saved_at: nul(log.savedAt), sent_at: nul(log.sentAt), sent_by: nul(log.sentBy), review: log.review || null
      });
    }
  }
  for (const item of doc.trainings || []) {
    rows.trainings.push({ month: item.month, theme: item.theme, deadline: item.deadline, files: fileRows(item.files), created_at: item.createdAt, updated_at: item.updatedAt || item.createdAt, updated_by: nul(item.updatedBy) });
  }
  for (const [month, byNutri] of Object.entries(doc.trainingSubmissions || {})) {
    for (const [nutriId, sub] of Object.entries(byNutri || {})) {
      if (!sub) continue;
      rows.training_submissions.push({
        month, nutritionist_id: nutriId, files: fileRows(sub.files), notes: str(sub.notes), sent_at: sub.sentAt, sent_by: nul(sub.sentBy), review: sub.review || null,
        history: (sub.history || []).map(entry => ({ ...entry, files: fileRows(entry.files) }))
      });
    }
  }
  return rows;
}

// ------------------------------------------------------------------ linhas -> documento
const opt = (target, key, value) => { if (value !== null && value !== undefined) target[key] = value; };

function fromRows(rows) {
  const doc = {
    version: 5, supervisionReports: [], enrollments: {}, events: [], notifications: [], inventoryItems: [], inventoryCounts: {},
    inventorySubmissions: {}, inventoryDeadlines: {}, orders: [], km: { vehicles: {}, logs: {} }, trainings: [], trainingSubmissions: {}
  };
  for (const row of rows.enrollments || []) {
    doc.enrollments[row.school_id] = { segments: row.segments || {}, updatedAt: row.updated_at, updatedBy: row.updated_by || "" };
  }
  for (const row of rows.supervision_reports || []) {
    doc.supervisionReports.push({
      id: row.id, createdAt: row.created_at, schoolId: row.school_id, nutritionistId: row.nutritionist_id, date: row.report_date, notes: row.notes || "",
      reportFile: row.report_file || null, photos: row.photos || [], updatedAt: row.updated_at
    });
  }
  for (const row of rows.events || []) {
    const evt = {
      id: row.id, createdAt: row.created_at, createdBy: row.created_by || "", schoolId: row.school_id, nutritionistId: row.nutritionist_id || "",
      requestDate: row.request_date || "", event: row.event, audience: row.audience, targetAudience: AUDIENCE_LABELS[row.audience] || "",
      studentQty: row.student_qty, studentBilled: row.student_billed !== false, adultQty: row.adult_qty, adultMeal: row.adult_meal || "",
      quantity: (row.student_qty || 0) + (row.adult_qty || 0) || "", hasFruit: Boolean(row.has_fruit), food: row.food || "", notes: row.notes || "",
      eventDate: row.event_date || "", approval: row.approval, attendance: row.attendance || null, done: Boolean(row.done), updatedAt: row.updated_at
    };
    opt(evt, "approvalAt", row.approval_at); opt(evt, "approvalBy", row.approval_by);
    opt(evt, "attendanceAt", row.attendance_at); opt(evt, "attendanceBy", row.attendance_by);
    opt(evt, "doneAt", row.done_at);
    doc.events.push(evt);
  }
  const byNotification = new Map();
  for (const row of rows.notifications || []) {
    const item = {
      id: row.id, title: row.title, description: row.description || "", dueDate: row.due_date || "", questions: row.questions || [],
      schoolIds: row.school_ids || [], targetIds: row.target_ids || [], responses: {}, finalFile: row.final_file || null,
      createdBy: row.created_by || "", createdAt: row.created_at, closedAt: row.closed_at || null
    };
    byNotification.set(row.id, item);
    doc.notifications.push(item);
  }
  for (const row of rows.notification_responses || []) {
    const item = byNotification.get(row.notification_id);
    if (item) item.responses[row.nutritionist_id] = { answers: row.answers || {}, attachments: row.attachments || [], respondedAt: row.responded_at, name: row.name || "" };
  }
  doc.notifications.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  for (const row of [...(rows.inventory_items || [])].sort((a, b) => a.sort_order - b.sort_order)) {
    const item = { id: row.id, name: row.name, category: row.category, unit: row.unit, active: row.active !== false, createdAt: row.created_at };
    if (row.price !== null && row.price !== undefined) item.price = Number(row.price);
    if (row.updated_at && row.updated_at !== row.created_at) item.updatedAt = row.updated_at;
    doc.inventoryItems.push(item);
  }
  for (const row of rows.inventory_counts || []) {
    ((doc.inventoryCounts[row.month] ||= {})[row.school_id] ||= {})[row.item_id] = { quantity: Number(row.quantity), updatedAt: row.updated_at, updatedBy: row.updated_by || "" };
  }
  for (const row of rows.inventory_submissions || []) {
    (doc.inventorySubmissions[row.month] ||= {})[row.school_id] = { sentAt: row.sent_at, sentBy: row.sent_by || "", sentById: row.sent_by_id || "", items: row.items };
  }
  for (const row of rows.inventory_deadlines || []) {
    (doc.inventoryDeadlines[row.month] ||= {})[row.route_name] = row.deadline;
  }
  const byOrder = new Map();
  for (const row of rows.orders || []) {
    const order = {
      id: row.id, title: row.title, month: row.month, deliveryDate: row.delivery_date || "", fileName: row.file_name || "", sheet: row.sheet || "",
      createdAt: row.created_at, createdBy: row.created_by || "", lines: [], unmatched: row.unmatched || [], skipped: row.skipped || 0, adjustments: {}, history: []
    };
    byOrder.set(row.id, order);
    doc.orders.push(order);
  }
  const lineNumber = id => Number(String(id).replace(/\D/g, "")) || 0;
  for (const row of [...(rows.order_lines || [])].sort((a, b) => lineNumber(a.id) - lineNumber(b.id))) {
    byOrder.get(row.order_id)?.lines.push({ id: row.id, schoolId: row.school_id, item: row.item, unit: row.unit || "", qty: Number(row.qty), nutritionistId: row.nutritionist_id || "" });
  }
  for (const row of rows.order_adjustments || []) {
    const adj = { values: row.adj_values || {} };
    opt(adj, "savedAt", row.saved_at); opt(adj, "sentAt", row.sent_at); opt(adj, "sentBy", row.sent_by);
    opt(adj, "finalizedAt", row.finalized_at); opt(adj, "finalizedBy", row.finalized_by);
    const order = byOrder.get(row.order_id);
    if (order) order.adjustments[row.nutritionist_id] = adj;
  }
  for (const row of [...(rows.order_history || [])].sort((a, b) => String(a.at).localeCompare(String(b.at)))) {
    const entry = { id: row.id, at: row.at, nutritionistId: row.nutritionist_id || "", by: row.by_name || "", action: row.action, changes: row.changes || [] };
    if (row.imported) entry.imported = true;
    byOrder.get(row.order_id)?.history.push(entry);
  }
  doc.orders.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  for (const row of rows.km_vehicles || []) {
    doc.km.vehicles[row.nutritionist_id] = { plate: row.plate, setAt: row.set_at, setBy: row.set_by || "" };
  }
  for (const row of rows.km_logs || []) {
    const log = { days: row.days || {} };
    if (row.fuel && Object.keys(row.fuel).length) log.fuel = row.fuel;
    opt(log, "savedAt", row.saved_at); opt(log, "sentAt", row.sent_at); opt(log, "sentBy", row.sent_by); opt(log, "review", row.review);
    (doc.km.logs[row.month] ||= {})[row.nutritionist_id] = log;
  }
  for (const row of rows.trainings || []) {
    doc.trainings.push({ month: row.month, theme: row.theme, deadline: row.deadline, files: row.files || [], createdAt: row.created_at, updatedAt: row.updated_at, updatedBy: row.updated_by || "" });
  }
  doc.trainings.sort((a, b) => b.month.localeCompare(a.month));
  for (const row of rows.training_submissions || []) {
    const sub = { files: row.files || [], notes: row.notes || "", sentAt: row.sent_at, sentBy: row.sent_by || "", history: row.history || [] };
    opt(sub, "review", row.review);
    (doc.trainingSubmissions[row.month] ||= {})[row.nutritionist_id] = sub;
  }
  return doc;
}

// ------------------------------------------------------------------ leitura e gravação
const keyOf = (table, row) => table.pk.map(col => String(row[col])).join("\u0001");

// Linha normalizada para comparar com o que veio do banco (datas e números no mesmo formato).
function stable(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    const time = Date.parse(value);
    return Number.isNaN(time) ? value : new Date(time).toISOString();
  }
  return value;
}
const fingerprint = row => JSON.stringify(stable(row));

function snapshot(rows) {
  const result = {};
  for (const table of TABLES) {
    const map = new Map();
    for (const row of rows[table.name] || []) map.set(keyOf(table, row), fingerprint(row));
    result[table.name] = map;
  }
  return result;
}

async function selectAll(table, filter = query => query) {
  const all = [];
  const order = TABLES.find(item => item.name === table).pk;
  for (let from = 0; ; from += PAGE) {
    let query = filter(db().from(table).select("*"));
    for (const col of order) query = query.order(col, { ascending: true });
    const { data, error } = await query.range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    all.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return all;
}

let baseline = null;
const ORDER_TABLES = new Set(["orders", "order_lines", "order_adjustments", "order_history"]);
const ORDER_CHILDREN = ["order_lines", "order_adjustments", "order_history"];

// Linhas, ajustes e histórico dos pedidos escolhidos (busca em lotes de ids).
async function orderChildren(ids) {
  const rows = Object.fromEntries(ORDER_CHILDREN.map(name => [name, []]));
  for (let index = 0; index < ids.length; index += 50) {
    const batch = ids.slice(index, index + 50);
    for (const name of ORDER_CHILDREN) rows[name].push(...await selectAll(name, query => query.in("order_id", batch)));
  }
  return rows;
}

// Pedidos "recentes": do mês de corte em diante, ou criados depois da data de corte.
const recentFilter = recent => query => query.or(`month.gte.${recent.month},created_at.gte.${recent.createdAt}`);
const olderFilter = recent => query => query.lt("month", recent.month).lt("created_at", recent.createdAt);

// recent = { month: "2026-09", createdAt: "2026-08-08T00:00:00.000Z" }: só os pedidos recentes entram na memória.
async function loadDoc(recent = null) {
  const rows = {};
  for (const table of TABLES) {
    if (ORDER_TABLES.has(table.name)) continue;
    rows[table.name] = await selectAll(table.name);
  }
  rows.orders = await selectAll("orders", recent ? recentFilter(recent) : query => query);
  Object.assign(rows, await orderChildren(rows.orders.map(row => row.id)));
  const doc = fromRows(rows);
  baseline = snapshot(toRows(doc));
  return doc;
}

// Pedidos antigos, só para leitura (não entram na memória nem na gravação).
async function loadOlderOrders(recent) {
  const orders = await selectAll("orders", olderFilter(recent));
  return fromRows({ orders, ...(await orderChildren(orders.map(row => row.id))) }).orders;
}

async function countOlderOrders(recent) {
  const { count, error } = await olderFilter(recent)(db().from("orders").select("id", { count: "exact", head: true }));
  if (error) throw new Error(`orders: ${error.message}`);
  return count || 0;
}

function forgetBaseline() {
  baseline = null;
}

async function upsert(table, rows) {
  for (let index = 0; index < rows.length; index += CHUNK) {
    const { error } = await db().from(table.name).upsert(rows.slice(index, index + CHUNK), { onConflict: table.pk.join(",") });
    if (error) throw new Error(`${table.name}: ${error.message}`);
  }
}

async function remove(table, keys) {
  // agrupa pelas colunas da chave menos a última: delete ... where (prefixo) and ultima in (...)
  const groups = new Map();
  for (const key of keys) {
    const parts = key.split("\u0001");
    const prefix = parts.slice(0, -1).join("\u0001");
    if (!groups.has(prefix)) groups.set(prefix, { match: Object.fromEntries(table.pk.slice(0, -1).map((col, index) => [col, parts[index]])), values: [] });
    groups.get(prefix).values.push(parts[parts.length - 1]);
  }
  const last = table.pk[table.pk.length - 1];
  for (const { match, values } of groups.values()) {
    for (let index = 0; index < values.length; index += CHUNK) {
      let query = db().from(table.name).delete();
      if (Object.keys(match).length) query = query.match(match);
      const { error } = await query.in(last, values.slice(index, index + CHUNK));
      if (error) throw new Error(`${table.name}: ${error.message}`);
    }
  }
}

// Grava as diferenças entre o documento e a última versão gravada.
async function persistDoc(doc) {
  if (!baseline) throw new Error("Base dos módulos não carregada.");
  const rows = toRows(doc);
  const next = {};
  const changes = [];
  for (const table of TABLES) {
    const before = baseline[table.name];
    const map = new Map();
    const changed = [];
    for (const row of rows[table.name]) {
      const key = keyOf(table, row);
      const print = fingerprint(row);
      map.set(key, print);
      if (before.get(key) !== print) changed.push(row);
    }
    const removed = [...before.keys()].filter(key => !map.has(key));
    next[table.name] = map;
    changes.push({ table, changed, removed });
  }
  const removedKeys = Object.fromEntries(changes.map(item => [item.table.name, new Set(item.removed)]));
  for (const { table, changed } of changes) if (changed.length) await upsert(table, changed);
  for (const { table, removed } of [...changes].reverse()) {
    if (!removed.length) continue;
    // filhos de uma linha-mãe apagada saem sozinhos (on delete cascade)
    const keys = table.parent
      ? removed.filter(key => {
        const parentKey = key.split("\u0001")[table.pk.indexOf(table.parent[1])] ?? null;
        return parentKey === null || !removedKeys[table.parent[0]].has(parentKey);
      })
      : removed;
    if (table.name === "order_history" && keys.length) {
      // order_history tem pk só "id"; o pedido apagado já levou o histórico junto
      const orderOf = new Map((baselineRowsCache.order_history || []).map(row => [row.id, row.order_id]));
      const filtered = keys.filter(key => !removedKeys.orders.has(orderOf.get(key)));
      if (filtered.length) await remove(table, filtered);
      continue;
    }
    if (keys.length) await remove(table, keys);
  }
  baseline = next;
  baselineRowsCache = { order_history: rows.order_history.map(row => ({ id: row.id, order_id: row.order_id })) };
  return changes.reduce((sum, item) => sum + item.changed.length + item.removed.length, 0);
}
let baselineRowsCache = {};

async function loadDocWithCache(recent = null) {
  const doc = await loadDoc(recent);
  baselineRowsCache = { order_history: toRows(doc).order_history.map(row => ({ id: row.id, order_id: row.order_id })) };
  return doc;
}

// ------------------------------------------------------------------ cadastros do sistema original
// Escolas, rotas, nutricionistas e cards vêm das tabelas originais (só leitura aqui).
let refsCache = null;
let refsAt = 0;
async function loadRefs(maxAgeMs = 15000) {
  if (refsCache && Date.now() - refsAt < maxAgeMs) return refsCache;
  const read = async (table, columns) => {
    const all = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db().from(table).select(columns).range(from, from + PAGE - 1);
      if (error) throw new Error(`${table}: ${error.message}`);
      all.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }
    return all;
  };
  const [profiles, routes, schools, nutritionistSchools, cards] = await Promise.all([
    read("profiles", "id,name,username,role,active"),
    read("routes", "id,name"),
    read("schools", "id,row_number,code,name,short_name,route_id,active"),
    read("nutritionist_schools", "profile_id,school_id"),
    read("cards", "id,number,label,description,price,column_number,active")
  ]);
  refsCache = { profiles, routes, schools, nutritionist_schools: nutritionistSchools, cards };
  refsAt = Date.now();
  return refsCache;
}

function refs() {
  if (!refsCache) throw new Error("Cadastros não carregados.");
  return refsCache;
}

async function insertExport(row) {
  const { error } = await db().from("exports").insert(row);
  if (error) throw new Error(`exports: ${error.message}`);
}

// ------------------------------------------------------------------ anexos (Storage)
async function uploadFile(storagePath, buffer, contentType) {
  const { error } = await db().storage.from(BUCKET).upload(storagePath, buffer, { contentType: contentType || "application/octet-stream", upsert: false });
  if (error) throw new Error(`Não foi possível guardar o arquivo: ${error.message}`);
}

// Links temporários (1 h) para os arquivos que aparecem na resposta. Reaproveita por 40 min.
const signed = new Map();
const SIGN_SECONDS = 3600;
const REUSE_MS = 40 * 60 * 1000;

function collectFiles(value, found) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { for (const item of value) collectFiles(item, found); return; }
  if (typeof value.path === "string" && value.id && value.name !== undefined) found.push(value);
  for (const child of Object.values(value)) if (child && typeof child === "object") collectFiles(child, found);
}

async function signFiles(body) {
  const files = [];
  collectFiles(body, files);
  if (!files.length) return body;
  const now = Date.now();
  const missing = [...new Set(files.map(file => file.path))].filter(path => !(signed.get(path)?.until > now));
  for (let index = 0; index < missing.length; index += 100) {
    const batch = missing.slice(index, index + 100);
    const { data, error } = await db().storage.from(BUCKET).createSignedUrls(batch, SIGN_SECONDS);
    if (error) throw new Error(`Não foi possível gerar os links dos arquivos: ${error.message}`);
    for (const item of data || []) if (item.signedUrl) signed.set(item.path, { url: item.signedUrl, until: now + REUSE_MS });
  }
  for (const file of files) file.url = signed.get(file.path)?.url || "";
  return body;
}

module.exports = {
  BUCKET, TABLES, toRows, fromRows, snapshot, setClient,
  loadDoc: loadDocWithCache, persistDoc, forgetBaseline, loadOlderOrders, countOlderOrders,
  loadRefs, refs, insertExport, uploadFile, signFiles
};
