// Gera a base LOCAL (local-data/) a partir dos arquivos do repositório.
// Não acessa Supabase nem Hostinger.
//   node scripts/seed_local.js            -> base com cadastros reais + lançamentos fictícios (ago-out/2026)
//   node scripts/seed_local.js --empty    -> base apenas com cadastros reais, sem lançamentos
//   node scripts/seed_local.js --entries-only -> regera só os lançamentos fictícios, mantendo o resto da base
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = process.env.LOCAL_DATA_DIR || path.join(ROOT, "local-data");
const DEMO = JSON.parse(fs.readFileSync(path.join(ROOT, "public", "demo-data.json"), "utf8"));
const OFFICIAL = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "official-route-assignments.json"), "utf8"));
const EMPTY = process.argv.includes("--empty");
const ENTRIES_ONLY = process.argv.includes("--entries-only");

const ADMIN_PASSWORD = "admin123";
const NUTRI_PASSWORD = "nutri123";
const CURRENT_MONTH = "2026-11";
const DEMO_MONTHS = ["2026-08", "2026-09", "2026-10"];

const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const now = new Date().toISOString();

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(e\.?\s*m\.?|em|cmei)\b/g, "")
    .replace(/\b(escola municipal|centro municipal de educacao infantil)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slug(value) {
  return String(value || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "");
}

function routeId(name) {
  return `route-${String(name || "sem-rota").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "sem-rota"}`;
}

function bestMatch(target, rows, fields, used = new Set()) {
  const needle = normalize(target);
  const pool = rows.filter(row => !used.has(row.id));
  const exact = pool.find(row => fields.some(field => normalize(row[field]) === needle));
  if (exact) return exact;
  return pool.find(row => fields.some(field => {
    const haystack = normalize(row[field]);
    return haystack && needle && (haystack.includes(needle) || needle.includes(haystack));
  })) || null;
}

// ---------- RNG determinístico ----------
let seed = 20261105;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const between = (min, max) => Math.round(min + rand() * (max - min));

// ---------- Perfis ----------
const demoNutris = DEMO.users.filter(user => user.role === "nutritionist");
const profiles = [
  { id: "admin", name: "Coordenação", username: "admin", password_hash: hash(ADMIN_PASSWORD), role: "admin", active: true, created_at: now, updated_at: now },
  { id: "adm", name: "ADM", username: "adm", password_hash: hash("adm123"), role: "adm", active: true, created_at: now, updated_at: now }
];
const nutriByOfficialName = new Map();
for (const nutri of OFFICIAL.nutritionists) {
  const match = bestMatch(nutri.name, demoNutris, ["name"]);
  const id = match ? match.id : `user-${slug(nutri.name)}`;
  const name = match ? match.name : nutri.name;
  const username = match ? match.username : slug(nutri.name);
  profiles.push({ id, name, username, password_hash: hash(NUTRI_PASSWORD), role: "nutritionist", active: true, phone: nutri.phone || "", created_at: now, updated_at: now });
  nutriByOfficialName.set(nutri.name, id);
}

// ---------- Escolas, rotas e vínculos ----------
const schools = DEMO.schools.map(school => ({
  id: school.id,
  row_number: school.row,
  code: String(school.name).includes(" - ") ? String(school.name).split(" - ", 1)[0] : null,
  name: school.name,
  short_name: school.shortName || school.name,
  route_id: routeId(school.route === "SEM ROTA" ? "SEM ROTA" : `GRE ${school.route}`),
  company: school.company || "",
  address: school.address || "",
  active: school.active !== false,
  created_at: now,
  updated_at: now
}));

const assignments = [];
const used = new Set();
const unmatched = [];
let nextRow = Math.max(...schools.map(school => school.row_number)) + 1;
for (const nutri of OFFICIAL.nutritionists) {
  const profileId = nutriByOfficialName.get(nutri.name);
  for (const route of nutri.routes) {
    for (const item of route.schools) {
      const name = typeof item === "string" ? item : item.name;
      let school = bestMatch(name, schools, ["name", "short_name"], used);
      if (!school && typeof item === "object" && item.createIfMissing) {
        school = { id: `school-${nextRow}`, row_number: nextRow, code: null, name, short_name: name, route_id: routeId(route.name), company: "", address: "", active: true, created_at: now, updated_at: now };
        nextRow += 1;
        schools.push(school);
      }
      if (!school) { unmatched.push(`${nutri.name} / ${name}`); continue; }
      used.add(school.id);
      school.route_id = routeId(route.name);
      assignments.push({ profile_id: profileId, school_id: school.id, created_at: now });
    }
  }
}
const routeNames = [...new Set(OFFICIAL.nutritionists.flatMap(n => n.routes.map(r => r.name))), "SEM ROTA"];
const routes = routeNames.map(name => ({ id: routeId(name), name, created_at: now }));
const routeIds = new Set(routes.map(route => route.id));
for (const school of schools) if (!routeIds.has(school.route_id)) school.route_id = routeId("SEM ROTA");

const cards = DEMO.cards.map(card => ({
  id: card.id, number: card.number, label: card.label, description: card.description || "", price: card.price || 0, column_number: card.column, active: true
}));

// ---------- Lançamentos fictícios ----------
function businessDates(month) {
  const [year, m] = month.split("-").map(Number);
  const last = new Date(year, m, 0).getDate();
  const dates = [];
  for (let day = 1; day <= last; day += 1) {
    const weekday = new Date(year, m - 1, day).getDay();
    if (weekday !== 0 && weekday !== 6) dates.push(`${month}-${String(day).padStart(2, "0")}`);
  }
  return dates;
}

const entries = [];
const entryItems = [];
const closures = [];
const workingDaysByMonth = { [CURRENT_MONTH]: businessDates(CURRENT_MONTH).length };
const profileById = new Map(profiles.map(profile => [profile.id, profile]));

// Os lançamentos fictícios seguem os matriculados reais da planilha:
// por dia, cada card recebe entre 78% e 97% dos matriculados daquele segmento.
const { segmentsFor, enrollmentsFor } = require("./enrollment-data");

if (!EMPTY) {
  const reasons = ["Sem aula", "Feriado", "Greve", "Segurança"];
  for (const assignment of assignments) {
    const school = schools.find(item => item.id === assignment.school_id);
    const profile = profileById.get(assignment.profile_id);
    const base = segmentsFor(school);
    if (!Object.keys(base).length) continue;
    const presence = 0.84 + rand() * 0.08;
    DEMO_MONTHS.forEach(month => {
      for (const date of businessDates(month)) {
        const id = `entry-${date}-${school.id}-${profile.id}`;
        const notServed = rand() < 0.035;
        entries.push({
          id, entry_date: date, month, school_id: school.id, nutritionist_id: profile.id,
          status: notServed ? "not_served" : "served",
          reason: notServed ? reasons[Math.floor(rand() * reasons.length)] : "",
          notes: "", updated_at: `${date}T15:00:00.000Z`
        });
        if (notServed) continue;
        for (const [cardId, qty] of Object.entries(base)) {
          const value = Math.max(0, Math.min(qty, Math.round(qty * (presence + (rand() - 0.5) * 0.12))));
          entryItems.push({ entry_id: id, card_id: cardId, quantity: value });
        }
      }
    });
  }
  for (const month of DEMO_MONTHS) {
    workingDaysByMonth[month] = businessDates(month).length;
    for (const profile of profiles.filter(item => item.role === "nutritionist")) {
      const total = entries.filter(entry => entry.month === month && entry.nutritionist_id === profile.id).length;
      closures.push({
        id: `closure-${month}-${profile.id}`, month, nutritionist_id: profile.id, nutritionist_name: profile.name,
        status: "sent", expected: total, complete: total, pending: 0, test: false,
        sent_at: `${month}-28T18:00:00.000Z`, updated_at: `${month}-28T18:00:00.000Z`
      });
    }
  }
}

const db = {
  profiles, routes, schools, nutritionist_schools: assignments, cards,
  settings: [{ key: "app", value: { currentMonth: CURRENT_MONTH, reasons: ["Sem aula", "Segurança", "Greve", "Feriado", "Outro"], workingDaysByMonth }, updated_at: now }],
  entries, entry_items: entryItems, monthly_closures: closures, exports: [], audit_logs: []
};

// --entries-only: troca apenas os lançamentos fictícios (meses de demonstração) da base atual,
// preservando lançamentos, módulos e anexos feitos durante os testes.
if (ENTRIES_ONLY) {
  const dbFile = path.join(DATA_DIR, "db.json");
  const current = JSON.parse(fs.readFileSync(dbFile, "utf8"));
  const demo = new Set(DEMO_MONTHS);
  const dropIds = new Set(current.entries.filter(entry => demo.has(entry.month)).map(entry => entry.id));
  current.entries = current.entries.filter(entry => !dropIds.has(entry.id)).concat(entries);
  current.entry_items = current.entry_items.filter(item => !dropIds.has(item.entry_id)).concat(entryItems);
  current.monthly_closures = current.monthly_closures.filter(item => !demo.has(item.month)).concat(closures);
  fs.writeFileSync(dbFile, JSON.stringify(current));
  console.log(`Lançamentos fictícios de ${DEMO_MONTHS.join(", ")} regerados com base nos matriculados: ${entries.length} lançamentos.`);
  process.exit(0);
}

// ---------- Módulos novos ----------
const { INVENTORY_ITEMS } = require("./inventory-catalog");

const modules = {
  version: 3,
  supervisionReports: [],
  enrollments: enrollmentsFor(schools),
  events: [],
  notifications: [],
  inventoryItems: INVENTORY_ITEMS.map(([name, category, unit], index) => ({ id: `ins-${index + 1}`, name, category, unit, active: true, createdAt: now })),
  inventoryCounts: {}
};

fs.mkdirSync(path.join(DATA_DIR, "uploads"), { recursive: true });
fs.writeFileSync(path.join(DATA_DIR, "db.json"), JSON.stringify(db));
fs.writeFileSync(path.join(DATA_DIR, "modules.json"), JSON.stringify(modules, null, 2));

console.log(`Base local criada em ${DATA_DIR}`);
console.log(`Perfis: ${profiles.length} | Escolas: ${schools.length} | Vínculos: ${assignments.length} | Lançamentos: ${entries.length}`);
if (unmatched.length) console.log(`Escolas oficiais não encontradas (${unmatched.length}):\n - ${unmatched.join("\n - ")}`);
console.log(`Acessos: admin/${ADMIN_PASSWORD} | adm/adm123 | nutricionistas: <usuario>/${NUTRI_PASSWORD}`);
console.log(profiles.filter(p => p.role === "nutritionist").map(p => `   ${p.username}  (${p.name})`).join("\n"));
