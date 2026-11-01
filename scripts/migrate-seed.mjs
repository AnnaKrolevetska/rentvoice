// Move the seeded booking (BK-SEED-001) in an EXISTING database to the dates in
// src/db.js (SEED_BOOKING), keeping every other booking.
//
//   npm run migrate-seed             dry run: shows what would change
//   npm run migrate-seed -- --apply  backs up the .db file, then updates the row
//
// Refuses if the new dates would overbook the item (other bookings already use
// the units on those days). Safe to run more than once.
import { openDb, SEED_BOOKING } from '../src/db.js';
import { availability } from '../src/booking.js';

const apply = process.argv.includes('--apply');
const file = process.env.DB_PATH || 'data/rentvoice.db';
const db = openDb(file);
const target = SEED_BOOKING;
const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(target.id);
const fmt = (b) => `${b.id} ${b.equipment_id} ×${b.quantity} ${b.start_date} → ${b.end_date}`;

console.log(`Database: ${file}`);
console.log(`Target:   ${fmt(target)}`);
console.log(`Current:  ${row ? fmt(row) : '(no seed booking in this database)'}`);

if (row && row.equipment_id === target.equipment_id && row.quantity === target.quantity
  && row.start_date === target.start_date && row.end_date === target.end_date) {
  console.log('Already up to date. Nothing to do.');
  process.exit(0);
}

// Would the seed fit on the new dates next to everything else already booked?
const av = availability(db, target.equipment_id, target.start_date, target.end_date, { excludeBookingId: target.id });
if (av.available < target.quantity) {
  console.error(`\nCannot move: only ${av.available} ${av.name} free on ${target.start_date} → ${target.end_date} without the seed.`);
  console.error('Bookings in the way:');
  for (const b of av.overlapping_bookings) console.error(`  ${b.id} ×${b.quantity} ${b.start_date} → ${b.end_date}`);
  console.error('Cancel or move one of them first, or use Reset to seed (deletes all other bookings).');
  process.exit(1);
}

const others = db.prepare('SELECT COUNT(*) AS n FROM bookings WHERE id <> ?').get(target.id).n;
if (!apply) {
  console.log(`\nDry run: the seed would ${row ? 'move' : 'be added'}; ${others} other booking(s) stay untouched.`);
  console.log('Run again with --apply to write the change (a backup of the .db file is made first).');
  process.exit(0);
}

const backup = `${file}.backup-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
await db.backup(backup);
console.log(`\nBackup:   ${backup}`);

db.transaction(() => {
  if (row) {
    db.prepare('UPDATE bookings SET equipment_id = ?, quantity = ?, start_date = ?, end_date = ? WHERE id = ?')
      .run(target.equipment_id, target.quantity, target.start_date, target.end_date, target.id);
  } else {
    db.prepare(`INSERT INTO bookings (id, equipment_id, quantity, start_date, end_date, status, session_id)
                VALUES (?, ?, ?, ?, ?, 'confirmed', 'seed')`)
      .run(target.id, target.equipment_id, target.quantity, target.start_date, target.end_date);
  }
}).immediate();

const now = db.prepare('SELECT * FROM bookings WHERE id = ?').get(target.id);
const total = db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n;
console.log(`Updated:  ${fmt(now)}`);
console.log(`Bookings in database: ${total} (other bookings unchanged: ${others}).`);
