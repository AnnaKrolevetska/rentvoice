// Read-only print of the database state, for "before / after" evidence.
//   npm run db:snapshot          (data/rentvoice.db or DB_PATH)
//   npm run test-db:snapshot     (data/test-run.db)
import Database from 'better-sqlite3';
import fs from 'node:fs';

const file = process.env.DB_PATH || 'data/rentvoice.db';
if (!fs.existsSync(file)) { console.log(`${file} does not exist yet (it is created on the first npm start).`); process.exit(0); }
const db = new Database(file, { readonly: true, fileMustExist: true });
const inv = db.prepare('SELECT id, name, total_quantity FROM inventory ORDER BY rowid').all();
const rows = db.prepare('SELECT id, equipment_id, quantity, start_date, end_date, status, created_at FROM bookings ORDER BY created_at, rowid').all();
console.log(`Database: ${file}   (read-only snapshot at ${new Date().toISOString()})`);
console.log(`Inventory: ${inv.map((i) => `${i.name} × ${i.total_quantity}`).join(', ')}`);
console.log(`Bookings: ${rows.length} row(s)`);
console.table(rows);
