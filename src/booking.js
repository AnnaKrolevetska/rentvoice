// Booking rules. The voice model never decides availability itself: it calls
// these functions (via tools) and only repeats what they return.
import crypto from 'node:crypto';

const DAY_MS = 86_400_000;
export const MAX_RENTAL_DAYS = 30;

// ---------- dates ----------
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function parseDay(s) {
  if (typeof s !== 'string' || !ISO.test(s)) return null;
  const t = Date.parse(s + 'T00:00:00Z');
  if (Number.isNaN(t)) return null;
  // Reject impossible dates such as 2026-02-31 (Date.parse would roll them over).
  return new Date(t).toISOString().slice(0, 10) === s ? t : null;
}

export const fmtDay = (t) => new Date(t).toISOString().slice(0, 10);
export const addDays = (s, n) => fmtDay(parseDay(s) + n * DAY_MS);
export const rentalDays = (start, end) => Math.round((parseDay(end) - parseDay(start)) / DAY_MS) + 1;

// "Today" for the rental desk. APP_TODAY lets the demo run on a fixed date so the
// past-date checks and relative dates ("next weekend") are reproducible (see README).
export function today() {
  const fixed = process.env.APP_TODAY;
  if (fixed && parseDay(fixed)) return fixed;
  // Local date in the desk's time zone.
  return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.APP_TZ || 'Europe/Kyiv' }).format(new Date());
}

export function humanRange(start, end) {
  const f = (s) => new Date(parseDay(s)).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  return start === end ? f(start) : `${f(start)} – ${f(end)}`;
}

// ---------- inventory ----------
export function getItem(db, equipmentId) {
  return db.prepare('SELECT id, name, total_quantity FROM inventory WHERE id = ?').get(equipmentId);
}

export function listInventory(db) {
  return db.prepare('SELECT id, name, total_quantity FROM inventory ORDER BY rowid').all();
}

// Units of `equipmentId` free on EVERY day of [start, end] (both inclusive).
// We take the busiest single day, not the sum of all overlapping bookings:
// two 1-unit bookings on 1–3 Oct and 5–7 Oct never use two units on the same day.
export function availability(db, equipmentId, start, end, { excludeBookingId = null } = {}) {
  const item = getItem(db, equipmentId);
  if (!item) return null;
  // Overlap test for inclusive ranges: a.start <= b.end AND a.end >= b.start
  const rows = db.prepare(
    `SELECT id, quantity, start_date, end_date FROM bookings
     WHERE equipment_id = ? AND status = 'confirmed'
       AND start_date <= ? AND end_date >= ?
       AND (? IS NULL OR id <> ?)`
  ).all(equipmentId, end, start, excludeBookingId, excludeBookingId);

  let peak = 0;
  for (let t = parseDay(start); t <= parseDay(end); t += DAY_MS) {
    const d = fmtDay(t);
    const used = rows.reduce((sum, r) => (r.start_date <= d && r.end_date >= d ? sum + r.quantity : sum), 0);
    peak = Math.max(peak, used);
  }
  return {
    equipment_id: item.id,
    name: item.name,
    total: item.total_quantity,
    booked: peak,
    available: Math.max(0, item.total_quantity - peak),
    overlapping_bookings: rows.map((r) => ({ id: r.id, quantity: r.quantity, start_date: r.start_date, end_date: r.end_date })),
  };
}

// Stock overview for the UI: free units of every item for one date range.
export function stockForRange(db, start, end) {
  return listInventory(db).map((i) => availability(db, i.id, start, end));
}

// ---------- validation ----------
export function validateRequest(db, req) {
  const errors = [];
  const item = getItem(db, req.equipment_id);
  if (!item) errors.push({ code: 'unknown_equipment', message: `Unknown equipment "${req.equipment_id}". We rent Camera A, Tripod B and Microphone C.` });

  const q = req.quantity;
  if (!Number.isInteger(q) || q < 1) errors.push({ code: 'bad_quantity', message: 'Quantity must be a whole number of at least 1.' });
  else if (item && q > item.total_quantity) errors.push({ code: 'exceeds_total_stock', message: `We only own ${item.total_quantity} ${item.name} in total.` });

  const s = parseDay(req.start_date), e = parseDay(req.end_date);
  if (s === null) errors.push({ code: 'bad_start_date', message: 'Start date is missing or not a real date (YYYY-MM-DD).' });
  if (e === null) errors.push({ code: 'bad_end_date', message: 'End date is missing or not a real date (YYYY-MM-DD).' });
  if (s !== null && e !== null) {
    if (e < s) errors.push({ code: 'end_before_start', message: 'The return date is before the pickup date.' });
    else if (rentalDays(req.start_date, req.end_date) > MAX_RENTAL_DAYS) errors.push({ code: 'too_long', message: `Rentals are limited to ${MAX_RENTAL_DAYS} days.` });
    if (req.start_date < today()) errors.push({ code: 'start_in_past', message: `The pickup date is in the past (today is ${today()}).` });
  }
  return errors;
}

