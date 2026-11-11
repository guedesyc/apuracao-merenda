const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const store = require("../local/modules-store");

const file = { id: "file-1", name: "foto.jpg", path: "2026-11/file-1-foto.jpg", size: 1200, type: "image/jpeg", url: "https://assinado" };

function sampleDoc() {
  return {
    enrollments: { "school-1": { segments: { card7: 158 }, updatedAt: "2026-11-05T18:19:37.575Z", updatedBy: "Planilha" } },
    supervisionReports: [{ id: "sup-1", createdAt: "2026-11-05T15:08:43.589Z", schoolId: "school-1", nutritionistId: "user-a", date: "2026-11-05", notes: "ok", reportFile: file, photos: [file], updatedAt: "2026-11-05T15:08:43.589Z" }],
    events: [{
      id: "evt-1", createdAt: "2026-11-01T10:00:00.000Z", createdBy: "Coordenação", schoolId: "school-1", nutritionistId: "user-a", requestDate: "2026-11-01",
      event: "Festa", audience: "ambos", targetAudience: "Alunos/Adultos", studentQty: 50, studentBilled: false, adultQty: 10, adultMeal: "almoco", quantity: 60,
      hasFruit: true, food: "Bolo", notes: "", eventDate: "2026-11-20", approval: "aprovado", approvalAt: "2026-11-02T10:00:00.000Z", approvalBy: "Coordenação",
      attendance: "realizado", attendanceAt: "2026-11-20T18:00:00.000Z", attendanceBy: "A", done: true, doneAt: "2026-11-21T09:00:00.000Z", updatedAt: "2026-11-21T09:00:00.000Z"
    }],
    notifications: [{
      id: "ntf-1", title: "T", description: "", dueDate: "2026-11-30", questions: [{ id: "q1", text: "?" }], schoolIds: ["school-1"], targetIds: ["user-a"],
      responses: { "user-a": { answers: { q1: "sim" }, attachments: [file], respondedAt: "2026-11-10T10:00:00.000Z", name: "A" } },
      finalFile: null, createdBy: "Coordenação", createdAt: "2026-11-09T10:00:00.000Z", closedAt: null
    }],
    inventoryItems: [
      { id: "ins-1", name: "ARROZ", category: "Secos", unit: "KG", active: true, createdAt: "2026-11-01T00:00:00.000Z", price: 23.24 },
      { id: "ins-2", name: "SAL", category: "Secos", unit: "KG", active: false, createdAt: "2026-11-01T00:00:00.000Z" }
    ],
    inventoryCounts: { "2026-11": { "school-1": { "ins-1": { quantity: 2.5, updatedAt: "2026-11-05T18:39:50.807Z", updatedBy: "A" } } } },
    inventorySubmissions: { "2026-11": { "school-1": { sentAt: "2026-11-26T19:02:00.000Z", sentBy: "A", sentById: "user-a", items: 1 } } },
    inventoryDeadlines: { "2026-11": { "GRE CENTRO": "2026-11-28" } },
    orders: [{
      id: "ped-1", title: "PEDIDO SECOS", month: "2026-12", deliveryDate: "", fileName: "x.xlsx", sheet: "Resumo", createdAt: "2026-11-06T11:57:09.585Z", createdBy: "Coordenação",
      lines: [{ id: "l1", schoolId: "school-1", item: "ARROZ", unit: "KG", qty: 10, nutritionistId: "user-a" }, { id: "l2", schoolId: "school-1", item: "SAL", unit: "KG", qty: 1, nutritionistId: "" }],
      unmatched: [{ label: "ESCOLA X", rows: 0, qty: 0 }], skipped: 3,
      adjustments: { "user-a": { values: { l1: 8 }, savedAt: "2026-11-06T12:02:38.604Z", sentAt: "2026-11-06T12:02:38.604Z", sentBy: "A" } },
      history: [{ id: "hist-1", at: "2026-11-06T12:02:38.604Z", nutritionistId: "user-a", by: "A", action: "sent", changes: [{ lineId: "l1", from: null, to: 8 }] }]
    }],
    km: {
      vehicles: { "user-a": { plate: "NYO-2997", setAt: "2026-11-05T20:42:48.479Z", setBy: "A" } },
      logs: { "2026-11": { "user-a": { days: { "2026-11-03": { start: 1, end: 9.5, note: "visita" } }, fuel: { "2026-11-03": { liters: 30, value: 201.5, by: "ADM", at: "2026-11-06T12:47:00.771Z" } }, savedAt: "2026-11-05T20:44:48.252Z", sentAt: "2026-11-30T20:00:00.000Z", sentBy: "A", review: { status: "conferido", note: "", by: "ADM", at: "2026-12-01T10:00:00.000Z" } } } }
    },
    trainings: [{ month: "2026-11", theme: "Boas Práticas", deadline: "2026-11-19", files: [file], createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z", updatedBy: "Coordenação" }],
    trainingSubmissions: { "2026-11": { "user-a": { files: [file], notes: "", sentAt: "2026-11-10T10:00:00.000Z", sentBy: "A", history: [], review: { status: "devolvido", note: "falta lista", by: "ADM", at: "2026-11-11T10:00:00.000Z" } } } }
  };
}

// Simula o banco: o Postgres devolve timestamptz com "+00:00" no lugar de "Z".
function viaDatabase(rows) {
  return JSON.parse(JSON.stringify(rows).replace(/(\d{2}:\d{2}:\d{2}\.\d{3})Z/g, "$1+00:00"));
}

test("documento dos módulos -> tabelas -> documento mantém os dados", () => {
  const doc = sampleDoc();
  const back = store.fromRows(viaDatabase(store.toRows(doc)));
  const same = (a, b) => assert.deepEqual(store.snapshot(store.toRows(a)), store.snapshot(store.toRows(b)));
  same(doc, back);
  assert.equal(back.events[0].studentBilled, false);
  assert.equal(back.events[0].quantity, 60);
  assert.equal(back.km.logs["2026-11"]["user-a"].days["2026-11-03"].note, "visita");
  assert.equal(back.km.logs["2026-11"]["user-a"].fuel["2026-11-03"].value, 201.5);
  assert.equal(back.inventoryItems[0].price, 23.24);
  assert.equal("price" in back.inventoryItems[1], false);
  assert.equal(back.orders[0].adjustments["user-a"].values.l1, 8);
  assert.equal(back.notifications[0].responses["user-a"].answers.q1, "sim");
});

test("links assinados não são gravados no banco", () => {
  const rows = store.toRows(sampleDoc());
  assert.equal(rows.supervision_reports[0].report_file.url, undefined);
  assert.equal(rows.supervision_reports[0].photos[0].path, file.path);
  assert.equal(rows.trainings[0].files[0].url, undefined);
});

test("linhas vazias ou nulas viram null no banco", () => {
  const rows = store.toRows(sampleDoc());
  assert.equal(rows.orders[0].delivery_date, null);
  assert.equal(rows.order_lines[1].nutritionist_id, null);
  assert.equal(rows.events[0].student_billed, false);
});

test("base local inteira passa pela conversão sem perder linhas", { skip: !fs.existsSync(path.join(__dirname, "..", "local-data", "modules.json")) }, () => {
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "local-data", "modules.json"), "utf8"));
  const rows = store.toRows(doc);
  const back = store.toRows(store.fromRows(viaDatabase(rows)));
  for (const table of store.TABLES) assert.equal(back[table.name].length, rows[table.name].length, table.name);
  assert.deepEqual(store.snapshot(back), store.snapshot(rows));
});

