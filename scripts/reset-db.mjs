// Restore the brief's initial state: inventory + the seeded Camera A booking (10–12 Oct 2026).
// DELETES every other booking, so it asks for --yes and always backs up the database first.
//
//   npm run reset-db -- --yes        resets data/rentvoice.db (or DB_PATH)
//   npm run test-db:reset            resets the separate test database data/test-run.db
import { openDb, seed, backupDb } from '../src/db.js';
import { snapshot } from '../src/booking.js';

const file = process.env.DB_PATH || 'data/rentvoice.db';
if (!process.argv.includes('--yes')) {
  console.log(`This deletes every booking in ${file} except the seeded one.`);
  console.log('A backup is made first. Run again with --yes to continue:  npm run reset-db -- --yes');
  process.exit(1);
}
const db = openDb(file);
const backup = await backupDb(db, file);
seed(db);
const s = snapshot(db);
console.log(`Backup:   ${backup}`);
console.log(`Reset:    ${file} → ${s.booking_count} booking(s): ${s.bookings.map((b) => `${b.id} ${b.equipment_id} ${b.start_date}→${b.end_date}`).join(', ')}`);
