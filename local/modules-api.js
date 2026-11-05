// API dos novos módulos (Supervisão, Matriculados, Eventos, Notificações, Inventário).
// Versão local: dados em local-data/modules.json e anexos em local-data/uploads/.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { localStore, createLocalClient, flush: flushStore, DATA_DIR } = require("./local-supabase");
const coreApi = require("../netlify/functions/api");
const { _local: core } = coreApi;
const xl = require("./xlsx-helpers");
const ordersReader = require("./orders-reader");

const MODULES_FILE = path.join(DATA_DIR, "modules.json");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const MAX_FILE_BYTES = 25 * 1024 * 1024;

let modules = null;

function load() {
  if (modules) return modules;
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  modules = fs.existsSync(MODULES_FILE) ? JSON.parse(fs.readFileSync(MODULES_FILE, "utf8")) : {};
  modules.supervisionReports ||= [];
  modules.enrollments ||= {};
  modules.events ||= [];
  modules.notifications ||= [];
  modules.inventoryItems ||= [];
  modules.inventoryCounts ||= {};
  modules.inventorySubmissions ||= {};
  modules.inventoryDeadlines ||= {};
  modules.orders ||= [];
  modules.km ||= { vehicles: {}, logs: {} };
  modules.trainings ||= [];
  modules.trainingSubmissions ||= {};
  if ((modules.version || 1) < 2) migrateV2(modules);
  if (modules.version < 3) migrateV3(modules);
  if (modules.version < 4) migrateV4(modules);
  ensureAdmProfile();
  return modules;
}

// v4: público alvo vira categoria (Alunos / Adultos / Alunos e adultos) com quantidades separadas.
function migrateV4(db) {
  for (const evt of db.events) {
    if (evt.audience) continue;
    const oldText = String(evt.targetAudience || "").trim();
    evt.audience = "alunos";
    evt.studentQty = Number(evt.quantity) || 0;
    evt.adultQty = 0;
    evt.adultMeal = "";
    evt.hasFruit = false;
    evt.targetAudience = AUDIENCE_LABELS.alunos;
    if (oldText && !Object.values(AUDIENCE_LABELS).some(label => label.toLowerCase() === oldText.toLowerCase())) evt.notes = [evt.notes, `Público informado antes: ${oldText}`].filter(Boolean).join(" · ");
  }
  db.version = 4;
  const tmp = `${MODULES_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, MODULES_FILE);
}

// v2: inventário com 4 categorias fixas, ativo/inativo global e contagem por escola.
function migrateV2(db) {
  const { INVENTORY_ITEMS } = require("../scripts/inventory-catalog");
  const now = new Date().toISOString();
  db.inventoryItems = INVENTORY_ITEMS.map(([name, category, unit], index) => ({ id: `ins-${index + 1}`, name, category, unit, active: true, createdAt: now }));
  db.inventoryCounts = {};
  db.version = 2;
  const tmp = `${MODULES_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, MODULES_FILE);
}

// v3: catálogo de insumos da "Planilha de inventario 2026" e matriculados da planilha "ME SSA- NÚMERO DE MATRICULADOS".
function migrateV3(db) {
  const { INVENTORY_ITEMS } = require("../scripts/inventory-catalog");
  const { enrollmentsFor } = require("../scripts/enrollment-data");
  const now = new Date().toISOString();
  db.inventoryItems = INVENTORY_ITEMS.map(([name, category, unit], index) => ({ id: `ins-${index + 1}`, name, category, unit, active: true, createdAt: now }));
  db.inventoryCounts = {};
  db.enrollments = enrollmentsFor(localStore().schools);
  db.version = 3;
  const tmp = `${MODULES_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, MODULES_FILE);
}

function save() {
  const tmp = `${MODULES_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(modules, null, 2));
  fs.renameSync(tmp, MODULES_FILE);
}

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

function fail(status, message) {
  const error = new Error(message);
  error.statusCode = status;
  throw error;
}

function actorFrom(headers) {
  const token = core.verifyToken({ headers });
  if (!token) return null;
  return localStore().profiles.find(profile => profile.id === token.sub && profile.active !== false) || null;
}

function schoolIdsOf(nutritionistId) {
  return new Set(localStore().nutritionist_schools.filter(item => item.profile_id === nutritionistId).map(item => item.school_id));
}

function requireAdmin(actor) {
  if (actor.role !== "admin") fail(403, "Apenas a coordenação pode realizar esta ação.");
}

function cleanFile(file) {
  if (!file || typeof file !== "object" || !file.id || !file.url) return null;
  return { id: String(file.id), name: String(file.name || "arquivo"), url: String(file.url), size: Number(file.size || 0), type: String(file.type || "") };
}

function cleanFiles(files) {
  return (Array.isArray(files) ? files : []).map(cleanFile).filter(Boolean);
}

function stateFor(actor) {
  const db = load();
  const isAdmin = actor.role === "admin";
  const own = isAdmin ? null : schoolIdsOf(actor.id);
  const { cardsById } = directory();
  return {
    supervisionReports: isAdmin ? db.supervisionReports : db.supervisionReports.filter(item => item.nutritionistId === actor.id),
    enrollments: db.enrollments,
    events: (isAdmin ? db.events : db.events.filter(item => item.nutritionistId ? item.nutritionistId === actor.id : own.has(item.schoolId)))
      .map(item => ({ ...item, billing: eventAllocations(db, item, cardsById) })),
    inventoryDeadlines: db.inventoryDeadlines,
    orders: isAdmin ? db.orders : ordersForNutri(db, actor.id),
    today: localToday(),
    notifications: (isAdmin ? db.notifications : db.notifications.filter(item => (item.targetIds || []).includes(actor.id)))
      .map(item => isAdmin ? item : { ...item, responses: { [actor.id]: item.responses?.[actor.id] || null } }),
    inventoryItems: isAdmin ? db.inventoryItems : db.inventoryItems.filter(item => item.active !== false).map(({ price, ...item }) => item),
    inventoryCounts: isAdmin ? db.inventoryCounts : countsFor(db.inventoryCounts, own),
    inventorySubmissions: isAdmin ? db.inventorySubmissions : countsFor(db.inventorySubmissions, own),
    km: kmStateFor(db, actor),
    trainings: db.trainings,
    trainingSubmissions: actor.role === "nutritionist" ? pickNutri(db.trainingSubmissions, actor.id) : db.trainingSubmissions,
    people: actor.role === "nutritionist" ? [] : directory().nutris.map(nutri => ({ id: nutri.id, name: nutri.name, username: nutri.username })),
    ownSchoolIds: own ? [...own] : null
  };
}

const INVENTORY_CATEGORIES = ["Secos", "Congelados", "Produtos de Limpeza / Descartáveis", "Aprender+"];
const ATTENDANCE = ["realizado", "nao_realizado"];
const APPROVAL = ["pendente", "aprovado", "reprovado"];
const APPROVAL_TEXT = { pendente: "Aguardando aprovação", aprovado: "Aprovado", reprovado: "Não aprovado" };
const ATTENDANCE_TEXT = { realizado: "Realizado", nao_realizado: "Não realizado" };
const AUDIENCE_LABELS = { alunos: "Alunos", adultos: "Adultos", ambos: "Alunos/Adultos" };
const ADULT_MEALS = { almoco: { label: "Almoço", cardId: "card11" }, lanche: { label: "Lanche", cardId: "card10" } };
const ADULT_CARD_IDS = new Set(Object.values(ADULT_MEALS).map(meal => meal.cardId));

function pad2(value) {
  return String(value).padStart(2, "0");
}

