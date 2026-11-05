// Cliente local compatível com o subconjunto do supabase-js usado em netlify/functions/api.js.
// Os dados ficam em local-data/db.json. Nenhuma conexão externa é feita.
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = process.env.LOCAL_DATA_DIR || path.join(ROOT, "local-data");
const DB_FILE = path.join(DATA_DIR, "db.json");

const TABLES = [
  "profiles", "routes", "schools", "nutritionist_schools", "cards", "settings",
  "entries", "entry_items", "monthly_closures", "exports", "audit_logs"
];

const UNIQUE = {
  entries: { cols: ["entry_date", "school_id", "nutritionist_id"], name: "entries_entry_date_school_id_nutritionist_id_key" }
};

let store = null;
let auditSeq = 0;

function load() {
  if (store) return store;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    store = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } else {
    store = {};
  }
  for (const table of TABLES) if (!Array.isArray(store[table])) store[table] = [];
  auditSeq = store.audit_logs.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0);
  return store;
}

let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(flush, 30);
}

function flush() {
  if (!store) return;
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, DB_FILE);
}

process.on("exit", flush);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseEmbeds(columns) {
  const embeds = [];
  const regex = /([a-z_]+)\s*\(([^)]*)\)/g;
  let match;
  while ((match = regex.exec(String(columns || "")))) embeds.push(match[1]);
  return embeds;
}

function foreignKeyFor(table) {
  return `${table.replace(/ies$/, "y").replace(/s$/, "")}_id`;
}

class Query {
  constructor(table) {
    this.table = table;
    this.op = "select";
    this.filters = [];
    this.orders = [];
    this.rangeValue = null;
    this.singleMode = null;
    this.columns = "*";
    this.countMode = null;
    this.headMode = false;
    this.payload = null;
    this.options = {};
  }

  select(columns = "*", options = {}) {
    if (this.op === "select") {
      this.columns = columns;
      this.countMode = options.count || null;
      this.headMode = Boolean(options.head);
    }
    return this;
  }

  eq(column, value) { this.filters.push(row => row[column] === value); return this; }
  neq(column, value) { this.filters.push(row => row[column] !== value); return this; }
  in(column, values) { const set = new Set(values || []); this.filters.push(row => set.has(row[column])); return this; }
  gte(column, value) { this.filters.push(row => row[column] >= value); return this; }
  lte(column, value) { this.filters.push(row => row[column] <= value); return this; }
  order(column, { ascending = true } = {}) { this.orders.push({ column, ascending }); return this; }
  range(from, to) { this.rangeValue = [from, to]; return this; }
  limit(count) { this.rangeValue = [0, count - 1]; return this; }
  maybeSingle() { this.singleMode = "maybe"; return this; }
  single() { this.singleMode = "single"; return this; }

  insert(rows) { this.op = "insert"; this.payload = rows; return this; }
  upsert(rows, options = {}) { this.op = "upsert"; this.payload = rows; this.options = options; return this; }
  update(patch) { this.op = "update"; this.payload = patch; return this; }
  delete() { this.op = "delete"; return this; }

  then(resolve, reject) {
    try {
      resolve(this.execute());
    } catch (error) {
      if (reject) reject(error);
      else throw error;
    }
  }

  matches(row) {
    return this.filters.every(filter => filter(row));
  }

  execute() {
    const db = load();
    const rows = db[this.table];
    if (!rows) return { data: null, error: { message: `Tabela ${this.table} não existe.` } };

    if (this.op === "select") return this.executeSelect(db, rows);
    if (this.op === "insert") return this.executeWrite(rows, false);
    if (this.op === "upsert") return this.executeWrite(rows, true);

    if (this.op === "update") {
      const now = new Date().toISOString();
      for (const row of rows) if (this.matches(row)) Object.assign(row, this.payload, row.updated_at !== undefined && !this.payload.updated_at ? { updated_at: now } : {});
      persist();
      return { data: null, error: null };
    }

    if (this.op === "delete") {
      db[this.table] = rows.filter(row => !this.matches(row));
      persist();
      return { data: null, error: null };
    }
    return { data: null, error: { message: "Operação não suportada." } };
  }

  executeSelect(db, rows) {
    let result = rows.filter(row => this.matches(row));
    const count = result.length;
    if (this.headMode) return { data: null, count, error: null };

    for (const { column, ascending } of [...this.orders].reverse()) {
      result = [...result].sort((left, right) => {
        const a = left[column];
        const b = right[column];
        if (a === b) return 0;
        if (a === undefined || a === null) return 1;
        if (b === undefined || b === null) return -1;
        return (a < b ? -1 : 1) * (ascending ? 1 : -1);
      });
    }
    if (this.rangeValue) result = result.slice(this.rangeValue[0], this.rangeValue[1] + 1);

    const embeds = parseEmbeds(this.columns);
    const fk = foreignKeyFor(this.table);
    const indexes = embeds.map(embed => {
      const index = new Map();
      for (const child of db[embed] || []) {
        if (!index.has(child[fk])) index.set(child[fk], []);
        index.get(child[fk]).push(child);
      }
      return [embed, index];
    });
    result = result.map(row => {
      const copy = { ...row };
      for (const [embed, index] of indexes) copy[embed] = (index.get(row.id) || []).map(child => ({ ...child }));
      return copy;
    });

    if (this.singleMode) {
      if (result.length > 1 && this.singleMode === "single") return { data: null, error: { message: "Mais de uma linha." } };
      return { data: result[0] || null, error: null };
    }
    return { data: result, count: this.countMode ? count : null, error: null };
  }

  executeWrite(rows, isUpsert) {
    const incoming = Array.isArray(this.payload) ? this.payload : [this.payload];
    const conflictCols = String(this.options.onConflict || "id").split(",").map(item => item.trim());
    const now = new Date().toISOString();
    const unique = UNIQUE[this.table];

    for (const raw of incoming) {
      const row = { ...raw };
      if (this.table === "audit_logs" && row.id === undefined) row.id = ++auditSeq;
      if (row.created_at === undefined && ["profiles", "routes", "schools", "nutritionist_schools", "exports", "audit_logs"].includes(this.table)) row.created_at = now;
      if (row.updated_at === undefined && ["profiles", "schools", "settings", "entries", "monthly_closures"].includes(this.table)) row.updated_at = now;

      const index = isUpsert ? rows.findIndex(item => conflictCols.every(col => item[col] === row[col])) : -1;

      if (unique) {
        const clash = rows.find((item, i) => i !== index && unique.cols.every(col => item[col] === row[col]));
        if (clash) {
          persist();
          return { data: null, error: { code: "23505", message: `duplicate key value violates unique constraint "${unique.name}"` } };
        }
      }

      if (index >= 0) rows[index] = { ...rows[index], ...row };
      else rows.push(row);
    }
    persist();
    return { data: null, error: null };
  }
}

function createLocalClient() {
  load();
  return {
    from(table) {
      return new Query(table);
    }
  };
}

function localStore() {
  return load();
}

module.exports = { createLocalClient, localStore, flush, DATA_DIR, DB_FILE };
