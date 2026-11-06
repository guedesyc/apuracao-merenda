// Carga inicial da produção para os módulos novos + usuários.
//
//   node scripts/carga_inicial_producao.js            -> só MOSTRA o que vai fazer (não grava nada)
//   node scripts/carga_inicial_producao.js --aplicar  -> grava
//
// Lê a conexão do env.env (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY) e as senhas do senhas.env
// (usuario=senha). Nunca imprime senha nem chave.
//
// O que faz (pode rodar de novo sem duplicar nada):
//   1. Usuários: troca a senha de quem tem senha preenchida no senhas.env e cria os usuários novos
//      (coordenação e ADM). Não apaga ninguém e não mexe em escolas nem lançamentos.
//   2. Catálogo de insumos do inventário (data/inventario-2026.json), só se o catálogo estiver vazio.
//   3. Matriculados por escola (data/matriculados-2026.json), só nas escolas que ainda não têm.
// Nada de local-data/ (dados de teste) é levado.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { INVENTORY_ITEMS } = require("./inventory-catalog");
const { enrollmentsFor } = require("./enrollment-data");

const ROOT = path.join(__dirname, "..");
const APPLY = process.argv.includes("--aplicar");

// Usuários que precisam existir. Os que já existem são achados pelo login.
const NEW_USERS = [
  { username: "jessica.melquiades", id: "admin-jessica.melquiades", name: "JESSICA MELQUIADES", role: "admin" },
  { username: "isadora.cardim", id: "admin-isadora.cardim", name: "ISADORA CARDIM", role: "admin" },
  { username: "viviane.cerqueira", id: "adm-viviane.cerqueira", name: "VIVIANE CERQUEIRA", role: "adm" }
];

