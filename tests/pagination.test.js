const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcileEntryIds, entryIdsWithChangedQuantities } = require('../netlify/functions/api')._test;

test('reconciles and compares entries beyond the first thousand', async () => {
  const actor = { id: 'nutri', role: 'nutritionist' };
  const rows = Array.from({ length: 1001 }, (_, i) => ({
    id: String(i).padStart(4, '0'), entry_date: '2026-10-01', school_id: 'school-' + i,
    nutritionist_id: 'nutri', entry_items: [{ card_id: 'card', quantity: 7 }]
  }));
  const client = { from() {
    let start, end, owner;
    const query = {
      select() { return this; }, order() { return this; },
      range(a, b) { start = a; end = b; return this; },
      eq(key, value) { owner = value; return this; },
      then(resolve) { return Promise.resolve({ data: rows.filter(r => r.nutritionist_id === owner).slice(start, end + 1), error: null }).then(resolve); }
    };
    return query;
  }};
  const incoming = { entries: [{ id: 'draft', date: '2026-10-01', schoolId: 'school-1000', nutritionistId: 'nutri', status: 'served', quantities: { card: 7 } }] };
  const reconciled = await reconcileEntryIds(client, actor, incoming);
  assert.equal(reconciled.entries[0].id, '1000');
  assert.deepEqual(await entryIdsWithChangedQuantities(client, actor, reconciled), []);
});
