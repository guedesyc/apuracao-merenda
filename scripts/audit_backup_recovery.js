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
  const [backupEntries, backupItems, currentEntries, currentItems] = await Promise.all([
    Promise.resolve(readJson("entries.json")),
    Promise.resolve(readJson("entry_items.json")),
    selectAll(client, "entries"),
    selectAll(client, "entry_items")
  ]);

  const currentEntryIds = new Set(currentEntries.map(entry => entry.id));
  const currentItemKeys = new Set(currentItems.map(item => `${item.entry_id}|${item.card_id}`));
  const missingItems = backupItems.filter(item =>
    currentEntryIds.has(item.entry_id) && !currentItemKeys.has(`${item.entry_id}|${item.card_id}`)
  );
  const missingForDeletedEntries = backupItems.filter(item => !currentEntryIds.has(item.entry_id));
  const report = {
    backupDir: BACKUP_DIR,
    backupEntries: backupEntries.length,
    currentEntries: currentEntries.length,
    backupItems: backupItems.length,
    currentItems: currentItems.length,
    missingItemsForExistingEntries: missingItems,
    missingItemsForDeletedEntries: missingForDeletedEntries
  };
  const reportPath = path.join(BACKUP_DIR, "recovery-audit.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`Itens que podem ser recuperados sem sobrescrever dados atuais: ${missingItems.length}`);
  console.log(`Itens ligados a lancamentos que nao existem mais: ${missingForDeletedEntries.length}`);
  console.log(`Relatorio salvo em: ${reportPath}`);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
