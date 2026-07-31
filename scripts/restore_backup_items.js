const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const ROOT = path.resolve(__dirname, "..");
const BACKUP_DIR = process.argv[2]
  ? path.resolve(ROOT, process.argv[2])
  : path.join(ROOT, "backups", "2026-07-27T14-21-04-037Z");

function loadDotEnv() {
  const envFile = path.join(ROOT, "env.env");
  if (!fs.existsSync(envFile)) throw new Error("Arquivo env.env nao encontrado.");
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

function requiredEnv(name) {
  if (!process.env[name]) throw new Error(`Configure ${name} no env.env.`);
  return process.env[name];
}

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, name), "utf8"));
}

async function selectAll(client, table) {
  const rows = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await client.from(table).select("*").range(from, from + pageSize - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < pageSize) return rows;
  }
}

async function main() {
  loadDotEnv();
  const client = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  const audit = readJson("recovery-audit.json");
  const currentItems = await selectAll(client, "entry_items");
  const currentKeys = new Set(currentItems.map(item => `${item.entry_id}|${item.card_id}`));
  const rowsToInsert = audit.missingItemsForExistingEntries
    .filter(item => !currentKeys.has(`${item.entry_id}|${item.card_id}`))
    .map(item => ({ entry_id: item.entry_id, card_id: item.card_id, quantity: item.quantity }));

  for (let from = 0; from < rowsToInsert.length; from += 100) {
    const batch = rowsToInsert.slice(from, from + 100);
    const { error } = await client.from("entry_items").insert(batch);
    if (error) throw new Error(`entry_items (${from + 1}-${from + batch.length}): ${error.message}`);
  }

  console.log(`Itens restaurados sem sobrescrever dados existentes: ${rowsToInsert.length}`);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
