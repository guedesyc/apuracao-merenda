// Preenche a base LOCAL com dados FICTÍCIOS de novembro e dezembro/2026 para ver o sistema "cheio".
// Só acrescenta: o que já existe na base não é alterado. Tudo o que é criado aqui leva a marca demo,
// então dá para tirar depois sem mexer no resto.
//   node scripts/seed_demo_nov_dez.js           -> acrescenta os dados fictícios (remove os de uma rodada anterior antes)
//   node scripts/seed_demo_nov_dez.js --remove  -> remove só os dados fictícios
// Pare o servidor antes de rodar (ele guarda a base em memória).
const fs = require("fs");
const path = require("path");
const { segmentsFor } = require("./enrollment-data");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = process.env.LOCAL_DATA_DIR || path.join(ROOT, "local-data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const MODULES_FILE = path.join(DATA_DIR, "modules.json");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const REMOVE = process.argv.includes("--remove");
const MONTHS = ["2026-11", "2026-12"];
const DEC_LAST_DAY = "2026-12-18"; // fim do consumo dos pedidos de dezembro (ano letivo)

const db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
const mod = JSON.parse(fs.readFileSync(MODULES_FILE, "utf8"));

// ---------------------------------------------------------------- remoção
function removeDemo() {
  const dropEntries = new Set(db.entries.filter(entry => String(entry.id).startsWith("demo-")).map(entry => entry.id));
  db.entries = db.entries.filter(entry => !dropEntries.has(entry.id));
  db.entry_items = db.entry_items.filter(item => !dropEntries.has(item.entry_id));

  mod.orders = (mod.orders || []).filter(order => !order.demo);
  for (const order of mod.orders) {
    for (const [nutriId, adjustment] of Object.entries(order.adjustments || {})) if (adjustment?.demo) delete order.adjustments[nutriId];
    order.history = (order.history || []).filter(entry => !entry.demo);
  }
  for (const bySchool of Object.values(mod.inventoryCounts || {})) {
    for (const [schoolId, counts] of Object.entries(bySchool)) {
      for (const [itemId, row] of Object.entries(counts)) if (row?.demo) delete counts[itemId];
      if (!Object.keys(counts).length) delete bySchool[schoolId];
    }
  }
  for (const bySchool of Object.values(mod.inventorySubmissions || {})) {
    for (const [schoolId, sub] of Object.entries(bySchool)) if (sub?.demo) delete bySchool[schoolId];
  }
  for (const item of mod.inventoryItems || []) if (item.priceDemo) { item.price = null; delete item.priceDemo; }
  for (const [nutriId, vehicle] of Object.entries(mod.km?.vehicles || {})) if (vehicle?.demo) delete mod.km.vehicles[nutriId];
  for (const byNutri of Object.values(mod.km?.logs || {})) {
    for (const [nutriId, log] of Object.entries(byNutri)) if (log?.demo) delete byNutri[nutriId];
  }
  mod.events = (mod.events || []).filter(item => !item.demo);
  mod.notifications = (mod.notifications || []).filter(item => !item.demo);
  mod.supervisionReports = (mod.supervisionReports || []).filter(item => !item.demo);
  mod.trainings = (mod.trainings || []).filter(item => !item.demo);
  for (const byNutri of Object.values(mod.trainingSubmissions || {})) {
    for (const [nutriId, sub] of Object.entries(byNutri)) if (sub?.demo) delete byNutri[nutriId];
  }
  if (fs.existsSync(UPLOADS_DIR)) {
    for (const name of fs.readdirSync(UPLOADS_DIR)) if (name.startsWith("demo-file-")) fs.unlinkSync(path.join(UPLOADS_DIR, name));
  }
}

removeDemo();
if (REMOVE) {
  save();
  console.log("Dados fictícios de novembro/dezembro removidos.");
  process.exit(0);
}

// ---------------------------------------------------------------- utilidades
let seed = 20261205;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const between = (min, max) => min + rand() * (max - min);
const int = (min, max) => Math.round(between(min, max));
const pick = list => list[Math.floor(rand() * list.length)];
const chance = p => rand() < p;
const pad = n => String(n).padStart(2, "0");
let counter = 0;
const id = prefix => `demo-${prefix}-${(++counter).toString(36)}`;
const at = (date, hour = 10, minute = 0) => `${date}T${pad(hour)}:${pad(minute)}:00.000-03:00`;
const addDays = (date, days) => {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function businessDates(month, until = "") {
  const [year, m] = month.split("-").map(Number);
  const last = new Date(year, m, 0).getDate();
  const dates = [];
  for (let day = 1; day <= last; day += 1) {
    const date = `${month}-${pad(day)}`;
    const weekday = new Date(year, m - 1, day).getDay();
    if (weekday !== 0 && weekday !== 6 && (!until || date <= until)) dates.push(date);
  }
  return dates;
}

const nutris = db.profiles.filter(profile => profile.role === "nutritionist" && profile.active !== false);
const nutriById = new Map(nutris.map(nutri => [nutri.id, nutri]));
const schoolsOf = new Map(nutris.map(nutri => [nutri.id, db.nutritionist_schools.filter(row => row.profile_id === nutri.id).map(row => row.school_id)]));
const nutriOfSchool = new Map(db.nutritionist_schools.map(row => [row.school_id, row.profile_id]));
const schoolById = new Map(db.schools.map(school => [school.id, school]));
const enrollmentTotal = schoolId => Object.values(mod.enrollments?.[schoolId]?.segments || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);

// Arquivo de exemplo usado como anexo (relatórios, capacitação, arquivo final).
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
function demoFile(name, text) {
  const fileId = id("file");
  const filename = `${fileId}-${name}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), text);
  return { id: fileId, name, url: `/uploads/${filename}`, size: Buffer.byteLength(text), type: "text/plain" };
}

// ---------------------------------------------------------------- 1. Apuração (lançamentos)
let entryCount = 0;
const taken = new Set(db.entries.map(entry => `${entry.entry_date}|${entry.school_id}|${entry.nutritionist_id}`));
const reasons = ["Sem aula", "Feriado", "Greve", "Segurança"];
for (const row of db.nutritionist_schools) {
  const school = schoolById.get(row.school_id);
  const base = segmentsFor(school);
  if (!Object.keys(base).length) continue;
  const presence = between(0.82, 0.93);
  for (const month of MONTHS) {
    for (const date of businessDates(month, month === "2026-12" ? DEC_LAST_DAY : "")) {
      if (taken.has(`${date}|${school.id}|${row.profile_id}`)) continue;
      const entryId = `demo-entry-${date}-${school.id}-${row.profile_id}`;
      const holiday = date === "2026-11-02" || date === "2026-11-20";
      const notServed = holiday || chance(0.03);
      db.entries.push({
        id: entryId, entry_date: date, month, school_id: school.id, nutritionist_id: row.profile_id,
        status: notServed ? "not_served" : "served", reason: holiday ? "Feriado" : notServed ? pick(reasons) : "",
        notes: "", updated_at: at(date, 15)
      });
      entryCount += 1;
      if (notServed) continue;
      for (const [cardId, qty] of Object.entries(base)) {
        db.entry_items.push({ entry_id: entryId, card_id: cardId, quantity: Math.max(0, Math.min(qty, Math.round(qty * (presence + (rand() - 0.5) * 0.12)))) });
      }
    }
  }
}
const app = db.settings.find(item => item.key === "app");
if (app) app.value.workingDaysByMonth = { ...app.value.workingDaysByMonth, "2026-12": businessDates("2026-12").length };

// ---------------------------------------------------------------- 2. Pedidos (base: planilhas importadas) e ajustes
const realOrders = mod.orders.filter(order => !order.demo);
const byTitle = regex => realOrders.find(order => regex.test(order.title));
function cloneOrder(source, month, title, deliveryDate) {
  const factor = between(0.9, 1.08);
  return {
    ...source, id: id("ped"), demo: true, title, month, deliveryDate, fileName: `${source.fileName || "planilha"} (cópia fictícia)`,
    createdAt: at(addDays(`${month}-01`, -12), 9), createdBy: "Coordenação",
    lines: source.lines.map(line => ({ ...line, qty: roundQty(line.qty * factor * between(0.92, 1.08), line.unit) })),
    adjustments: {}, history: []
  };
}
function roundQty(value, unit) {
  return String(unit).toUpperCase() === "KG" && value < 20 ? Math.max(0.5, Math.round(value * 10) / 10) : Math.max(1, Math.round(value));
}
const secos = byTitle(/seco/i);
const congelados = byTitle(/congel/i);
const horti = byTitle(/horti/i);
if (secos) mod.orders.push(cloneOrder(secos, "2026-11", "PEDIDO SECOS - NOVEMBRO CONSUMO 03.11 a 28.11 (fictício)", "2026-10-29"));
if (congelados) mod.orders.push(cloneOrder(congelados, "2026-11", "PEDIDO CONGELADOS - NOVEMBRO CONSUMO 03.11 a 28.11 (fictício)", "2026-10-30"));
if (horti) mod.orders.push(cloneOrder(horti, "2026-12", "HORTI ENTREGA ROTAS 1 E 2 - ENTREGA 08.12 E 10.12 (fictício)", "2026-12-08"));

let adjusted = 0;
for (const order of mod.orders) {
  order.history ||= [];
  const nutriIds = [...new Set(order.lines.map(line => line.nutritionistId).filter(Boolean))];
  const past = order.month === "2026-11";
  for (const nutriId of nutriIds) {
    if (order.adjustments[nutriId]) continue; // ajuste real já existe: não mexe
    const nutri = nutriById.get(nutriId);
    if (!nutri) continue;
    const roll = rand();
    const stage = past ? (roll < 0.82 ? "final" : "sent") : roll < 0.25 ? "final" : roll < 0.55 ? "sent" : roll < 0.8 ? "draft" : "none";
    if (stage === "none") continue;
    const lines = order.lines.filter(line => line.nutritionistId === nutriId);
    const values = {};
    const changes = [];
    for (const line of lines) {
      if (!chance(0.11)) continue;
      const factor = chance(0.72) ? between(0.55, 0.95) : between(1.05, 1.35);
      const value = roundQty(line.qty * factor, line.unit);
      if (value === line.qty) continue;
      values[line.id] = value;
      changes.push({ lineId: line.id, schoolId: line.schoolId, item: line.item, unit: line.unit || "", qty: line.qty, from: null, to: value });
    }
    const base = addDays(`${order.month}-01`, past ? -int(6, 9) : -int(3, 6));
    const adjustment = { values, savedAt: at(base, int(8, 17), int(0, 59)), demo: true };
    // primeiro rascunho com parte das mudanças, depois o restante
    const half = Math.ceil(changes.length / 2);
    order.history.push({ id: id("hist"), at: adjustment.savedAt, nutritionistId: nutriId, by: nutri.name, action: "draft", changes: changes.slice(0, half), demo: true });
    if (changes.length > half) order.history.push({ id: id("hist"), at: at(addDays(base, 1), int(8, 12), int(0, 59)), nutritionistId: nutriId, by: nutri.name, action: "draft", changes: changes.slice(half), demo: true });
    if (stage !== "draft") {
      const sentDay = addDays(base, 2);
      // às vezes a coordenação devolve e a nutri reenvia com mais um ajuste
      if (chance(0.15) && lines.length) {
        order.history.push({ id: id("hist"), at: at(sentDay, 9, 10), nutritionistId: nutriId, by: nutri.name, action: "sent", changes: [], demo: true });
        order.history.push({ id: id("hist"), at: at(sentDay, 14, 30), nutritionistId: nutriId, by: "Coordenação", action: "returned", changes: [], demo: true });
        const line = pick(lines);
        const before = values[line.id] ?? null;
        values[line.id] = roundQty(line.qty * between(0.6, 0.9), line.unit);
        order.history.push({ id: id("hist"), at: at(addDays(sentDay, 1), 10, 5), nutritionistId: nutriId, by: nutri.name, action: "sent", demo: true,
          changes: [{ lineId: line.id, schoolId: line.schoolId, item: line.item, unit: line.unit || "", qty: line.qty, from: before, to: values[line.id] }] });
        adjustment.sentAt = at(addDays(sentDay, 1), 10, 5);
      } else {
        adjustment.sentAt = at(sentDay, int(9, 17), int(0, 59));
        order.history.push({ id: id("hist"), at: adjustment.sentAt, nutritionistId: nutriId, by: nutri.name, action: "sent", changes: [], demo: true });
      }
      adjustment.sentBy = nutri.name;
      adjustment.savedAt = adjustment.sentAt;
    }
    if (stage === "final") {
      adjustment.finalizedAt = at(addDays(adjustment.sentAt.slice(0, 10), 1), 11, int(0, 59));
      adjustment.finalizedBy = "Coordenação";
      order.history.push({ id: id("hist"), at: adjustment.finalizedAt, nutritionistId: nutriId, by: "Coordenação", action: "finalized", changes: [], demo: true });
    }
    order.adjustments[nutriId] = adjustment;
    adjusted += 1;
  }
  order.history.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}
mod.orders.sort((a, b) => String(b.month).localeCompare(String(a.month)) || String(b.createdAt).localeCompare(String(a.createdAt)));

// ---------------------------------------------------------------- 3. Inventário (contagens, envios e valores unitários)
const PRICE_RANGE = { Secos: [4, 26], Congelados: [16, 42], "Produtos de Limpeza / Descartáveis": [3, 18], "Aprender+": [5, 20] };
for (const item of mod.inventoryItems) {
  if (item.price === null || item.price === undefined || item.price === "") {
    if (/QUANT/i.test(item.name)) continue;
    const [min, max] = PRICE_RANGE[item.category] || [3, 15];
    item.price = Math.round(between(min, max) * 100) / 100;
    item.priceDemo = true;
  }
}
const countable = mod.inventoryItems.filter(item => item.active !== false && !/QUANT/i.test(item.name));
let invSent = 0;
for (const month of MONTHS) {
  mod.inventoryCounts[month] ||= {};
  mod.inventorySubmissions[month] ||= {};
  for (const school of db.schools) {
    const nutriId = nutriOfSchool.get(school.id);
    if (!nutriId) continue;
    const existing = mod.inventoryCounts[month][school.id];
    if (existing && Object.keys(existing).length) continue; // contagem real: não mexe
    const roll = rand();
    const state = month === "2026-11" ? (roll < 0.94 ? "sent" : "draft") : roll < 0.55 ? "sent" : roll < 0.8 ? "draft" : "none";
    if (state === "none") continue;
    const scale = Math.max(0.4, Math.min(3, enrollmentTotal(school.id) / 300));
    const counts = {};
    const day = month === "2026-11" ? int(20, 27) : int(10, 16);
    for (const item of countable) {
      if (!chance(0.58)) continue;
      const unit = String(item.unit).toUpperCase();
      // estoque de fim de mês: em média ~1/4 do que a escola pede por mês
      const raw = unit === "KG" ? between(0.5, 9) * scale : unit === "L" ? between(0.5, 6) * scale : between(1, 12) * scale;
      counts[item.id] = { quantity: unit === "KG" || unit === "L" ? Math.round(raw * 10) / 10 : Math.max(1, Math.round(raw)), updatedAt: at(`${month}-${pad(day)}`, 14), updatedBy: nutriById.get(nutriId)?.name || "", demo: true };
    }
    mod.inventoryCounts[month][school.id] = counts;
    if (state === "sent") {
      mod.inventorySubmissions[month][school.id] = { sentAt: at(`${month}-${pad(day)}`, 16, int(0, 59)), sentBy: nutriById.get(nutriId)?.name || "", sentById: nutriId, items: Object.keys(counts).length, demo: true };
      invSent += 1;
    }
  }
}

// ---------------------------------------------------------------- 4. Controle de KM
mod.km ||= { vehicles: {}, logs: {} };
const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
for (const nutri of nutris) {
  if (mod.km.vehicles[nutri.id]) continue;
  const plate = `${pick(letters)}${pick(letters)}${pick(letters)}-${int(1, 9)}${pick(letters)}${int(10, 99)}`;
  mod.km.vehicles[nutri.id] = { plate, setAt: at("2026-11-03", 8), setBy: nutri.name, demo: true };
}
for (const nutri of nutris) {
  let odometer = int(12000, 68000);
  const style = between(0.7, 1.5); // tem nutri que roda bem mais que outra
  for (const month of MONTHS) {
    mod.km.logs[month] ||= {};
    if (mod.km.logs[month][nutri.id]) continue; // lançamento real: não mexe
    const days = {};
    const dates = businessDates(month, month === "2026-12" ? "2026-12-11" : "");
    for (const date of dates) {
      if (chance(0.12)) continue; // dia sem visita
      const run = Math.round(between(14, 70) * style * 10) / 10;
      days[date] = { start: odometer, end: Math.round((odometer + run) * 10) / 10 };
      odometer = days[date].end + int(0, 6);
    }
    const log = { days, savedAt: at(dates[dates.length - 1], 18), demo: true };
    const roll = rand();
    if (month === "2026-11") {
      log.sentAt = at("2026-11-30", 17, int(0, 59));
      log.sentBy = nutri.name;
      if (roll < 0.8) log.review = { status: "conferido", note: "", by: "ADM", at: at("2026-12-02", 10, int(0, 59)) };
    } else if (roll < 0.2) {
      log.sentAt = at("2026-12-11", 17);
      log.sentBy = nutri.name;
    }
    mod.km.logs[month][nutri.id] = log;
  }
}

// ---------------------------------------------------------------- 5. Eventos
const EVENT_NAMES = ["Festa da Família", "Dia da Consciência Negra", "Formatura do Infantil", "Feira de Ciências", "Confraternização de fim de ano", "Natal Solidário", "Mostra Cultural", "Reunião de pais com lanche", "Aniversário da escola", "Sarau literário", "Gincana esportiva", "Encerramento do ano letivo"];
const FOODS = ["Bolo, suco e salada de frutas", "Cachorro-quente e suco", "Almoço especial: frango assado, arroz e salada", "Lanche: sanduíche natural e suco", "Mingau e frutas", "Pipoca, bolo e suco"];
const allSchoolIds = db.schools.map(school => school.id).filter(schoolId => nutriOfSchool.has(schoolId) && enrollmentTotal(schoolId));
for (let i = 0; i < 26; i += 1) {
  const schoolId = pick(allSchoolIds);
  const month = i < 15 ? "2026-11" : "2026-12";
  const eventDate = pick(businessDates(month, month === "2026-12" ? DEC_LAST_DAY : ""));
  const audience = pick(["alunos", "alunos", "alunos", "ambos", "adultos"]);
  const studentQty = audience === "adultos" ? 0 : Math.round(enrollmentTotal(schoolId) * between(0.4, 0.95));
  const adultQty = audience === "alunos" ? 0 : int(15, 80);
  const adultMeal = audience === "alunos" ? "" : pick(["almoco", "lanche"]);
  const past = eventDate < "2026-12-01";
  const approval = past ? (chance(0.88) ? "aprovado" : "reprovado") : pick(["pendente", "pendente", "aprovado", "aprovado", "reprovado"]);
  const attendance = past && approval === "aprovado" ? (chance(0.9) ? "realizado" : "nao_realizado") : null;
  const requestDate = addDays(eventDate, -int(8, 20));
  mod.events.push({
    id: id("evt"), demo: true, createdAt: at(requestDate, 9), createdBy: "Coordenação", schoolId, nutritionistId: nutriOfSchool.get(schoolId),
    requestDate, event: EVENT_NAMES[i % EVENT_NAMES.length], audience, targetAudience: { alunos: "Alunos", adultos: "Adultos", ambos: "Alunos/Adultos" }[audience],
    studentQty, adultQty, adultMeal, quantity: studentQty + adultQty, hasFruit: chance(0.5), food: pick(FOODS), notes: chance(0.3) ? "Confirmar horário com a direção." : "",
    eventDate, approval, approvalAt: approval === "pendente" ? null : at(addDays(requestDate, 2), 11), approvalBy: approval === "pendente" ? null : "Coordenação",
    attendance, attendanceAt: attendance ? at(eventDate, 17) : null, attendanceBy: attendance ? nutriById.get(nutriOfSchool.get(schoolId))?.name : null,
    done: Boolean(attendance) && chance(0.85), doneAt: attendance ? at(addDays(eventDate, 1), 9) : null, updatedAt: at(eventDate, 17)
  });
}

// ---------------------------------------------------------------- 6. Notificações (por escola)
const TOPICS = [
  ["Fogão com defeito", ["O fogão foi consertado?", "Há risco para a equipe da cozinha?"]],
  ["Falta de gás", ["Qual a data da última recarga?", "Quantos botijões a escola tem hoje?"]],
  ["Geladeira sem refrigerar", ["Os alimentos perecíveis foram remanejados?", "Já foi aberto chamado de manutenção?"]],
  ["Cardápio não cumprido", ["Quais refeições foram trocadas?", "Qual o motivo da troca?"]],
  ["Controle de temperatura ausente", ["A planilha de temperatura está sendo preenchida?", "Há termômetro na escola?"]],
  ["Uniforme das merendeiras", ["Todas estão com touca e avental?", "Precisa de reposição?"]],
  ["Validade vencida no estoque", ["Quais itens estavam vencidos?", "Os itens foram descartados?"]],
  ["Infiltração na despensa", ["A despensa está seca hoje?", "Os alimentos foram realocados?"]]
];
const hotSchools = Array.from({ length: 6 }, () => pick(allSchoolIds));
const finalDoc = demoFile("parecer-coordenacao.txt", "Parecer da coordenação (arquivo fictício de demonstração).\n");
for (let i = 0; i < 22; i += 1) {
  const [title, questions] = TOPICS[i % TOPICS.length];
  const schoolIds = [...new Set([chance(0.55) ? pick(hotSchools) : pick(allSchoolIds), ...(chance(0.2) ? [pick(allSchoolIds)] : [])])];
  const targetIds = [...new Set(schoolIds.map(schoolId => nutriOfSchool.get(schoolId)).filter(Boolean))];
  const created = pick(businessDates(i < 14 ? "2026-11" : "2026-12", "2026-12-15"));
  const qs = questions.map((text, index) => ({ id: `demo-q-${i}-${index}`, text }));
  const responses = {};
  const answeredAll = chance(0.8);
  for (const nutriId of targetIds) {
    if (!answeredAll && chance(0.5)) continue;
    responses[nutriId] = {
      answers: Object.fromEntries(qs.map(q => [q.id, pick(["Sim, já resolvido.", "Ainda não, aguardando manutenção.", "Parcialmente. A direção foi avisada.", "Não. Fizemos o remanejamento provisório."])])),
      attachments: [], respondedAt: at(addDays(created, int(1, 4)), int(9, 17), int(0, 59)), name: nutriById.get(nutriId)?.name || ""
    };
  }
  const closed = Object.keys(responses).length === targetIds.length && chance(0.6);
  mod.notifications.push({
    id: id("ntf"), demo: true, title, description: "Notificação fictícia de demonstração.", dueDate: addDays(created, 7), questions: qs,
    schoolIds, targetIds, responses, finalFile: closed ? finalDoc : null, createdBy: "Coordenação", createdAt: at(created, 9),
    closedAt: closed ? at(addDays(created, int(5, 10)), 15) : null
  });
}
mod.notifications.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

// ---------------------------------------------------------------- 7. Relatório de Supervisão
const NOTES = ["Cozinha organizada, cardápio cumprido.", "Ajustar armazenamento de secos (fora do chão).", "Merendeiras sem touca no horário da visita; orientado.", "Estoque conferido, sem itens vencidos.", "Pia com vazamento, direção avisada.", "Boa aceitação da refeição pelos alunos."];
const reportDoc = demoFile("relatorio-supervisao.txt", "Relatório de supervisão (arquivo fictício de demonstração).\n");
for (const nutri of nutris) {
  for (const month of MONTHS) {
    for (const schoolId of schoolsOf.get(nutri.id) || []) {
      if (!chance(month === "2026-11" ? 0.7 : 0.35)) continue;
      const date = pick(businessDates(month, month === "2026-12" ? DEC_LAST_DAY : ""));
      mod.supervisionReports.push({ id: id("sup"), demo: true, createdAt: at(date, 16), schoolId, nutritionistId: nutri.id, date, notes: pick(NOTES), reportFile: reportDoc, photos: [], updatedAt: at(date, 16) });
    }
  }
}

// ---------------------------------------------------------------- 8. Capacitação
if (!mod.trainings.some(item => item.month === "2026-11")) mod.trainings.push({ month: "2026-11", theme: "Boas práticas na manipulação de alimentos", deadline: "2026-11-19", createdAt: at("2026-11-03", 9), updatedAt: at("2026-11-03", 9), updatedBy: "Coordenação", demo: true });
if (!mod.trainings.some(item => item.month === "2026-12")) mod.trainings.push({ month: "2026-12", theme: "Controle de temperatura e armazenamento", deadline: "2026-12-15", createdAt: at("2026-12-01", 9), updatedAt: at("2026-12-01", 9), updatedBy: "Coordenação", demo: true });
mod.trainings.sort((a, b) => b.month.localeCompare(a.month));
const trainingDoc = demoFile("lista-presenca-capacitacao.txt", "Lista de presença da capacitação (arquivo fictício de demonstração).\n");
for (const month of MONTHS) {
  mod.trainingSubmissions[month] ||= {};
  for (const nutri of nutris) {
    if (mod.trainingSubmissions[month][nutri.id]) continue;
    if (!chance(month === "2026-11" ? 0.85 : 0.45)) continue;
    const sentAt = at(month === "2026-11" ? `2026-11-${pad(int(10, 18))}` : `2026-12-${pad(int(3, 12))}`, 15);
    mod.trainingSubmissions[month][nutri.id] = {
      files: [trainingDoc], notes: "", sentAt, sentBy: nutri.name, history: [], demo: true,
      ...(month === "2026-11" && chance(0.8) ? { review: { status: "conferido", note: "", by: "ADM", at: at("2026-11-21", 10) } } : {})
    };
  }
}

save();
const sum = (list, fn) => list.reduce((acc, item) => acc + fn(item), 0);
console.log("Dados fictícios de novembro/dezembro criados:");
console.log(` - Lançamentos de apuração: ${entryCount}`);
console.log(` - Pedidos: ${mod.orders.filter(order => order.demo).length} novos (cópias das planilhas) · ajustes de nutricionista: ${adjusted}`);
console.log(` - Inventários enviados: ${invSent} · valor unitário fictício em ${sum(mod.inventoryItems, item => (item.priceDemo ? 1 : 0))} insumos`);
console.log(` - KM: ${sum(nutris, nutri => MONTHS.filter(month => mod.km.logs[month]?.[nutri.id]?.demo).length)} meses lançados · eventos: ${mod.events.filter(item => item.demo).length} · notificações: ${mod.notifications.filter(item => item.demo).length}`);
console.log(` - Relatórios de supervisão: ${mod.supervisionReports.filter(item => item.demo).length} · envios de capacitação: ${sum(MONTHS, month => Object.values(mod.trainingSubmissions[month] || {}).filter(sub => sub.demo).length)}`);
console.log("Para remover: npm run local:demo-remove");

function save() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db));
  const tmp = `${MODULES_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(mod, null, 2));
  fs.renameSync(tmp, MODULES_FILE);
}
