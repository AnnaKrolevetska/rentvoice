import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.APP_TODAY = '2026-10-01'; // fixed clock so past-date checks and relative dates are reproducible

const { SCENARIOS, runScenario } = await import('../scripts/scenarios.js');
const { openDb, seed } = await import('../src/db.js');
const { availability, rentalDays } = await import('../src/booking.js');

for (const sc of SCENARIOS) {
  test(`${sc.id} ${sc.title}`, () => {
    const r = runScenario(sc);
    assert.ok(r.pass, `${sc.id} failed:\n${JSON.stringify(r.steps.map((s) => s.result), null, 2)}`);
  });
}

test('inclusive day count', () => {
  assert.equal(rentalDays('2026-10-10', '2026-10-10'), 1);
  assert.equal(rentalDays('2026-10-10', '2026-10-12'), 3);
});

test('availability uses the busiest day, not the sum of overlapping bookings', () => {
  const db = openDb(':memory:');
  seed(db);
  // Seed: camera 10–12 Oct. Add another camera 14–15 Oct. A request for 10–15 Oct
  // overlaps both bookings, but no single day has 2 cameras out → 1 free, not 0.
  db.prepare(`INSERT INTO bookings (id, equipment_id, quantity, start_date, end_date) VALUES ('T1','camera_a',1,'2026-10-14','2026-10-15')`).run();
  assert.equal(availability(db, 'camera_a', '2026-10-10', '2026-10-15').available, 1);
  // Same-day stacking does reduce it to 0.
  db.prepare(`INSERT INTO bookings (id, equipment_id, quantity, start_date, end_date) VALUES ('T2','camera_a',1,'2026-10-11','2026-10-11')`).run();
  assert.equal(availability(db, 'camera_a', '2026-10-10', '2026-10-15').available, 0);
});

test('database rejects a second booking for the same draft (idempotency key)', () => {
  const db = openDb(':memory:');
  seed(db);
  const ins = db.prepare(`INSERT INTO bookings (id, equipment_id, quantity, start_date, end_date, source_draft_id) VALUES (?, 'tripod_b', 1, '2026-11-01', '2026-11-01', 'DR-X')`);
  ins.run('A');
  assert.throws(() => ins.run('B'), /UNIQUE/);
});

test('stock panel counts the whole rental period, not one day', async () => {
  const { stockForRange } = await import('../src/booking.js');
  const db = openDb(':memory:');
  seed(db); // Camera A ×1 out 10–12 Oct
  const cam = (s, e) => stockForRange(db, s, e).find((i) => i.equipment_id === 'camera_a').available;
  assert.equal(cam('2026-10-05', '2026-10-09'), 2); // ends the day before the seed
  assert.equal(cam('2026-10-08', '2026-10-10'), 1); // only the LAST day overlaps → still counted
  assert.equal(cam('2026-10-12', '2026-10-20'), 1); // only the FIRST day overlaps
  assert.equal(cam('2026-10-13', '2026-10-20'), 2); // starts the day after the seed
  // A second camera booked on a single day inside a long range makes the whole range full.
  db.prepare(`INSERT INTO bookings (id, equipment_id, quantity, start_date, end_date) VALUES ('T3','camera_a',1,'2026-10-11','2026-10-11')`).run();
  assert.equal(cam('2026-10-01', '2026-10-30'), 0);
});
