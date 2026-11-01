// Restoring the seed must never lose data silently: a backup is written first,
// and opening an existing database must not reseed or change it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb, seed, backupDb, SEED_BOOKING } from '../src/db.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rv-safety-'));

test('seed is the brief\'s Camera A booking, 10–12 Oct 2026', () => {
  assert.deepEqual(
    { e: SEED_BOOKING.equipment_id, q: SEED_BOOKING.quantity, s: SEED_BOOKING.start_date, z: SEED_BOOKING.end_date },
    { e: 'camera_a', q: 1, s: '2026-10-10', z: '2026-10-12' },
  );
});

test('reopening an existing database keeps its bookings (no automatic reseed)', () => {
  const file = path.join(tmp(), 'user.db');
  const db = openDb(file);
  db.prepare(`INSERT INTO bookings (id, equipment_id, quantity, start_date, end_date) VALUES ('BK-USER','tripod_b',1,'2026-10-15','2026-10-17')`).run();
  db.close();
  const again = openDb(file);
  assert.ok(again.prepare(`SELECT 1 FROM bookings WHERE id='BK-USER'`).get(), 'user booking survives a restart');
  again.close();
});

test('reset backs up the database first; the backup still holds the removed bookings', async () => {
  const file = path.join(tmp(), 'user.db');
  const db = openDb(file);
  db.prepare(`INSERT INTO bookings (id, equipment_id, quantity, start_date, end_date) VALUES ('BK-USER','tripod_b',1,'2026-10-15','2026-10-17')`).run();
  const backup = await backupDb(db, file);
  seed(db); // what Reset to seed / reset-db do after the backup
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n, 1);
  assert.ok(fs.existsSync(backup) && backup.includes(`${path.sep}backups${path.sep}`));
  const old = new Database(backup, { readonly: true });
  assert.ok(old.prepare(`SELECT 1 FROM bookings WHERE id='BK-USER'`).get(), 'backup contains the user booking');
  old.close(); db.close();
});

test('in-memory databases are not backed up (tests)', async () => {
  assert.equal(await backupDb(openDb(':memory:'), ':memory:'), null);
});