// Banco falso com o pedaço do supabase-js que o store usa (select/order/range, upsert, delete/match/in).
function fakeDatabase() {
  const tables = {};
  const calls = [];
  const rowsOf = name => (tables[name] ||= []);
  const pkOf = name => store.TABLES.find(table => table.name === name).pk;
  return {
    tables, calls,
    from(name) {
      const filters = [];
      let mode = "select";
      const api = {
        select() { return api; },
        order() { return api; },
        or(expr) { const parts = expr.split(",").map(part => part.split(".")); filters.push(row => parts.some(([col, , ...value]) => String(row[col]) >= value.join("."))); return api; },
        lt(col, value) { filters.push(row => String(row[col]) < String(value)); return api; },
        range(from, to) { return Promise.resolve({ data: rowsOf(name).filter(row => filters.every(fn => fn(row))).slice(from, to + 1).map(row => JSON.parse(JSON.stringify(row))), error: null }); },
        upsert(rows) {
          calls.push(["upsert", name, rows.length]);
          const pk = pkOf(name);
          for (const row of rows) {
            const index = rowsOf(name).findIndex(item => pk.every(col => String(item[col]) === String(row[col])));
            if (index >= 0) rowsOf(name)[index] = row; else rowsOf(name).push(row);
          }
          return Promise.resolve({ error: null });
        },
        delete() { mode = "delete"; return api; },
        then(resolve) { const data = rowsOf(name).filter(row => filters.every(fn => fn(row))); resolve({ data, count: data.length, error: null }); },
        match(values) { filters.push(row => Object.entries(values).every(([col, value]) => String(row[col]) === String(value))); return api; },
        in(col, values) {
          if (mode === "select") { const set = new Set(values.map(String)); filters.push(row => set.has(String(row[col]))); return api; }
          calls.push(["delete", name, values.length]);
          const set = new Set(values.map(String));
          tables[name] = rowsOf(name).filter(row => !(filters.every(fn => fn(row)) && set.has(String(row[col]))));
          if (name === "orders") for (const child of ["order_lines", "order_adjustments", "order_history"]) tables[child] = rowsOf(child).filter(row => !set.has(String(row.order_id)));
          return Promise.resolve({ error: null });
        }
      };
      return api;
    }
  };
}

