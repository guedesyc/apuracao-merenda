const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const ROOT = path.resolve(__dirname, "..");
const TABLES = [
  "profiles",
  "routes",
  "schools",
  "nutritionist_schools",
  "cards",
  "settings",
  "entries",
  "entry_items",
  "monthly_closures",
  "exports",
  "audit_logs"
];

function loadDotEnv() {
  const envFile = [".env", "env.env"].map(file => path.join(ROOT, file)).find(file => fs.existsSync(file));
  if (!envFile) return;
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

function requiredEnv(name) {
  if (!process.env[name]) throw new Error(`Configure ${name} no ambiente, no arquivo .env ou no arquivo env.env.`);
  return process.env[name];
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function selectAll(client, table) {
  const rows = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await client.from(table).select("*").range(from, from + pageSize - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

async function main() {
  loadDotEnv();
  const client = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false }
  });
  const outDir = path.join(ROOT, "backups", stamp());
  fs.mkdirSync(outDir, { recursive: true });

  const manifest = {
    createdAt: new Date().toISOString(),
    tables: {}
  };

  for (const table of TABLES) {
    const rows = await selectAll(client, table);
    fs.writeFileSync(path.join(outDir, `${table}.json`), JSON.stringify(rows, null, 2));
    manifest.tables[table] = rows.length;
    console.log(`${table}: ${rows.length} linhas`);
  }

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`Backup manual salvo em: ${outDir}`);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
