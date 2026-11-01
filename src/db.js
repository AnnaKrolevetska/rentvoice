// SQLite storage: inventory catalog, confirmed bookings, booking drafts
// (proposals waiting for confirmation) and an event log for metrics.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export const INITIAL_INVENTORY = [
  { id: 'camera_a', name: 'Camera A', total_quantity: 2 },
  { id: 'tripod_b', name: 'Tripod B', total_quantity: 3 },
  { id: 'microphone_c', name: 'Microphone C', total_quantity: 1 },
];

export const SEED_BOOKING = {
  id: 'BK-SEED-001',
  equipment_id: 'camera_a',
  quantity: 1,
  start_date: '2026-10-10',
  end_date: '2026-10-12',
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS inventory (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  total_quantity INTEGER NOT NULL CHECK (total_quantity >= 0)
);

CREATE TABLE IF NOT EXISTS bookings (
  id              TEXT PRIMARY KEY,
  equipment_id    TEXT NOT NULL REFERENCES inventory(id),
  quantity        INTEGER NOT NULL CHECK (quantity > 0),
  start_date      TEXT NOT NULL,              -- YYYY-MM-DD, inclusive
  end_date        TEXT NOT NULL,              -- YYYY-MM-DD, inclusive
  status          TEXT NOT NULL DEFAULT 'confirmed',
  source_draft_id TEXT UNIQUE,                -- idempotency key: one booking per draft
  session_id      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (end_date >= start_date)
);

CREATE TABLE IF NOT EXISTS drafts (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  equipment_id  TEXT NOT NULL REFERENCES inventory(id),
  quantity      INTEGER NOT NULL,
  start_date    TEXT NOT NULL,
  end_date      TEXT NOT NULL,
  status        TEXT NOT NULL,   -- pending | superseded | cancelled | confirmed | rejected
  created_turn  INTEGER NOT NULL,
  booking_id    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  kind       TEXT NOT NULL,      -- tool_call | latency | usage | transcription_usage | session
  payload    TEXT NOT NULL,      -- JSON
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

export function openDb(file = process.env.DB_PATH || 'data/rentvoice.db') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  const count = db.prepare('SELECT COUNT(*) AS n FROM inventory').get().n;
  if (count === 0) seed(db);
  return db;
}

// Restore the brief's initial state: catalog + one seeded booking, nothing else.
export function seed(db) {
  db.transaction(() => {
    db.exec('DELETE FROM bookings; DELETE FROM drafts; DELETE FROM inventory;');
    const ins = db.prepare('INSERT INTO inventory (id, name, total_quantity) VALUES (?, ?, ?)');
    for (const item of INITIAL_INVENTORY) ins.run(item.id, item.name, item.total_quantity);
    const b = SEED_BOOKING;
    db.prepare(
      `INSERT INTO bookings (id, equipment_id, quantity, start_date, end_date, status, session_id)
       VALUES (?, ?, ?, ?, ?, 'confirmed', 'seed')`
    ).run(b.id, b.equipment_id, b.quantity, b.start_date, b.end_date);
  })();
}

// Copy the database file to data/backups/<name>-<timestamp>.db before anything
// destructive (Reset to seed, reset-db). Returns the backup path, or null for :memory:.
export async function backupDb(db, file) {
  if (!file || file === ':memory:') return null;
  const dir = path.join(path.dirname(file), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = path.join(dir, `${path.basename(file, '.db')}-${stamp}.db`);
  await db.backup(out);
  return out;
}

export function logEvent(db, sessionId, kind, payload) {
  db.prepare('INSERT INTO events (session_id, kind, payload) VALUES (?, ?, ?)')
    .run(sessionId ?? null, kind, JSON.stringify(payload));
}
