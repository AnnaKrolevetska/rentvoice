// HTTP server: serves the UI, mints short-lived Realtime keys, executes tool
// calls against SQLite, and records latency/usage metrics.
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, seed, logEvent, SEED_BOOKING, backupDb } from './db.js';
import { runTool, GREETING } from './agent.js';
import { sessionConfig, config } from './realtime-config.js';
import {
  currentDraft, stockForRange, snapshot, today, listInventory, humanRange, parseDay, rentalDays, MAX_RENTAL_DAYS, availability,
} from './booking.js';
import { realtimeResponseCost, transcriptionCost, PRICING_SOURCE, REALTIME_PRICES } from './pricing.js';
import { summarizeMetrics } from './metrics.js';

const OPENAI_API = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'; // overridable for offline tests
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = process.env.DB_PATH || 'data/rentvoice.db';
const db = openDb(DB_FILE);
const app = express();
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Optional passcode so a public demo URL cannot spend the API key freely.
const PASSCODE = process.env.DEMO_PASSCODE || '';
const guard = (req, res, next) => {
  if (!PASSCODE || req.get('x-demo-passcode') === PASSCODE) return next();
  res.status(401).json({ error: 'passcode_required' });
};

// Sessions we issued (in memory; one conversation at a time is the scope).
const sessions = new Map(); // sessionId -> { model, startedAt }

app.get('/api/config', (_req, res) => {
  const c = config();
  res.json({ today: today(), model: c.model, voice: c.voice, transcribeModel: c.transcribeModel, vad: `${c.vad}/${c.eagerness}`, passcodeRequired: !!PASSCODE, hasKey: !!process.env.OPENAI_API_KEY, database: path.basename(DB_FILE) });
});