function localToday() {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

// Escolas, rotas, cards e nutricionistas direto da base local (formato usado pelas planilhas).
function directory() {
  const store = localStore();
  const routes = new Map(store.routes.map(route => [route.id, route.name]));
  const profiles = new Map(store.profiles.map(profile => [profile.id, profile]));
  const schools = store.schools.map(school => ({
    id: school.id, code: school.code, name: school.name, shortName: school.short_name || school.name,
    route: routes.get(school.route_id) || "SEM ROTA", nutritionistIds: nutriIdsOf(school.id)
  }));
  const cards = store.cards.filter(card => card.active !== false).sort((a, b) => a.number - b.number);
  const nutris = store.profiles.filter(profile => profile.role === "nutritionist" && profile.active !== false)
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  return { schools, schoolsById: new Map(schools.map(school => [school.id, school])), cards, cardsById: new Map(cards.map(card => [card.id, card])), nutris, profiles };
}

// Regra do faturamento de eventos:
//  - alunos  -> card de aluno mais caro da escola (pelos segmentos de matriculados);
//  - adultos -> almoço no CARD 11, lanche no DESJEJUM/LANCHE (card 10).
function studentCardFor(db, schoolId, cardsById) {
  const segments = db.enrollments[schoolId]?.segments || {};
  const candidates = Object.entries(segments)
    .filter(([cardId, value]) => Number(value) > 0 && !ADULT_CARD_IDS.has(cardId) && cardsById.has(cardId))
    .map(([cardId]) => cardsById.get(cardId))
    .sort((a, b) => Number(b.price) - Number(a.price) || a.number - b.number);
  return candidates[0] || null;
}

function cardTitle(card) {
  return !card.description || card.description === card.label ? card.label : `${card.label} · ${card.description}`;
}

function eventAllocations(db, evt, cardsById = directory().cardsById) {
  const result = [];
  const students = Number(evt.studentQty) || 0;
  const adults = Number(evt.adultQty) || 0;
  if (students > 0) {
    const card = studentCardFor(db, evt.schoolId, cardsById);
    result.push(card
      ? { cardId: card.id, cardLabel: cardTitle(card), qty: students, who: "Alunos" }
      : { cardId: null, cardLabel: "Escola sem segmento de alunos em Matriculados", qty: students, who: "Alunos" });
  }
  if (adults > 0) {
    const meal = ADULT_MEALS[evt.adultMeal];
    const card = meal ? cardsById.get(meal.cardId) : null;
    result.push(card
      ? { cardId: card.id, cardLabel: cardTitle(card), qty: adults, who: `Adultos (${meal.label.toLowerCase()})` }
      : { cardId: null, cardLabel: "Refeição dos adultos não informada", qty: adults, who: "Adultos" });
  }
  return result;
}

// Eventos que entram no faturamento do mês: data do evento no mês, aprovados e confirmados como realizados pela nutricionista.
function billableEvents(db, month) {
  return db.events.filter(evt => String(evt.eventDate || "").startsWith(month) && evt.approval === "aprovado" && evt.attendance === "realizado");
}

function deadlineOf(db, month, schoolId) {
  const school = directory().schoolsById.get(schoolId);
  return school ? db.inventoryDeadlines?.[month]?.[school.route] || "" : "";
}

function ordersForNutri(db, nutriId) {
  return db.orders
    .map(order => ({ ...order, unmatched: undefined, lines: order.lines.filter(line => line.nutritionistId === nutriId), adjustments: { [nutriId]: order.adjustments?.[nutriId] || null } }))
    .filter(order => order.lines.length);
}

// Estado relacional completo (mesmo formato de /api/data), para reaproveitar a planilha de faturamento.
async function relationalDb(actor) {
  const result = await coreApi.handler({
    path: "/api/data", httpMethod: "GET", headers: { authorization: `Bearer ${core.createToken(actor)}` }, queryStringParameters: {}, body: ""
  });
  if (result.statusCode !== 200) fail(result.statusCode || 500, JSON.parse(result.body || "{}").error || "Falha ao carregar os dados.");
  return JSON.parse(result.body);
}

async function recordExport(actor, payload, month, rows) {
  await createLocalClient().from("exports").insert({ id: `export-${Date.now()}`, month, filename: payload.filename, rows });
  return payload;
}

function requireMonth(value) {
  const month = String(value || "");
  if (!/^\d{4}-\d{2}$/.test(month)) fail(400, "Informe a competência (mês).");
  return month;
}

function eventRow(evt, dir, db) {
  const school = dir.schoolsById.get(evt.schoolId);
  const allocations = eventAllocations(db, evt, dir.cardsById);
  return {
    requestDate: evt.requestDate ? new Date(`${evt.requestDate}T00:00:00`) : null,
    eventDate: evt.eventDate ? new Date(`${evt.eventDate}T00:00:00`) : null,
    school: school?.shortName || evt.schoolId,
    route: school?.route || "",
    nutri: dir.profiles.get(evt.nutritionistId)?.name || "",
    event: evt.event,
    audience: AUDIENCE_LABELS[evt.audience] || evt.targetAudience || "",
    students: Number(evt.studentQty) || 0,
    adults: Number(evt.adultQty) || 0,
    adultMeal: ADULT_MEALS[evt.adultMeal]?.label || "",
    total: (Number(evt.studentQty) || 0) + (Number(evt.adultQty) || 0),
    fruit: evt.hasFruit ? "Sim" : "Não",
    food: evt.food || "",
    approval: APPROVAL_TEXT[evt.approval || "pendente"],
    attendance: ATTENDANCE_TEXT[evt.attendance] || "Aguardando nutricionista",
    cards: allocations.map(item => `${item.who}: ${item.qty} → ${item.cardLabel}`).join("; "),
    notes: evt.notes || ""
  };
}

const EVENT_COLUMNS = [
  { header: "Data da solicitação", key: "requestDate", width: 14, numFmt: "dd/mm/yyyy" },
  { header: "Data do evento", key: "eventDate", width: 14, numFmt: "dd/mm/yyyy" },
  { header: "Escola", key: "school", width: 40 },
  { header: "GRE", key: "route", width: 20 },
  { header: "Nutricionista", key: "nutri", width: 26 },
  { header: "Evento", key: "event", width: 28 },
  { header: "Público alvo", key: "audience", width: 15 },
  { header: "Qtd. alunos", key: "students", width: 11 },
  { header: "Qtd. adultos", key: "adults", width: 11 },
  { header: "Refeição dos adultos", key: "adultMeal", width: 14 },
  { header: "Quantitativo total", key: "total", width: 13 },
  { header: "Possui fruta", key: "fruit", width: 10 },
  { header: "Alimentação", key: "food", width: 34 },
  { header: "Aprovado", key: "approval", width: 18 },
  { header: "Atendimento", key: "attendance", width: 20 },
  { header: "Cards (faturamento)", key: "cards", width: 44 },
  { header: "Observações", key: "notes", width: 34 }
];

function eventsWorkbook(db) {
  const dir = directory();
  const workbook = new xl.ExcelJS.Workbook();
  const byMonth = new Map();
  for (const evt of db.events) {
    const key = String(evt.eventDate || evt.requestDate || "").slice(0, 7) || "sem-data";
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(evt);
  }
  const months = [...byMonth.keys()].sort();
  if (!months.length) months.push("sem-data");
  for (const month of months) {
    const list = (byMonth.get(month) || []).sort((a, b) => String(a.eventDate).localeCompare(String(b.eventDate)));
    const label = month === "sem-data" ? "Sem data" : xl.monthLabel(month);
    const sheet = xl.styledSheet(workbook, label, {
      title: `Eventos · ${label}`,
      subtitle: `${list.length} evento(s). "Cards (faturamento)" mostra onde cada quantidade entra na planilha de faturamento.`,
      columns: EVENT_COLUMNS
    });
    for (const evt of list) sheet.addRow(eventRow(evt, dir, db));
    xl.finishSheet(sheet, EVENT_COLUMNS);
  }
  return workbook;
}

const INVENTORY_COLUMNS = [
  { header: "Nutricionista", key: "nutri", width: 26 },
  { header: "GRE / Rota", key: "route", width: 20 },
  { header: "Escola", key: "school", width: 40 },
  { header: "Situação", key: "status", width: 16 },
  { header: "Enviado em", key: "sentAt", width: 17, numFmt: "dd/mm/yyyy hh:mm" },
  { header: "Categoria", key: "category", width: 26 },
  { header: "Insumo", key: "item", width: 40 },
  { header: "Unidade", key: "unit", width: 9 },
  { header: "Quantidade", key: "qty", width: 12, numFmt: "#,##0.###" },
  { header: "Valor unitário", key: "price", width: 13, numFmt: '"R$" #,##0.00' },
  { header: "Valor total", key: "value", width: 14, numFmt: '"R$" #,##0.00' }
];

function inventoryWorkbook(db, month) {
  const dir = directory();
  const items = new Map(db.inventoryItems.map(item => [item.id, item]));
  const categoryOrder = new Map(INVENTORY_CATEGORIES.map((category, index) => [category, index]));
  const workbook = new xl.ExcelJS.Workbook();
  const rowsFor = nutri => {
    const schools = dir.schools.filter(school => school.nutritionistIds.includes(nutri.id))
      .sort((a, b) => a.route.localeCompare(b.route, "pt-BR") || a.shortName.localeCompare(b.shortName, "pt-BR"));
    const rows = [];
    for (const school of schools) {
      const sent = db.inventorySubmissions[month]?.[school.id];
      const counts = db.inventoryCounts[month]?.[school.id] || {};
      const status = sent ? "Enviado" : Object.keys(counts).length ? "Em preenchimento" : "Não iniciado";
      const base = { nutri: nutri.name, route: school.route, school: school.shortName, status, sentAt: sent ? new Date(sent.sentAt) : null };
      const lines = Object.entries(counts).map(([itemId, row]) => ({ item: items.get(itemId), qty: row.quantity })).filter(line => line.item)
        .sort((a, b) => (categoryOrder.get(a.item.category) ?? 9) - (categoryOrder.get(b.item.category) ?? 9) || a.item.name.localeCompare(b.item.name, "pt-BR"));
      if (!lines.length) rows.push({ ...base, category: "", item: "Nenhum item informado", unit: "", qty: null });
      for (const line of lines) {
        const price = Number.isFinite(Number(line.item.price)) && line.item.price !== null ? Number(line.item.price) : null;
        rows.push({ ...base, category: line.item.category, item: line.item.name, unit: line.item.unit, qty: line.qty, price, value: price === null ? null : Math.round(price * line.qty * 100) / 100 });
      }
    }
    return { rows, schools };
  };
  const general = xl.styledSheet(workbook, "Inventário Geral", {
    title: `Inventário Geral · ${xl.monthLabel(month)}`,
    subtitle: "Todas as escolas, separadas por nutricionista e rota. Cada nutricionista também tem a sua aba.",
    columns: INVENTORY_COLUMNS
  });
  const perNutri = [];
  for (const nutri of dir.nutris) {
    const { rows, schools } = rowsFor(nutri);
    if (!schools.length) continue;
    rows.forEach(row => general.addRow(row));
    perNutri.push({ nutri, rows, schools });
  }
  xl.finishSheet(general, INVENTORY_COLUMNS);
  for (const { nutri, rows, schools } of perNutri) {
    const sent = schools.filter(school => db.inventorySubmissions[month]?.[school.id]).length;
    const sheet = xl.styledSheet(workbook, nutri.name, {
      title: `${nutri.name} · ${xl.monthLabel(month)}`,
      subtitle: `${sent} de ${schools.length} escola(s) com inventário enviado · rotas: ${[...new Set(schools.map(school => school.route))].join(", ")}`,
      columns: INVENTORY_COLUMNS
    });
    rows.forEach(row => sheet.addRow(row));
    xl.finishSheet(sheet, INVENTORY_COLUMNS);
  }
  return workbook;
}

function orderFinalQty(line, adjustment) {
  const value = adjustment?.values?.[line.id];
  return value === undefined || value === "" || value === null ? line.qty : Number(value);
}

const ORDER_COLUMNS = [
  { header: "Nutricionista", key: "nutri", width: 26 },
  { header: "GRE / Rota", key: "route", width: 20 },
  { header: "Código", key: "code", width: 9 },
  { header: "Escola", key: "school", width: 40 },
  { header: "Item", key: "item", width: 40 },
  { header: "Unidade", key: "unit", width: 10 },
  { header: "Qtd. prevista", key: "qty", width: 13, numFmt: "#,##0.###" },
  { header: "Qtd. ajustada", key: "adjusted", width: 13, numFmt: "#,##0.###" },
  { header: "Qtd. final", key: "final", width: 13, numFmt: "#,##0.###" },
  { header: "Situação do ajuste", key: "status", width: 22 }
];

function orderStatusText(adjustment) {
  if (adjustment?.finalizedAt) return "Finalizado";
  if (adjustment?.sentAt) return "Ajuste enviado";
  return "Aguardando ajuste";
}

function orderWorkbook(order) {
  const dir = directory();
  const workbook = new xl.ExcelJS.Workbook();
  const sheet = xl.styledSheet(workbook, "Pedido", {
    title: `${order.title} · ${xl.monthLabel(order.month)}`,
    subtitle: "Qtd. final = quantidade ajustada pela nutricionista ou, sem ajuste, a prevista no arquivo.",
    columns: ORDER_COLUMNS
  });
  const lines = [...order.lines].sort((a, b) => {
    const sa = dir.schoolsById.get(a.schoolId);
    const sb = dir.schoolsById.get(b.schoolId);
    return String(dir.profiles.get(a.nutritionistId)?.name || "").localeCompare(String(dir.profiles.get(b.nutritionistId)?.name || ""), "pt-BR")
      || String(sa?.shortName).localeCompare(String(sb?.shortName), "pt-BR") || a.item.localeCompare(b.item, "pt-BR");
  });
  for (const line of lines) {
    const school = dir.schoolsById.get(line.schoolId);
    const adjustment = order.adjustments?.[line.nutritionistId];
    const value = adjustment?.values?.[line.id];
    sheet.addRow({
      nutri: dir.profiles.get(line.nutritionistId)?.name || "Sem nutricionista",
      route: school?.route || "", code: school?.code || "", school: school?.shortName || line.schoolId,
      item: line.item, unit: line.unit, qty: line.qty,
      adjusted: value === undefined || value === "" ? null : Number(value),
      final: orderFinalQty(line, adjustment), status: orderStatusText(adjustment)
    });
  }
  xl.finishSheet(sheet, ORDER_COLUMNS);
  return workbook;
}

function orderTemplateWorkbook() {
  const dir = directory();
  const workbook = new xl.ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Pedido");
  sheet.columns = [
    { header: "Código da escola", key: "code", width: 16 },
    { header: "Escola", key: "school", width: 44 },
    { header: "Item", key: "item", width: 36 },
    { header: "Unidade", key: "unit", width: 10 },
    { header: "Quantidade", key: "qty", width: 12 }
  ];
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF257B6A" } };
  const examples = [["ARROZ PARBOILIZADO", "KG", 50], ["FEIJÃO CARIOCA", "KG", 20], ["LEITE EM PÓ", "KG", 12]];
  for (const school of dir.schools.slice(0, 2)) for (const [item, unit, qty] of examples) sheet.addRow({ code: school.code, school: school.shortName, item, unit, qty });
  return workbook;
}

function countsFor(all, schoolIds) {
  const result = {};
  for (const [month, bySchool] of Object.entries(all || {})) {
    result[month] = {};
    for (const id of schoolIds) if (bySchool[id]) result[month][id] = bySchool[id];
  }
  return result;
}

function nutriIdsOf(schoolId) {
  return localStore().nutritionist_schools.filter(item => item.school_id === schoolId).map(item => item.profile_id);
}

// Evento sob responsabilidade da nutricionista que está agindo (a coordenação só cria e edita os dados).
function ownEvent(actor, id) {
  const db = load();
  const item = db.events.find(evt => evt.id === id);
  if (!item) fail(404, "Evento não encontrado.");
  if (actor.role !== "nutritionist") fail(403, "Esta etapa do evento é feita pela nutricionista responsável.");
  const owner = item.nutritionistId || (schoolIdsOf(actor.id).has(item.schoolId) ? actor.id : "");
  if (owner !== actor.id) fail(403, "Este evento não está sob sua responsabilidade.");
  return item;
}

function priceValue(raw) {
  if (raw === "" || raw === null || raw === undefined) return null;
  const value = Number(String(raw).replace(/[R$\s]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", "."));
  if (!Number.isFinite(value) || value < 0) fail(400, "Valor inválido.");
  return Math.round(value * 100) / 100;
}

function inventoryTarget(actor, body) {
  const db = load();
  const month = String(body.month || "");
  const schoolId = String(body.schoolId || "");
  if (!/^\d{4}-\d{2}$/.test(month)) fail(400, "Competência inválida.");
  if (actor.role === "admin") fail(403, "O inventário da escola é preenchido pela nutricionista.");
  if (!schoolIdsOf(actor.id).has(schoolId)) fail(403, "Escola não vinculada a você.");
  if (db.inventorySubmissions[month]?.[schoolId]) fail(409, "Este inventário já foi enviado e não pode mais ser alterado.");
  const deadline = deadlineOf(db, month, schoolId);
  if (deadline && localToday() > deadline) fail(409, `O prazo do inventário desta GRE encerrou em ${xl.fmtDateBR(deadline)}. Não é mais possível preencher.`);
  return { db, month, schoolId };
}

function writeInventoryRows(db, actor, month, schoolId, rows) {
  const activeIds = new Set(db.inventoryItems.filter(item => item.active !== false).map(item => item.id));
  db.inventoryCounts[month] ||= {};
  const current = db.inventoryCounts[month][schoolId] ||= {};
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!activeIds.has(row.itemId)) continue;
    const raw = row.quantity;
    if (raw === "" || raw === null || raw === undefined) { delete current[row.itemId]; continue; }
    const quantity = Number(String(raw).replace(",", "."));
    if (!Number.isFinite(quantity) || quantity < 0) fail(400, "Quantidade inválida.");
    current[row.itemId] = { quantity, updatedAt: new Date().toISOString(), updatedBy: actor.name };
  }
  return current;
}

// ---------- Perfil ADM (conferência de KM e Capacitação) ----------
// Garante um usuário ADM na base local (adm / adm123) para bases criadas antes deste perfil existir.
function ensureAdmProfile() {
  const store = localStore();
  if (store.profiles.some(profile => profile.role === "adm")) return;
  const now = new Date().toISOString();
  store.profiles.push({ id: "adm", name: "ADM", username: "adm", password_hash: core.hashPassword("adm123"), role: "adm", active: true, created_at: now, updated_at: now });
  flushStore();
}

function requireAdm(actor) {
  if (actor.role !== "adm" && actor.role !== "admin") fail(403, "Apenas o ADM ou a coordenação podem realizar esta ação.");
}

function requireNutri(actor) {
  if (actor.role !== "nutritionist") fail(403, "Ação exclusiva da nutricionista.");
}

function pickNutri(byMonth, nutriId) {
  const result = {};
  for (const [month, byNutri] of Object.entries(byMonth || {})) if (byNutri[nutriId]) result[month] = { [nutriId]: byNutri[nutriId] };
  return result;
}

function isNutriId(id) {
  return directory().nutris.some(nutri => nutri.id === id);
}

// ---------- Controle de KM ----------
// km.vehicles[nutriId] = { plate, setAt, setBy }
// km.logs[month][nutriId] = { days: { "AAAA-MM-DD": { start, end } }, savedAt, sentAt, sentBy, review }
function kmStateFor(db, actor) {
  if (actor.role === "nutritionist") {
    return { vehicles: db.km.vehicles[actor.id] ? { [actor.id]: db.km.vehicles[actor.id] } : {}, logs: pickNutri(db.km.logs, actor.id) };
  }
  return db.km;
}

function normalizePlate(value) {
  const plate = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(plate)) fail(400, "Placa inválida. Use o formato ABC1234 ou ABC1D23.");
  return `${plate.slice(0, 3)}-${plate.slice(3)}`;
}

function kmNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(String(value).replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(number) || number < 0) fail(400, "KM inválido.");
  return Math.round(number * 10) / 10;
}

function writeKmDays(db, actor, month, days) {
  if (!db.km.vehicles[actor.id]) fail(400, "Cadastre a placa do carro antes de lançar o KM.");
  db.km.logs[month] ||= {};
  const log = db.km.logs[month][actor.id] ||= { days: {} };
  if (log.sentAt) fail(409, "O KM deste mês já foi enviado para o ADM e não pode mais ser alterado.");
  for (const [date, row] of Object.entries(days || {})) {
    if (!date.startsWith(`${month}-`) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const start = kmNumber(row?.start);
    const end = kmNumber(row?.end);
    if (start === null && end === null) { delete log.days[date]; continue; }
    if (start !== null && end !== null && end < start) fail(400, `Em ${xl.fmtDateBR(date)} o KM final é menor que o inicial.`);
    log.days[date] = { start, end };
  }
  log.savedAt = new Date().toISOString();
  return log;
}

function kmTotals(log) {
  let total = 0;
  let filled = 0;
  for (const row of Object.values(log?.days || {})) {
    if (row.start === null || row.end === null || row.start === undefined || row.end === undefined) continue;
    total += row.end - row.start;
    filled += 1;
  }
  return { total: Math.round(total * 10) / 10, filled };
}

function kmStatusText(log) {
  if (log?.review?.status === "conferido") return "Conferido";
  if (log?.sentAt) return "Enviado - aguardando conferência";
  if (log?.review?.status === "devolvido") return "Devolvido para correção";
  return Object.keys(log?.days || {}).length ? "Em preenchimento" : "Não iniciado";
}

function kmWorkbook(db, month) {
  const dir = directory();
  const workbook = new xl.ExcelJS.Workbook();
  const summaryColumns = [
    { header: "Nutricionista", key: "nutri", width: 28 },
    { header: "Placa", key: "plate", width: 11 },
    { header: "Dias lançados", key: "days", width: 12 },
    { header: "KM total", key: "total", width: 12, numFmt: "#,##0.0" },
    { header: "Situação", key: "status", width: 30 },
    { header: "Enviado em", key: "sentAt", width: 17, numFmt: "dd/mm/yyyy hh:mm" },
    { header: "Conferido por", key: "reviewBy", width: 18 }
  ];
  const summary = xl.styledSheet(workbook, "Resumo", { title: `Controle de KM · ${xl.monthLabel(month)}`, subtitle: "KM total = soma de (KM final − KM inicial) dos dias lançados.", columns: summaryColumns });
  const dayColumns = [
    { header: "Data", key: "date", width: 13, numFmt: "dd/mm/yyyy" },
    { header: "Dia", key: "weekday", width: 8 },
    { header: "KM inicial", key: "start", width: 12, numFmt: "#,##0.0" },
    { header: "KM final", key: "end", width: 12, numFmt: "#,##0.0" },
    { header: "KM total", key: "total", width: 12, numFmt: "#,##0.0" }
  ];
  const weekdays = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
  for (const nutri of dir.nutris) {
    const log = db.km.logs[month]?.[nutri.id];
    const { total, filled } = kmTotals(log);
    summary.addRow({ nutri: nutri.name, plate: db.km.vehicles[nutri.id]?.plate || "", days: filled, total, status: kmStatusText(log), sentAt: log?.sentAt ? new Date(log.sentAt) : null, reviewBy: log?.review?.status === "conferido" ? log.review.by : "" });
    if (!log || !Object.keys(log.days).length) continue;
    const sheet = xl.styledSheet(workbook, nutri.name, { title: `${nutri.name} · ${db.km.vehicles[nutri.id]?.plate || "sem placa"}`, subtitle: `${xl.monthLabel(month)} · ${kmStatusText(log)} · ${total} km`, columns: dayColumns });
    for (const date of Object.keys(log.days).sort()) {
      const row = log.days[date];
      const complete = row.start !== null && row.end !== null;
      sheet.addRow({ date: new Date(`${date}T00:00:00`), weekday: weekdays[new Date(`${date}T00:00:00`).getDay()], start: row.start, end: row.end, total: complete ? Math.round((row.end - row.start) * 10) / 10 : null });
    }
    xl.finishSheet(sheet, dayColumns);
  }
  xl.finishSheet(summary, summaryColumns);
  return workbook;
}

// ---------- Capacitação ----------
// trainings: [{ month, theme, deadline }]; trainingSubmissions[month][nutriId] = { files, notes, sentAt, review }
function trainingOf(db, month) {
  return db.trainings.find(item => item.month === month) || null;
}

function reviewRecord(actor, action, note) {
  if (!["conferido", "devolvido"].includes(action)) fail(400, "Ação inválida.");
  if (action === "devolvido" && !String(note || "").trim()) fail(400, "Explique o motivo da devolução.");
  return { status: action, note: String(note || "").slice(0, 1000), by: actor.name, at: new Date().toISOString() };
}

function handleUpload(actor, body) {
  const name = String(body.name || "arquivo").slice(0, 160);
  const data = String(body.data || "").replace(/^data:[^;]+;base64,/, "");
  const buffer = Buffer.from(data, "base64");
  if (!buffer.length) fail(400, "Arquivo vazio.");
  if (buffer.length > MAX_FILE_BYTES) fail(413, "Arquivo maior que 25 MB.");
  const id = uid("file");
  const safe = name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9._-]+/g, "_");
  const filename = `${id}-${safe}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
  return { id, name, url: `/uploads/${filename}`, size: buffer.length, type: String(body.type || ""), uploadedBy: actor.id, uploadedAt: new Date().toISOString() };
}

const handlers = {
  "GET state": actor => stateFor(actor),

  "POST upload": handleUpload,

  // ---------- Controle de KM ----------
  "POST km/plate": (actor, body) => {
    const db = load();
    const plate = normalizePlate(body.plate);
    if (actor.role === "nutritionist") {
      if (db.km.vehicles[actor.id]) fail(409, "A placa já foi cadastrada. Para trocar, fale com o ADM.");
      db.km.vehicles[actor.id] = { plate, setAt: new Date().toISOString(), setBy: actor.name };
    } else {
      requireAdm(actor);
      const nutriId = String(body.nutritionistId || "");
      if (!isNutriId(nutriId)) fail(400, "Nutricionista inválida.");
      db.km.vehicles[nutriId] = { plate, setAt: new Date().toISOString(), setBy: actor.name };
    }
    save();
    return { ok: true, plate };
  },
  "POST km/save": (actor, body) => {
    requireNutri(actor);
    const db = load();
    const month = requireMonth(body.month);
    const log = writeKmDays(db, actor, month, body.days);
    save();
    return { ok: true, log };
  },
  "POST km/send": (actor, body) => {
    requireNutri(actor);
    const db = load();
    const month = requireMonth(body.month);
    const log = writeKmDays(db, actor, month, body.days);
    const rows = Object.entries(log.days);
    if (!rows.length) fail(400, "Lance pelo menos um dia antes de enviar.");
    const incomplete = rows.filter(([, row]) => row.start === null || row.end === null).map(([date]) => xl.fmtDateBR(date));
    if (incomplete.length) fail(400, `Complete o KM inicial e final de: ${incomplete.slice(0, 5).join(", ")}${incomplete.length > 5 ? "…" : ""}.`);
    log.sentAt = new Date().toISOString();
    log.sentBy = actor.name;
    delete log.review;
    save();
    return { ok: true, log };
  },
  "POST km/review": (actor, body) => {
    requireAdm(actor);
    const db = load();
    const month = requireMonth(body.month);
    const log = db.km.logs[month]?.[String(body.nutritionistId || "")];
    if (!log?.sentAt) fail(400, "Este KM ainda não foi enviado pela nutricionista.");
    log.review = reviewRecord(actor, body.action, body.note);
    if (body.action === "devolvido") { delete log.sentAt; delete log.sentBy; }
    save();
    return { ok: true, log };
  },
  "POST km/export": async (actor, body) => {
    requireAdm(actor);
    const month = requireMonth(body.month);
    return xl.toPayload(kmWorkbook(load(), month), `controle-km-${month}-${xl.stamp()}.xlsx`);
  },

  // ---------- Capacitação ----------
  "POST training/save": (actor, body) => {
    requireAdmin(actor);
    const db = load();
    const month = requireMonth(body.month);
    const theme = String(body.theme || "").trim().slice(0, 300);
    if (!theme) fail(400, "Informe o tema da capacitação.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.deadline || ""))) fail(400, "Informe o prazo para envio dos documentos.");
    const existing = trainingOf(db, month);
    const record = { ...(existing || { createdAt: new Date().toISOString() }), month, theme, deadline: String(body.deadline), updatedAt: new Date().toISOString(), updatedBy: actor.name };
    if (existing) Object.assign(existing, record); else db.trainings.push(record);
    db.trainings.sort((a, b) => b.month.localeCompare(a.month));
    save();
    return { ok: true, training: record };
  },
  "POST training/delete": (actor, body) => {
    requireAdmin(actor);
    const db = load();
    const month = requireMonth(body.month);
    if (Object.keys(db.trainingSubmissions[month] || {}).length) fail(409, "Já existem envios para esta capacitação; ela não pode ser excluída.");
    db.trainings = db.trainings.filter(item => item.month !== month);
    save();
    return { ok: true };
  },
  "POST training/submit": (actor, body) => {
    requireNutri(actor);
    const db = load();
    const month = requireMonth(body.month);
    const training = trainingOf(db, month);
    if (!training) fail(404, "Não há capacitação definida para este mês.");
    db.trainingSubmissions[month] ||= {};
    const current = db.trainingSubmissions[month][actor.id];
    const returned = current?.review?.status === "devolvido";
    if (current && !returned) fail(409, "A capacitação deste mês já foi enviada.");
    if (!returned && localToday() > training.deadline) fail(409, `O prazo para envio encerrou em ${xl.fmtDateBR(training.deadline)}.`);
    const files = cleanFiles(body.files);
    if (!files.length) fail(400, "Anexe pelo menos um documento da capacitação.");
    db.trainingSubmissions[month][actor.id] = {
      files, notes: String(body.notes || "").slice(0, 2000), sentAt: new Date().toISOString(), sentBy: actor.name,
      history: [...(current?.history || []), ...(current ? [{ files: current.files, sentAt: current.sentAt, review: current.review }] : [])]
    };
    save();
    return { ok: true };
  },
  "POST training/review": (actor, body) => {
    requireAdm(actor);
    const db = load();
    const month = requireMonth(body.month);
    const submission = db.trainingSubmissions[month]?.[String(body.nutritionistId || "")];
    if (!submission) fail(404, "Envio não encontrado.");
    submission.review = reviewRecord(actor, body.action, body.note);
    save();
    return { ok: true, submission };
  },

  // ---------- Relatório de Supervisão ----------
  "POST supervision/save": (actor, body) => {
    const db = load();
    const nutritionistId = actor.role === "admin" ? String(body.nutritionistId || "") : actor.id;
    const schoolId = String(body.schoolId || "");
    if (!schoolIdsOf(nutritionistId).has(schoolId)) fail(400, "Escola não vinculada a esta nutricionista.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.date || ""))) fail(400, "Informe a data do relatório.");
    const existing = body.id ? db.supervisionReports.find(item => item.id === body.id) : null;
    if (existing && actor.role !== "admin" && existing.nutritionistId !== actor.id) fail(403, "Sem permissão.");
    const record = {
      ...(existing || { id: uid("sup"), createdAt: new Date().toISOString() }),
      schoolId,
      nutritionistId,
      date: body.date,
      notes: String(body.notes || "").slice(0, 2000),
      reportFile: cleanFile(body.reportFile),
      photos: cleanFiles(body.photos),
      updatedAt: new Date().toISOString()
    };
    if (existing) Object.assign(existing, record);
    else db.supervisionReports.push(record);
    save();
    return record;
  },
  "POST supervision/delete": (actor, body) => {
    const db = load();
    const item = db.supervisionReports.find(report => report.id === body.id);
    if (!item) fail(404, "Relatório não encontrado.");
    if (actor.role !== "admin" && item.nutritionistId !== actor.id) fail(403, "Sem permissão.");
    db.supervisionReports = db.supervisionReports.filter(report => report.id !== body.id);
    save();
    return { ok: true };
  },

  // ---------- Matriculados ----------
  "POST enrollments/save": (actor, body) => {
    requireAdmin(actor);
    const db = load();
    const rows = Array.isArray(body.rows) ? body.rows : [body];
    for (const row of rows) {
      const segments = {};
      for (const [cardId, value] of Object.entries(row.segments || {})) {
        if (value === "" || value === null || value === undefined) continue;
        const number = Math.max(0, Math.trunc(Number(value) || 0));
        segments[cardId] = number;
      }
      db.enrollments[row.schoolId] = { segments, updatedAt: new Date().toISOString(), updatedBy: actor.name };
    }
    save();
    return { ok: true, enrollments: db.enrollments };
  },

  // ---------- Eventos ----------
  "POST events/save": (actor, body) => {
    requireAdmin(actor);
    const db = load();
    if (!body.schoolId || !String(body.event || "").trim()) fail(400, "Informe a escola e o evento.");
    const schoolNutris = nutriIdsOf(String(body.schoolId));
    const nutritionistId = String(body.nutritionistId || schoolNutris[0] || "");
    const isNutri = localStore().profiles.some(item => item.id === nutritionistId && item.role === "nutritionist");
    if (!isNutri) fail(400, "Selecione a nutricionista responsável.");
    const audience = AUDIENCE_LABELS[body.audience] ? body.audience : "alunos";
    const toInt = value => (value === "" || value === undefined || value === null ? 0 : Math.max(0, Math.trunc(Number(value) || 0)));
    const studentQty = audience === "adultos" ? 0 : toInt(body.studentQty);
    const adultQty = audience === "alunos" ? 0 : toInt(body.adultQty);
    const adultMeal = audience === "alunos" ? "" : String(body.adultMeal || "");
    if (audience !== "alunos" && !ADULT_MEALS[adultMeal]) fail(400, "Informe se a refeição dos adultos é almoço ou lanche.");
    const quantity = studentQty + adultQty || "";
    const existing = body.id ? db.events.find(item => item.id === body.id) : null;
    const record = {
      ...(existing || { id: uid("evt"), createdAt: new Date().toISOString(), createdBy: actor.name, attendance: null }),
      schoolId: String(body.schoolId),
      nutritionistId,
      requestDate: String(body.requestDate || ""),
      event: String(body.event || "").slice(0, 300),
      audience,
      targetAudience: AUDIENCE_LABELS[audience],
      studentQty,
      adultQty,
      adultMeal,
      quantity,
      hasFruit: body.hasFruit === true || body.hasFruit === "sim",
      approval: existing?.approval || "pendente",
      food: String(body.food || "").slice(0, 1000),
      notes: String(body.notes || "").slice(0, 2000),
      eventDate: String(body.eventDate || ""),
      done: Boolean(body.done),
      updatedAt: new Date().toISOString()
    };
    if (existing) Object.assign(existing, record);
    else db.events.push(record);
    save();
    return record;
  },
  "POST events/toggle": (actor, body) => {
    const item = ownEvent(actor, body.id);
    item.done = Boolean(body.done);
    item.doneAt = item.done ? new Date().toISOString() : null;
    save();
    return item;
  },
  "POST events/approve": (actor, body) => {
    const item = ownEvent(actor, body.id);
    if (!APPROVAL.includes(body.approval)) fail(400, "Situação de aprovação inválida.");
    item.approval = body.approval;
    item.approvalAt = new Date().toISOString();
    item.approvalBy = actor.name;
    save();
    return item;
  },
  "POST events/attend": (actor, body) => {
    const db = load();
    const item = db.events.find(evt => evt.id === body.id);
    if (!item) fail(404, "Evento não encontrado.");
    if (actor.role === "admin") fail(403, "O atendimento é confirmado pela nutricionista responsável.");
    const owner = item.nutritionistId || (schoolIdsOf(actor.id).has(item.schoolId) ? actor.id : "");
    if (owner !== actor.id) fail(403, "Este evento não está sob sua responsabilidade.");
    const value = body.attendance === null || body.attendance === "" ? null : String(body.attendance);
    if (value !== null && !ATTENDANCE.includes(value)) fail(400, "Atendimento inválido.");
    item.attendance = value;
    item.attendanceAt = value ? new Date().toISOString() : null;
    item.attendanceBy = value ? actor.name : null;
    save();
    return item;
  },
  "POST events/delete": (actor, body) => {
    requireAdmin(actor);
    const db = load();
    db.events = db.events.filter(item => item.id !== body.id);
    save();
    return { ok: true };
  },

  // ---------- Notificações ----------
  "POST notifications/create": (actor, body) => {
    requireAdmin(actor);
    const db = load();
    const questions = (Array.isArray(body.questions) ? body.questions : [])
      .map(text => String(text || "").trim()).filter(Boolean)
      .map(text => ({ id: uid("q"), text: text.slice(0, 600) }));
    if (!String(body.title || "").trim()) fail(400, "Informe o título.");
    if (!questions.length) fail(400, "Adicione pelo menos uma pergunta.");
    const nutriIds = new Set(localStore().profiles.filter(item => item.role === "nutritionist" && item.active !== false).map(item => item.id));
    const targetIds = (Array.isArray(body.targetIds) && body.targetIds.length ? body.targetIds : [...nutriIds]).filter(id => nutriIds.has(id));
    if (!targetIds.length) fail(400, "Selecione ao menos uma nutricionista.");
    const record = {
      id: uid("ntf"),
      title: String(body.title).trim().slice(0, 200),
      description: String(body.description || "").slice(0, 2000),
      dueDate: String(body.dueDate || ""),
      questions,
      targetIds,
      responses: {},
      finalFile: null,
      createdBy: actor.name,
      createdAt: new Date().toISOString(),
      closedAt: null
    };
    db.notifications.unshift(record);
    save();
    return record;
  },
  "POST notifications/answer": (actor, body) => {
    const db = load();
    const item = db.notifications.find(notification => notification.id === body.id);
    if (!item) fail(404, "Notificação não encontrada.");
    if (!item.targetIds.includes(actor.id)) fail(403, "Esta notificação não é para você.");
    if (item.finalFile) fail(409, "Esta notificação já foi concluída pela coordenação.");
    const answers = {};
    for (const question of item.questions) answers[question.id] = String(body.answers?.[question.id] || "").slice(0, 4000);
    if (Object.values(answers).some(value => !value.trim())) fail(400, "Responda todas as perguntas.");
    item.responses[actor.id] = { answers, attachments: cleanFiles(body.attachments), respondedAt: new Date().toISOString(), name: actor.name };
    save();
    return item;
  },
  "POST notifications/final": (actor, body) => {
    requireAdmin(actor);
    const db = load();
    const item = db.notifications.find(notification => notification.id === body.id);
    if (!item) fail(404, "Notificação não encontrada.");
    item.finalFile = cleanFile(body.finalFile);
    item.closedAt = item.finalFile ? new Date().toISOString() : null;
    save();
    return item;
  },
  "POST notifications/delete": (actor, body) => {
    requireAdmin(actor);
    const db = load();
    db.notifications = db.notifications.filter(item => item.id !== body.id);
    save();
    return { ok: true };
  },

  // ---------- Inventário ----------
  "POST inventory/item": (actor, body) => {
    requireAdmin(actor);
    const db = load();
    if (!String(body.name || "").trim()) fail(400, "Informe o nome do insumo.");
    const existing = body.id ? db.inventoryItems.find(item => item.id === body.id) : null;
    const record = {
      ...(existing || { id: uid("ins"), createdAt: new Date().toISOString() }),
      name: String(body.name).trim().slice(0, 160),
      category: INVENTORY_CATEGORIES.includes(body.category) ? body.category : INVENTORY_CATEGORIES[0],
      unit: String(body.unit || "un").trim().slice(0, 12) || "un",
      price: body.price === undefined ? existing?.price ?? null : priceValue(body.price),
      active: existing ? existing.active !== false : true
    };
    if (existing) Object.assign(existing, record);
    else db.inventoryItems.push(record);
    save();
    return record;
  },
  "POST inventory/item-delete": (actor, body) => {
    requireAdmin(actor);
    const db = load();
    db.inventoryItems = db.inventoryItems.filter(item => item.id !== body.id);
    for (const bySchool of Object.values(db.inventoryCounts)) for (const items of Object.values(bySchool)) delete items[body.id];
    save();
    return { ok: true };
  },
  "POST inventory/price": (actor, body) => {
    requireAdmin(actor);
    const db = load();
    const item = db.inventoryItems.find(entry => entry.id === body.id);
    if (!item) fail(404, "Insumo não encontrado.");
    item.price = priceValue(body.price);
    save();
    return item;
  },
  "POST inventory/active": (actor, body) => {
    requireAdmin(actor);
    const db = load();
    const ids = new Set(Array.isArray(body.ids) ? body.ids : [body.id]);
    for (const item of db.inventoryItems) if (ids.has(item.id)) item.active = Boolean(body.active);
    save();
    return { ok: true };
  },
  "POST inventory/count": (actor, body) => {
    const { db, month, schoolId } = inventoryTarget(actor, body);
    const counts = writeInventoryRows(db, actor, month, schoolId, body.rows);
    save();
    return { ok: true, counts };
  },
  // Envio: grava o que veio na tela e trava o inventário daquela escola/mês.
  "POST inventory/submit": (actor, body) => {
    const { db, month, schoolId } = inventoryTarget(actor, body);
    const counts = writeInventoryRows(db, actor, month, schoolId, body.rows);
    if (!Object.keys(counts).length) fail(400, "Preencha pelo menos um item antes de enviar.");
    db.inventorySubmissions[month] ||= {};
    db.inventorySubmissions[month][schoolId] = { sentAt: new Date().toISOString(), sentBy: actor.name, sentById: actor.id, items: Object.keys(counts).length };
    save();
    return { ok: true, submission: db.inventorySubmissions[month][schoolId] };
  },
  // Coordenação pode reabrir um inventário enviado para correção.
  "POST inventory/reopen": (actor, body) => {
    requireAdmin(actor);
    const db = load();
    const month = String(body.month || "");
    const schoolId = String(body.schoolId || "");
    if (!db.inventorySubmissions[month]?.[schoolId]) fail(404, "Inventário não enviado.");
    delete db.inventorySubmissions[month][schoolId];
    save();
    return { ok: true };
  },
  // Prazo do inventário por GRE (data limite inclusive). Vazio = sem prazo.
  "POST inventory/deadlines": (actor, body) => {
    requireAdmin(actor);
    const db = load();
    const month = requireMonth(body.month);
    const routes = new Set(directory().schools.map(school => school.route));
    const next = {};
    for (const [route, date] of Object.entries(body.deadlines || {})) {
      if (!routes.has(route) || !date) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) fail(400, "Data de prazo inválida.");
      next[route] = String(date);
    }
    db.inventoryDeadlines[month] = next;
    save();
    return { ok: true, deadlines: next };
  },

  // ---------- Exportações ----------
  "POST exports/faturamento": async (actor, body) => {
    requireAdmin(actor);
    const month = requireMonth(body.month);
    const db = load();
    const dir = directory();
    const rel = await relationalDb(actor);
    const events = billableEvents(db, month);
    const audit = [];
    for (const evt of events) {
      for (const allocation of eventAllocations(db, evt, dir.cardsById)) {
        audit.push({ evt, allocation });
        if (!allocation.cardId) continue;
        // Entra como uma apuração extra da escola no mês: soma no card definido pela regra.
        rel.entries.push({ id: `evento-${evt.id}-${allocation.cardId}`, date: `${month}-01`, schoolId: evt.schoolId, status: "served", nutritionistName: "", quantities: { [allocation.cardId]: allocation.qty } });
      }
    }
    const workbook = new xl.ExcelJS.Workbook();
    await workbook.xlsx.load(await coreApi._test.exportWorkbook(rel, month));
    const smed = workbook.worksheets[0];
    for (const card of rel.cards || []) smed.getCell(172, card.column).value = Number(card.price) || 0;
    const columns = [
      { header: "Data do evento", key: "date", width: 14, numFmt: "dd/mm/yyyy" },
      { header: "Escola", key: "school", width: 40 },
      { header: "GRE", key: "route", width: 20 },
      { header: "Evento", key: "event", width: 28 },
      { header: "Público", key: "who", width: 18 },
      { header: "Quantidade", key: "qty", width: 12 },
      { header: "Card", key: "card", width: 16 },
      { header: "Valor unitário", key: "price", width: 13, numFmt: '"R$" #,##0.00' },
      { header: "Valor", key: "value", width: 13, numFmt: '"R$" #,##0.00' },
      { header: "Atendimento", key: "attendance", width: 22 }
    ];
    const sheet = xl.styledSheet(workbook, "Eventos no faturamento", {
      title: `Eventos somados ao faturamento · ${xl.monthLabel(month)}`,
      subtitle: "Eventos aprovados e confirmados como realizados, com data no mês. Alunos: card mais caro da escola (valor contratual). Adultos: almoço no CARD 11, lanche no card 10.",
      columns
    });
    for (const { evt, allocation } of audit) {
      const school = dir.schoolsById.get(evt.schoolId);
      const card = allocation.cardId ? dir.cardsById.get(allocation.cardId) : null;
      sheet.addRow({
        date: new Date(`${evt.eventDate}T00:00:00`), school: school?.shortName || evt.schoolId, route: school?.route || "", event: evt.event,
        who: allocation.who, qty: allocation.qty, card: card ? cardTitle(card) : `NÃO FATURADO: ${allocation.cardLabel}`,
        price: card ? Number(card.price) : null, value: card ? Number(card.price) * allocation.qty : null,
        attendance: ATTENDANCE_TEXT[evt.attendance] || "Aguardando nutricionista"
      });
    }
    xl.finishSheet(sheet, columns);
    const payload = await xl.toPayload(workbook, `faturamento-${month}-${xl.stamp()}.xlsx`);
    payload.events = events.length;
    return recordExport(actor, payload, month, rel.schools.length);
  },
  "POST exports/inventario": async (actor, body) => {
    requireAdmin(actor);
    const month = requireMonth(body.month);
    const payload = await xl.toPayload(inventoryWorkbook(load(), month), `inventario-geral-${month}-${xl.stamp()}.xlsx`);
    return recordExport(actor, payload, month, Object.keys(load().inventorySubmissions[month] || {}).length);
  },
  "POST exports/eventos": async actor => {
    requireAdmin(actor);
    const db = load();
    const payload = await xl.toPayload(eventsWorkbook(db), `eventos-todos-os-meses-${xl.stamp()}.xlsx`);
    return recordExport(actor, payload, "todos", db.events.length);
  },

  // ---------- Pedidos ----------
  "POST orders/template": async actor => {
    requireAdmin(actor);
    return xl.toPayload(orderTemplateWorkbook(), "modelo-pedido.xlsx");
  },
  "POST orders/preview": async (actor, body) => {
    requireAdmin(actor);
    return ordersReader.previewOrderFile(body.data, directory().schools);
  },
  "POST orders/create": async (actor, body) => {
    requireAdmin(actor);
    const db = load();
    const month = requireMonth(body.month);
    const title = String(body.title || "").trim().slice(0, 160);
    if (!title) fail(400, "Dê um nome ao pedido.");
    const dir = directory();
    const parsed = await ordersReader.parseOrderFile(body.data, dir.schools, { sheet: body.sheet, mode: body.mode, mapping: body.mapping });
    if (!parsed.lines.length) fail(400, "Nenhuma linha válida foi encontrada com as colunas escolhidas.");
    let seq = 0;
    const lines = parsed.lines.map(line => ({ id: `l${++seq}`, ...line, nutritionistId: dir.schoolsById.get(line.schoolId)?.nutritionistIds?.[0] || "" }));
    const record = {
      id: uid("ped"), title, month, deliveryDate: String(body.deliveryDate || ""), fileName: String(body.fileName || "").slice(0, 160),
      sheet: parsed.sheet, createdAt: new Date().toISOString(), createdBy: actor.name,
      lines, unmatched: parsed.unmatched, skipped: parsed.skipped, adjustments: {}
    };
    db.orders.unshift(record);
    save();
    return { ok: true, id: record.id, lines: lines.length, unmatched: parsed.unmatched.length, withoutNutri: lines.filter(line => !line.nutritionistId).length };
  },
  "POST orders/delete": (actor, body) => {
    requireAdmin(actor);
    const db = load();
    db.orders = db.orders.filter(order => order.id !== body.id);
    save();
    return { ok: true };
  },
  // Nutricionista: grava o ajuste (rascunho) ou envia para a coordenação finalizar.
  "POST orders/adjust": (actor, body) => {
    if (actor.role === "admin") fail(403, "O ajuste é feito pela nutricionista.");
    const db = load();
    const order = db.orders.find(item => item.id === body.id);
    if (!order) fail(404, "Pedido não encontrado.");
    const mine = new Set(order.lines.filter(line => line.nutritionistId === actor.id).map(line => line.id));
    if (!mine.size) fail(403, "Este pedido não tem escolas suas.");
    const current = order.adjustments[actor.id] ||= { values: {} };
    if (current.sentAt) fail(409, "O ajuste deste pedido já foi enviado e não pode mais ser alterado.");
    for (const [lineId, raw] of Object.entries(body.values || {})) {
      if (!mine.has(lineId)) continue;
      if (raw === "" || raw === null || raw === undefined) { delete current.values[lineId]; continue; }
      const quantity = Number(String(raw).replace(/\./g, "").replace(",", "."));
      if (!Number.isFinite(quantity) || quantity < 0) fail(400, "Quantidade ajustada inválida.");
      current.values[lineId] = quantity;
    }
    current.savedAt = new Date().toISOString();
    if (body.send) {
      current.sentAt = current.savedAt;
      current.sentBy = actor.name;
    }
    save();
    return { ok: true, adjustment: current };
  },
  "POST orders/finalize": (actor, body) => {
    requireAdmin(actor);
    const db = load();
    const order = db.orders.find(item => item.id === body.id);
    if (!order) fail(404, "Pedido não encontrado.");
    const ids = Array.isArray(body.nutritionistIds) ? body.nutritionistIds : [body.nutritionistId];
    for (const nutriId of ids) {
      const adjustment = order.adjustments[nutriId];
      if (body.action === "return") {
        if (adjustment && !adjustment.finalizedAt) { delete adjustment.sentAt; delete adjustment.sentBy; }
        continue;
      }
      if (!adjustment?.sentAt) fail(400, "A nutricionista ainda não enviou o ajuste.");
      adjustment.finalizedAt = new Date().toISOString();
      adjustment.finalizedBy = actor.name;
    }
    save();
    return { ok: true };
  },
  "POST orders/export": async (actor, body) => {
    requireAdmin(actor);
    const order = load().orders.find(item => item.id === body.id);
    if (!order) fail(404, "Pedido não encontrado.");
    const safe = order.title.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase().slice(0, 40);
    return xl.toPayload(orderWorkbook(order), `pedido-${safe}-${order.month}.xlsx`);
  }
};

async function handleModules({ method, pathname, headers, body }) {
  try {
    load();
    const actor = actorFrom(headers);
    if (!actor) return { status: 401, body: { error: "Sessão expirada. Entre novamente." } };
    const route = pathname.replace(/^\/api\/m\//, "").replace(/\/+$/, "");
    const handler = handlers[`${method} ${route}`];
    if (!handler) return { status: 404, body: { error: "Rota não encontrada." } };
    const parsed = body ? JSON.parse(body) : {};
    return { status: 200, body: await handler(actor, parsed) };
  } catch (error) {
    return { status: error.statusCode || 500, body: { error: error.message } };
  }
}

module.exports = { handleModules, UPLOADS_DIR };