// Alternatives when a request does not fit: what fits on the same dates,
// and the nearest window of the same length (within 60 days) with enough units.
export function suggestAlternatives(db, req) {
  const out = {};
  const av = availability(db, req.equipment_id, req.start_date, req.end_date);
  if (av && av.available > 0) out.same_dates_max_quantity = av.available;
  const len = rentalDays(req.start_date, req.end_date);
  for (let shift = 1; shift <= 60; shift++) {
    for (const dir of [1, -1]) {
      const s = addDays(req.start_date, dir * shift);
      if (s < today()) continue;
      const e = addDays(s, len - 1);
      const a = availability(db, req.equipment_id, s, e);
      if (a.available >= req.quantity) {
        out.nearest_dates_for_full_quantity = { start_date: s, end_date: e, human: humanRange(s, e) };
        return out;
      }
    }
  }
  return out;
}

// ---------- tools ----------
const newId = (prefix) => `${prefix}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

function draftView(db, d) {
  const item = getItem(db, d.equipment_id);
  return {
    draft_id: d.id,
    equipment_id: d.equipment_id,
    equipment: item.name,
    quantity: d.quantity,
    start_date: d.start_date,
    end_date: d.end_date,
    dates_human: humanRange(d.start_date, d.end_date),
    rental_days: rentalDays(d.start_date, d.end_date),
    status: d.status,
    booking_id: d.booking_id ?? null,
  };
}

export function currentDraft(db, sessionId) {
  const d = db.prepare(
    `SELECT * FROM drafts WHERE session_id = ? AND status IN ('pending','confirmed')
     ORDER BY created_at DESC, rowid DESC LIMIT 1`
  ).get(sessionId);
  return d ? draftView(db, d) : null;
}

/** Read-only check. Never writes. */
export function checkAvailability(db, req) {
  const errors = validateRequest(db, req);
  if (errors.length) return { ok: false, errors };
  const av = availability(db, req.equipment_id, req.start_date, req.end_date);
  const fits = av.available >= req.quantity;
  return {
    ok: true,
    available: fits,
    requested_quantity: req.quantity,
    free_units: av.available,
    total_units: av.total,
    equipment: av.name,
    dates_human: humanRange(req.start_date, req.end_date),
    rental_days: rentalDays(req.start_date, req.end_date),
    ...(fits ? {} : { alternatives: suggestAlternatives(db, req) }),
  };
}

/**
 * Create the ONE proposal the user may confirm. Any earlier pending proposal
 * in this conversation is superseded, so a correction can never leave an
 * obsolete choice confirmable. An unavailable request creates no proposal.
 */
export function prepareBooking(db, sessionId, turn, req) {
  return db.transaction(() => {
    // Whatever happens, the previous pending proposal is now obsolete.
    const superseded = db.prepare(
      `UPDATE drafts SET status = 'superseded' WHERE session_id = ? AND status = 'pending'`
    ).run(sessionId).changes;

    const check = checkAvailability(db, req);
    if (!check.ok || !check.available) return { ...check, draft_created: false, superseded_previous: superseded > 0 };

    const id = newId('DR');
    db.prepare(
      `INSERT INTO drafts (id, session_id, equipment_id, quantity, start_date, end_date, status, created_turn)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
    ).run(id, sessionId, req.equipment_id, req.quantity, req.start_date, req.end_date, turn);
    const d = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id);
    return {
      ok: true,
      available: true,
      draft_created: true,
      superseded_previous: superseded > 0,
      draft: draftView(db, d),
      next_step: 'Read this summary to the user and ask for an explicit yes. Do not call confirm_booking in this same turn.',
    };
  }).immediate();
}