test("gravação só envia o que mudou e apaga o que saiu", async () => {
  const fake = fakeDatabase();
  store.setClient(fake);
  for (const [name, rows] of Object.entries(store.toRows(sampleDoc()))) fake.tables[name] = rows;
  const doc = await store.loadDoc();
  fake.calls.length = 0;

  assert.equal(await store.persistDoc(doc), 0, "sem mudança, nada é gravado");
  assert.deepEqual(fake.calls, []);

  doc.events[0].notes = "mudou";
  delete doc.inventoryCounts["2026-11"]["school-1"]["ins-1"];
  doc.km.logs["2026-11"]["user-a"].days["2026-11-04"] = { start: 10, end: 20 };
  await store.persistDoc(doc);
  assert.deepEqual(fake.calls, [["upsert", "events", 1], ["upsert", "km_logs", 1], ["delete", "inventory_counts", 1]]);
  assert.equal(fake.tables.events[0].notes, "mudou");
  assert.equal(fake.tables.inventory_counts.length, 0);

  fake.calls.length = 0;
  doc.orders = [];
  await store.persistDoc(doc);
  assert.deepEqual(fake.calls, [["delete", "orders", 1]], "apagar o pedido leva linhas, ajustes e histórico juntos");
  assert.equal(fake.tables.order_lines.length, 0);

  const reloaded = await store.loadDoc();
  assert.equal(reloaded.events[0].notes, "mudou");
  assert.equal(reloaded.km.logs["2026-11"]["user-a"].days["2026-11-04"].end, 20);
  store.setClient(null);
});

test("pedidos antigos ficam fora da memória e da gravação, e vêm sob demanda", async () => {
  const fake = fakeDatabase();
  store.setClient(fake);
  const doc = sampleDoc();
  const old = JSON.parse(JSON.stringify(doc.orders[0]));
  Object.assign(old, { id: "ped-old", month: "2026-03", createdAt: "2026-02-20T10:00:00.000Z" });
  old.lines = old.lines.map(line => ({ ...line }));
  old.history = [{ ...old.history[0], id: "hist-old" }];
  doc.orders.push(old);
  for (const [name, rows] of Object.entries(store.toRows(doc))) fake.tables[name] = rows;
  const recent = { month: "2026-09", createdAt: "2026-08-08T00:00:00.000Z" };

  const loaded = await store.loadDoc(recent);
  assert.deepEqual(loaded.orders.map(order => order.id), ["ped-1"]);
  assert.equal(await store.countOlderOrders(recent), 1);

  fake.calls.length = 0;
  loaded.events[0].notes = "x";
  await store.persistDoc(loaded);
  assert.deepEqual(fake.calls, [["upsert", "events", 1]], "o pedido antigo não é apagado só por não estar na memória");
  assert.equal(fake.tables.order_lines.filter(row => row.order_id === "ped-old").length, 2);

  const older = await store.loadOlderOrders(recent);
  assert.deepEqual(older.map(order => order.id), ["ped-old"]);
  assert.equal(older[0].lines.length, 2);
  assert.equal(older[0].history[0].id, "hist-old");
  store.setClient(null);
});

test("gás e gêneros: documento -> tabelas -> documento mantém os dados", () => {
  const doc = sampleDoc();
  doc.gasPrices = { P13: 142, P45: 516 };
  doc.gasRecords = [{
    id: "gas-1", schoolId: "school-1", nutritionistId: "user-a", month: "2026-11", quantity: 3, gasType: "P13", unitValue: 142, total: 426,
    createdAt: "2026-11-02T10:00:00.000Z", createdBy: "ADM", updatedAt: "2026-11-02T10:00:00.000Z", updatedBy: "ADM"
  }];
  doc.generoSubmissions = { "2026-11": { "user-a": { files: [{ id: "file-g", name: "generos.pdf", path: "2026-11/file-g-generos.pdf", size: 10, type: "application/pdf" }], sentAt: "2026-11-05T10:00:00.000Z", sentBy: "A", history: [] } } };
  const back = store.fromRows(viaDatabase(store.toRows(doc)));
  assert.deepEqual(store.snapshot(store.toRows(back)), store.snapshot(store.toRows(doc)));
  assert.equal(back.gasRecords[0].total, 426);
  assert.equal(back.gasPrices.P45, 516);
  assert.equal(back.generoSubmissions["2026-11"]["user-a"].files[0].path, "2026-11/file-g-generos.pdf");
});