function readEnvFile(file) {
  const values = {};
  if (!fs.existsSync(file)) return values;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const match = line.match(/^\s*([^=\s#]+)\s*=(.*)$/);
    if (match) values[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return values;
}

// Mesma regra de senha do sistema (netlify/functions/api.js → hashPassword).
function hashPassword(password) {
  return crypto.createHash("sha256").update(String(password)).digest("hex");
}

async function selectAll(client, table, columns = "*") {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await client.from(table).select(columns).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

async function main() {
  const env = readEnvFile(path.join(ROOT, "env.env"));
  const url = process.env.SUPABASE_URL || env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no env.env.");
  const passwords = readEnvFile(path.join(ROOT, "senhas.env"));
  const client = createClient(url, key, { auth: { persistSession: false } });
  const now = new Date().toISOString();
  const report = [];
  const problems = [];

  // ---------------------------------------------------------------- 1. usuários
  const profiles = await selectAll(client, "profiles", "id,name,username,role,active");
  const byUsername = new Map(profiles.map(profile => [profile.username, profile]));
  const updates = [];
  const inserts = [];
  for (const [username, password] of Object.entries(passwords)) {
    if (!password) continue;
    if (password.length < 8) { problems.push(`${username}: senha com menos de 8 caracteres (não foi aplicada).`); continue; }
    const existing = byUsername.get(username);
    if (existing) {
      updates.push({ profile: existing, hash: hashPassword(password) });
      continue;
    }
    const planned = NEW_USERS.find(user => user.username === username);
    if (!planned) { problems.push(`${username}: não existe no sistema e não está na lista de usuários novos (ignorado).`); continue; }
    if (profiles.some(profile => profile.id === planned.id)) { problems.push(`${username}: já existe um usuário com o id ${planned.id}.`); continue; }
    inserts.push({ ...planned, hash: hashPassword(password) });
  }
  for (const user of NEW_USERS) {
    if (!byUsername.has(user.username) && !passwords[user.username]) problems.push(`${user.username}: usuário novo sem senha no senhas.env (não será criado).`);
  }
  const untouched = profiles.filter(profile => profile.active !== false && !updates.some(item => item.profile.id === profile.id));
  report.push("USUÁRIOS");
  for (const item of updates) report.push(`  trocar senha   ${item.profile.username.padEnd(20)} ${item.profile.name} (${item.profile.role})`);
  for (const item of inserts) report.push(`  criar          ${item.username.padEnd(20)} ${item.name} (${item.role})`);
  for (const profile of untouched) report.push(`  sem mudança    ${profile.username.padEnd(20)} ${profile.name} (${profile.role})`);

  // ---------------------------------------------------------------- 2. catálogo de insumos
  const { count: itemCount, error: itemError } = await client.from("inventory_items").select("id", { count: "exact", head: true });
  if (itemError) throw new Error(`inventory_items: ${itemError.message}`);
  const catalog = INVENTORY_ITEMS
    .filter(([name]) => !/^QUANT\.?:?$/i.test(String(name).trim()))
    .map(([name, category, unit], index) => ({ id: `ins-${index + 1}`, name, category, unit, price: null, active: true, sort_order: index, created_at: now, updated_at: now }));
  report.push("", "INVENTÁRIO DE INSUMOS");
  report.push(itemCount ? `  catálogo já tem ${itemCount} insumo(s): nada a fazer` : `  inserir ${catalog.length} insumos (sem valor unitário; a coordenação preenche depois)`);

  // ---------------------------------------------------------------- 3. matriculados
  const schools = await selectAll(client, "schools", "id,code,name");
  const current = new Set((await selectAll(client, "enrollments", "school_id")).map(row => row.school_id));
  const enrollments = Object.entries(enrollmentsFor(schools, "Planilha de matriculados 2026"))
    .filter(([schoolId]) => !current.has(schoolId))
    .map(([schoolId, item]) => ({ school_id: schoolId, segments: item.segments, updated_at: now, updated_by: item.updatedBy }));
  report.push("", "MATRICULADOS");
  report.push(`  ${schools.length} escolas · ${current.size} já com matriculados · inserir ${enrollments.length}`);

  if (problems.length) report.push("", "ATENÇÃO", ...problems.map(text => `  - ${text}`));
  console.log(report.join("\n"));

  if (!APPLY) {
    console.log("\nNada foi gravado. Para aplicar: node scripts/carga_inicial_producao.js --aplicar");
    return;
  }

  // ---------------------------------------------------------------- gravar
  for (const item of updates) {
    const { error } = await client.from("profiles").update({ password_hash: item.hash, updated_at: now }).eq("id", item.profile.id);
    if (error) throw new Error(`senha de ${item.profile.username}: ${error.message}`);
  }
  if (inserts.length) {
    const rows = inserts.map(item => ({ id: item.id, name: item.name, username: item.username, password_hash: item.hash, role: item.role, active: true, created_at: now, updated_at: now }));
    const { error } = await client.from("profiles").insert(rows);
    if (error) throw new Error(`novos usuários: ${error.message}`);
  }
  if (updates.length || inserts.length) {
    const { error } = await client.from("audit_logs").insert({
      actor_id: null, action: "carga_usuarios", entity: "profiles", entity_id: null,
      details: { senhas_trocadas: updates.map(item => item.profile.username), criados: inserts.map(item => item.username) }
    });
    if (error) throw new Error(`audit_logs: ${error.message}`);
  }
  if (!itemCount && catalog.length) {
    const { error } = await client.from("inventory_items").insert(catalog);
    if (error) throw new Error(`inventory_items: ${error.message}`);
  }
  for (let index = 0; index < enrollments.length; index += 500) {
    const { error } = await client.from("enrollments").upsert(enrollments.slice(index, index + 500), { onConflict: "school_id", ignoreDuplicates: true });
    if (error) throw new Error(`enrollments: ${error.message}`);
  }
  console.log("\nAplicado.");
}

main().catch(error => {
  console.error(`Erro: ${error.message}`);
  process.exit(1);
});