// 1) Browser asks for a session → we mint an ephemeral key with the full config.
app.post('/api/session', guard, async (req, res) => {
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY is not set on the server (.env).' });
  const session = sessionConfig();
  if (req.body?.model && REALTIME_PRICES[req.body.model]) session.model = req.body.model;
  try {
    const r = await fetch(`${OPENAI_API}/realtime/client_secrets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expires_after: { anchor: 'created_at', seconds: 600 }, session }),
    });
    const body = await r.json();
    if (!r.ok) return res.status(502).json({ error: 'openai_error', detail: body });
    const sessionId = 'S-' + crypto.randomBytes(4).toString('hex');
    sessions.set(sessionId, { model: session.model, startedAt: Date.now() });
    logEvent(db, sessionId, 'session', { event: 'start', model: session.model, voice: session.audio.output.voice });
    res.json({ sessionId, clientSecret: body.value, expiresAt: body.expires_at, model: session.model, greeting: GREETING });
  } catch (e) {
    res.status(502).json({ error: 'network_error', detail: String(e) });
  }
});

// 2) Tool call relayed by the browser. `turn` = user-turn counter at the time
//    the model's response was created (used for the explicit-confirmation rule).
app.post('/api/tool', guard, (req, res) => {
  const { sessionId, name, args, turn } = req.body || {};
  if (!sessions.has(sessionId)) return res.status(400).json({ ok: false, error: 'unknown_session' });
  res.json(runTool(name, args || {}, { db, sessionId, turn: Number(turn) || 0, source: 'voice' }));
});

// 3) The Confirm button on the summary card (same idempotent path as voice).
app.post('/api/confirm', guard, (req, res) => {
  const { sessionId, draftId } = req.body || {};
  if (!sessions.has(sessionId)) return res.status(400).json({ ok: false, error: 'unknown_session' });
  res.json(runTool('confirm_booking', { draft_id: draftId }, { db, sessionId, turn: Number.MAX_SAFE_INTEGER, source: 'button' }));
});

// 4) Everything the screen shows: current proposal, stock for its dates, bookings.
app.get('/api/state', (req, res) => {
  const sessionId = req.query.sessionId;
  const draft = sessionId ? currentDraft(db, sessionId) : null;
  if (draft) {
    // Units of this item free on every day of the proposal / booking dates, from the DB.
    // Pending: what is free before booking. Confirmed: what remains after this booking.
    const av = availability(db, draft.equipment_id, draft.start_date, draft.end_date);
    draft.free_for_dates = av.available;
    draft.total_units = av.total;
  }
  // Which dates the stock panel shows, in priority order:
  // 1) the pending proposal, 2) the dates the user last asked about (sent by the
  // browser from the latest availability/proposal tool call — e.g. a request that
  // was unavailable and so created no proposal), 3) the confirmed booking, 4) today.
  const q = { start: String(req.query.start || ''), end: String(req.query.end || '') };
  const qValid = parseDay(q.start) !== null && parseDay(q.end) !== null && q.end >= q.start
    && rentalDays(q.start, q.end) <= MAX_RENTAL_DAYS;
  let start, end, source;
  if (draft?.status === 'pending') ({ start_date: start, end_date: end } = draft), (source = 'proposal');
  else if (qValid) ({ start, end } = q), (source = 'request');
  else if (draft) ({ start_date: start, end_date: end } = draft), (source = 'booking');
  else (start = end = today()), (source = 'today');
  const lastBooking = sessionId
    ? db.prepare(`SELECT id FROM bookings WHERE session_id = ? ORDER BY rowid DESC LIMIT 1`).get(sessionId)
    : null;
  res.json({
    today: today(),
    draft,
    lastBookingId: lastBooking?.id || null,
    stock: { start, end, source, days: rentalDays(start, end), label: humanRange(start, end), items: stockForRange(db, start, end) },
    inventory: listInventory(db),
    db: snapshot(db),
  });
});

// 5) Metrics posted by the browser: per-turn latency, response usage, transcription usage.
app.post('/api/metrics', (req, res) => {
  const { sessionId, kind, payload } = req.body || {};
  const s = sessions.get(sessionId);
  if (!s || !['latency', 'usage', 'transcription_usage', 'session'].includes(kind)) return res.status(400).end();
  const p = { ...payload };
  if (kind === 'usage') p.cost = realtimeResponseCost(p.model || s.model, p.usage);
  if (kind === 'transcription_usage') p.cost = transcriptionCost(config().transcribeModel, p.usage, p.audioSeconds);
  logEvent(db, sessionId, kind, p);
  res.json({ ok: true, cost: p.cost ?? null });
});

app.get('/api/metrics', (req, res) => {
  res.json({ pricingSource: PRICING_SOURCE, ...summarizeMetrics(db, req.query.sessionId || null) });
});

// Demo helper: restore the brief's initial state (inventory + seeded booking).
// Demo helper: restore the brief's initial state. Only runs when the user presses
// "Reset to seed" and confirms; the current database is backed up first.
app.post('/api/reset', guard, async (_req, res) => {
  if (process.env.ALLOW_RESET === 'false') return res.status(403).end();
  const backup = await backupDb(db, DB_FILE);
  seed(db);
  res.json({ ok: true, backup, db: snapshot(db) });
});

const port = Number(process.env.PORT || 3000);
// The UI is plain files in public/. If any is missing the browser shows
// "Cannot GET /", so say exactly what is missing instead.
const UI_FILES = ['index.html', 'styles.css', 'app.js', 'stock-label.js'];
const missingUi = UI_FILES.filter((f) => !fs.existsSync(path.join(__dirname, '..', 'public', f)));

app.listen(port, () => {
  console.log(`RentVoice on http://localhost:${port}  (today=${today()}, model=${config().model})`);
  if (!process.env.APP_TODAY && today() > SEED_BOOKING.end_date) console.warn(`⚠ APP_TODAY is not set and today (${today()}) is after the seeded booking (${SEED_BOOKING.start_date}…${SEED_BOOKING.end_date}): October requests will be refused as past dates. Add APP_TODAY=2026-10-01 to .env (see .env.example).`);
  if (missingUi.length) console.error(`✖ Missing UI files in public/: ${missingUi.join(', ')} — re-extract rentvoice-final.zip into a fresh folder.`);
  if (!process.env.OPENAI_API_KEY) console.warn('⚠ OPENAI_API_KEY missing — voice will not start. Copy .env.example to .env.');
});

