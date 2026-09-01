const test = require("node:test");
const assert = require("node:assert/strict");

const {
  reconcileEntriesWithExisting,
  isEntryIdentityConflict
} = require("../netlify/functions/api")._test;

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
