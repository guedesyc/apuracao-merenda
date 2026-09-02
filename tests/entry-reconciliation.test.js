const test = require("node:test");
const assert = require("node:assert/strict");

const {
  reconcileEntriesWithExisting,
  isEntryIdentityConflict,
  businessDaysForMonth,
  exportAverageWorkbook
} = require("../netlify/functions/api")._test;
const ExcelJS = require("exceljs");

const nutritionistId = "nutritionist-1";

function entry(id, date, quantities = {}) {
  return {
    id,
    date,
    month: date.slice(0, 7),
    schoolId: "school-1",
    nutritionistId,
    status: "served",
    quantities
  };
}

test("reuses the database id for the same date, school and nutritionist", () => {
  const incoming = [entry("entry-from-another-tab", "2026-09-01", { "card-1": 25 })];
  const existing = [{
    id: "entry-in-database",
    entry_date: "2026-09-01",
    school_id: "school-1",
    nutritionist_id: nutritionistId
  }];

  const [result] = reconcileEntriesWithExisting(incoming, existing, nutritionistId);

  assert.equal(result.id, "entry-in-database");
  assert.deepEqual(result.quantities, { "card-1": 25 });
});

test("collapses duplicate incoming entries and keeps the latest form state", () => {
  const incoming = [
    entry("entry-old", "2026-09-01", { "card-1": 10 }),
    entry("entry-draft", "2026-09-01", { "card-1": 30 })
  ];

  const result = reconcileEntriesWithExisting(incoming, [], nutritionistId);

  assert.equal(result.length, 1);
  assert.equal(result[0].id, "entry-draft");
  assert.deepEqual(result[0].quantities, { "card-1": 30 });
});

test("keeps a genuinely new date as a new entry", () => {
  const incoming = [entry("entry-new", "2026-09-02", { "card-1": 15 })];

  const [result] = reconcileEntriesWithExisting(incoming, [], nutritionistId);

  assert.equal(result.id, "entry-new");
});

test("only retries the known natural-key conflict", () => {
  assert.equal(isEntryIdentityConflict({
    code: "23505",
    message: 'duplicate key value violates unique constraint "entries_entry_date_school_id_nutritionist_id_key"'
  }), true);
  assert.equal(isEntryIdentityConflict({ code: "23505", message: "another constraint" }), false);
  assert.equal(isEntryIdentityConflict({ code: "23503", message: "foreign key" }), false);
});

test("exports an independent average for each card using configured business days", async () => {
  const db = {
    settings: { workingDaysByMonth: { "2026-08": 20 } },
    cards: [
      { id: "card-3", label: "CARD 3" },
      { id: "card-5", label: "CARD 5" }
    ],
    schools: [{ id: "school-1", shortName: "Escola Mario Altenfelder", route: "GRE CENTRO" }],
    entries: [
      { date: "2026-08-01", schoolId: "school-1", nutritionistName: "Nutri", status: "served", quantities: { "card-3": 100, "card-5": 40 }, reason: "" },
      { date: "2026-08-02", schoolId: "school-1", nutritionistName: "Nutri", status: "served", quantities: { "card-3": 50, "card-5": 20 }, reason: "" }
    ]
  };

  assert.equal(businessDaysForMonth(db, "2026-08"), 20);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await exportAverageWorkbook(db, "2026-08"));
  const row = workbook.getWorksheet("Médias").getRow(5);

  assert.equal(row.getCell(5).value, 7.5);
  assert.equal(row.getCell(6).value, 3);
  assert.equal(row.getCell(7).value, 10.5);
});