/**
 * Turn a pending proposal into a booking. Idempotent: confirming the same
 * draft again returns the existing booking instead of inserting a second row.
 *
 * source = 'voice'  → the user must have spoken AFTER the proposal was made
 *                      (turn > created_turn), so the model cannot confirm on
 *                      its own in the same breath as proposing.
 * source = 'button' → the user clicked Confirm in the UI.
 */
export function confirmBooking(db, sessionId, draftId, turn, source = 'voice') {
  return db.transaction(() => {
    const d = db.prepare('SELECT * FROM drafts WHERE id = ? AND session_id = ?').get(draftId, sessionId);
    if (!d) return { ok: false, error: 'draft_not_found', message: 'There is no such booking proposal in this conversation.' };

    if (d.status === 'confirmed') {
      const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(d.booking_id);
      return { ok: true, duplicate: true, message: 'This booking was already confirmed earlier; nothing new was saved.', booking: bookingView(db, b) };
    }
    if (d.status === 'superseded') return { ok: false, error: 'superseded', message: 'This proposal was replaced by a newer request. Confirm the latest proposal instead.' };
    if (d.status === 'cancelled') return { ok: false, error: 'cancelled', message: 'This proposal was cancelled.' };
    if (d.status === 'rejected') return { ok: false, error: 'rejected', message: 'This proposal is no longer available.' };

    if (source === 'voice' && !(turn > d.created_turn)) {
      return { ok: false, error: 'needs_user_confirmation', message: 'The user has not answered the summary yet. Ask them to confirm first.' };
    }

    // Re-check right before writing: stock may have changed since the proposal.
    const av = availability(db, d.equipment_id, d.start_date, d.end_date);
    if (av.available < d.quantity) {
      db.prepare(`UPDATE drafts SET status = 'rejected' WHERE id = ?`).run(d.id);
      return {
        ok: false, error: 'no_longer_available', free_units: av.available,
        message: `Only ${av.available} ${av.name} left for those dates now, so nothing was booked.`,
        alternatives: suggestAlternatives(db, d),
      };
    }

    const bookingId = newId('BK');
    db.prepare(
      `INSERT INTO bookings (id, equipment_id, quantity, start_date, end_date, status, source_draft_id, session_id)
       VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?)`
    ).run(bookingId, d.equipment_id, d.quantity, d.start_date, d.end_date, d.id, sessionId);
    db.prepare(`UPDATE drafts SET status = 'confirmed', booking_id = ? WHERE id = ?`).run(bookingId, d.id);

    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
    const after = availability(db, d.equipment_id, d.start_date, d.end_date);
    return { ok: true, duplicate: false, booking: bookingView(db, b), remaining_for_these_dates: after.available };
  }).immediate();
}

/**
 * Drops the current UNCONFIRMED proposal only. Confirmed bookings are never
 * touched (cancelling them is outside the prototype's scope), and the result
 * says so explicitly so the assistant cannot claim otherwise.
 */
export function cancelPending(db, sessionId) {
  const n = db.prepare(`UPDATE drafts SET status = 'cancelled' WHERE session_id = ? AND status = 'pending'`).run(sessionId).changes;
  if (n > 0) {
    return { ok: true, cancelled: n, scope: 'unconfirmed_proposal_only', message: 'The unconfirmed proposal was dropped. Nothing had been booked, and no confirmed booking was changed.' };
  }
  const confirmed = db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE session_id = ?`).get(sessionId).n;
  return {
    ok: false, cancelled: 0, error: 'nothing_pending',
    message: confirmed
      ? 'There is no unconfirmed proposal. Confirmed bookings cannot be cancelled in this prototype; nothing was changed.'
      : 'There is no proposal to cancel; nothing was changed.',
  };
}

export function bookingView(db, b) {
  const item = getItem(db, b.equipment_id);
  return {
    booking_id: b.id, equipment_id: b.equipment_id, equipment: item.name, quantity: b.quantity,
    start_date: b.start_date, end_date: b.end_date, dates_human: humanRange(b.start_date, b.end_date),
    rental_days: rentalDays(b.start_date, b.end_date), status: b.status, created_at: b.created_at,
  };
}

// Full DB state for "before / after" evidence.
export function snapshot(db) {
  return {
    inventory: listInventory(db),
    bookings: db.prepare('SELECT id, equipment_id, quantity, start_date, end_date, status, source_draft_id, created_at FROM bookings ORDER BY created_at, rowid').all(),
    booking_count: db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n,
  };
}
