// The five required checks at the booking-logic level (no audio, no model).
// Each scenario replays the tool calls the agent makes in that conversation,
// with the user-turn counter the browser sends, and records the DB before/after.
// Expected outcomes are written here BEFORE running (field `expected`).
//
// Step format: [userTurn, toolName, args, source?]
// In args, draft_id '$draft' = the latest proposal so far, '$draft0' = the first one.
import { openDb, seed } from '../src/db.js';
import { runTool } from '../src/agent.js';
import { snapshot } from '../src/booking.js';

const newRows = (before, after) => after.bookings.filter((b) => !before.bookings.some((x) => x.id === b.id));

export const SCENARIOS = [
  {
    id: 'S1',
    title: 'Normal booking',
    utterances: ['I need one Camera A from November 5 to November 6.', 'Yes, confirm the booking.'],
    expected: 'A proposal for 1 × Camera A, 5–6 Nov; after "yes" exactly one new booking row; Camera A free units for 5–6 Nov go 2 → 1.',
    steps: [
      [1, 'prepare_booking', { equipment_id: 'camera_a', quantity: 1, start_date: '2026-11-05', end_date: '2026-11-06' }],
      [2, 'confirm_booking', { draft_id: '$draft' }],
    ],
    check(before, after, r) {
      const c = r[1];
      return after.booking_count === before.booking_count + 1 && c.ok && !c.duplicate
        && c.booking.start_date === '2026-11-05' && c.booking.end_date === '2026-11-06'
        && c.remaining_for_these_dates === 1;
    },
  },
  {
    id: 'S2',
    title: 'Corrected dates',
    utterances: ['I need a Tripod B for November 5 to November 7.', 'Sorry, I meant November 8 to November 9.', 'Yes, confirm.'],
    expected: 'The 5–7 Nov proposal is superseded by the correction and can no longer be confirmed; exactly one booking, for 8–9 Nov.',
    steps: [
      [1, 'prepare_booking', { equipment_id: 'tripod_b', quantity: 1, start_date: '2026-11-05', end_date: '2026-11-07' }],
      [2, 'prepare_booking', { equipment_id: 'tripod_b', quantity: 1, start_date: '2026-11-08', end_date: '2026-11-09' }],
      [3, 'confirm_booking', { draft_id: '$draft0' }], // stale call with the OLD proposal
      [3, 'confirm_booking', { draft_id: '$draft' }],
    ],
    check(before, after, r) {
      const rows = newRows(before, after);
      return r[1].superseded_previous === true && r[2].ok === false && r[2].error === 'superseded'
        && rows.length === 1 && rows[0].start_date === '2026-11-08' && rows[0].end_date === '2026-11-09';
    },
  },
  {
    id: 'S3',
    title: 'Insufficient stock',
    utterances: ['I need two Camera A units for October 11 to October 12.'],
    expected: 'Only 1 of 2 cameras is free on 11–12 Oct (seed booking 10–12 Oct). No proposal, no booking; alternatives: 1 unit on the same dates, or 2 units on 13–14 Oct.',
    steps: [
      [1, 'prepare_booking', { equipment_id: 'camera_a', quantity: 2, start_date: '2026-10-11', end_date: '2026-10-12' }],
      [2, 'confirm_booking', { draft_id: '$draft' }], // model tries to confirm anyway
    ],
    check(before, after, r) {
      const p = r[0];
      return after.booking_count === before.booking_count
        && p.available === false && p.draft_created === false && p.free_units === 1
        && p.alternatives.same_dates_max_quantity === 1
        && p.alternatives.nearest_dates_for_full_quantity?.start_date === '2026-10-13'
        && r[1].ok === false;
    },
  },
  {
    id: 'S4',
    title: 'Interruption',
    utterances: ['I need a camera for November 10 to 11.', '(while the agent reads the camera summary) "Actually, I need a tripod."', 'Yes.'],
    expected: 'Camera proposal is superseded when the agent re-plans for the tripod; a stale confirm of the camera fails; the only new booking is the tripod. (Cutting off the audio is checked in the voice eval.)',
    steps: [
      [1, 'prepare_booking', { equipment_id: 'camera_a', quantity: 1, start_date: '2026-11-10', end_date: '2026-11-11' }],
      [2, 'prepare_booking', { equipment_id: 'tripod_b', quantity: 1, start_date: '2026-11-10', end_date: '2026-11-11' }],
      [3, 'confirm_booking', { draft_id: '$draft0' }],
      [3, 'confirm_booking', { draft_id: '$draft' }],
    ],
    check(before, after, r) {
      const rows = newRows(before, after);
      return r[2].ok === false && rows.length === 1 && rows[0].equipment_id === 'tripod_b';
    },
  },
  {
    id: 'S5',
    title: 'Repeated confirmation',
    utterances: ['I need one Camera A for November 5 to 6.', 'Yes, confirm.', 'Yes, confirm. (again — and the Confirm button is clicked too)'],
    expected: 'First confirm creates one booking; a second voice confirm and a button click return the same booking ID with duplicate=true; row count grows by exactly 1.',
    steps: [
      [1, 'prepare_booking', { equipment_id: 'camera_a', quantity: 1, start_date: '2026-11-05', end_date: '2026-11-06' }],
      [2, 'confirm_booking', { draft_id: '$draft' }],
      [3, 'confirm_booking', { draft_id: '$draft' }],
      [3, 'confirm_booking', { draft_id: '$draft' }, 'button'],
    ],
    check(before, after, r) {
      const [, a, b, c] = r;
      return after.booking_count === before.booking_count + 1
        && a.ok && !a.duplicate && b.duplicate && c.duplicate
        && a.booking.booking_id === b.booking.booking_id && b.booking.booking_id === c.booking.booking_id;
    },
  },
  // Extra guard rails beyond the five required checks.
  {
    id: 'X1',
    title: 'Model tries to confirm in the same turn it proposed',
    utterances: ['I need the microphone on November 20.'],
    expected: 'confirm_booking in the same user turn as prepare_booking is refused (needs_user_confirmation); no booking.',
    steps: [
      [1, 'prepare_booking', { equipment_id: 'microphone_c', quantity: 1, start_date: '2026-11-20', end_date: '2026-11-20' }],
      [1, 'confirm_booking', { draft_id: '$draft' }],
    ],
    check(before, after, r) {
      return r[1].ok === false && r[1].error === 'needs_user_confirmation' && after.booking_count === before.booking_count;
    },
  },
  {
    id: 'X2',
    title: 'Boundary: booking that starts the day after the seed ends',
    utterances: ['Two Camera A for October 13 to 14.', 'Yes.'],
    expected: 'Seed ends 12 Oct inclusive, so 13–14 Oct has 2 free; booking succeeds.',
    steps: [
      [1, 'prepare_booking', { equipment_id: 'camera_a', quantity: 2, start_date: '2026-10-13', end_date: '2026-10-14' }],
      [2, 'confirm_booking', { draft_id: '$draft' }],
    ],
    check(before, after, r) { return r[0].draft_created && r[1].ok && after.booking_count === before.booking_count + 1; },
  },
  {
    id: 'X3',
    title: 'Boundary: request that starts on the seed\'s last day',
    utterances: ['Two Camera A for October 12 to 13.'],
    expected: '12 Oct overlaps the seed (inclusive end), so only 1 free; refused.',
    steps: [
      [1, 'prepare_booking', { equipment_id: 'camera_a', quantity: 2, start_date: '2026-10-12', end_date: '2026-10-13' }],
    ],
    check(before, after, r) { return r[0].available === false && r[0].free_units === 1 && after.booking_count === before.booking_count; },
  },
  {
    id: 'X5',
    title: 'Dropping an unconfirmed proposal',
    utterances: ['A tripod for November 20.', 'Actually, cancel that.', '(stale) Yes.'],
    expected: 'cancel_pending drops the proposal (nothing was booked); a later confirm of that proposal fails; no booking row is added.',
    steps: [
      [1, 'prepare_booking', { equipment_id: 'tripod_b', quantity: 1, start_date: '2026-11-20', end_date: '2026-11-20' }],
      [2, 'cancel_pending', {}],
      [3, 'confirm_booking', { draft_id: '$draft' }],
    ],
    check(before, after, r) {
      return r[1].ok === true && r[1].scope === 'unconfirmed_proposal_only'
        && r[2].ok === false && r[2].error === 'cancelled' && after.booking_count === before.booking_count;
    },
  },
  {
    id: 'X6',
    title: 'Cancelling a confirmed booking is out of scope',
    utterances: ['One microphone for November 21.', 'Yes.', 'Please cancel my booking.'],
    expected: 'The booking is saved; cancel_pending afterwards returns ok:false (nothing_pending) with a message that confirmed bookings cannot be cancelled; the booking row stays.',
    steps: [
      [1, 'prepare_booking', { equipment_id: 'microphone_c', quantity: 1, start_date: '2026-11-21', end_date: '2026-11-21' }],
      [2, 'confirm_booking', { draft_id: '$draft' }],
      [3, 'cancel_pending', {}],
    ],
    check(before, after, r) {
      return r[1].ok && r[2].ok === false && r[2].error === 'nothing_pending' && /cannot be cancelled/.test(r[2].message)
        && after.booking_count === before.booking_count + 1
        && after.bookings.some((b) => b.id === r[1].booking.booking_id && b.status === 'confirmed');
    },
  },
  {
    id: 'X4',
    title: 'Invalid input: unknown item, past date, return before pickup',
    utterances: ['A drone for tomorrow.', 'A tripod from September 1 to 2.', 'A tripod from November 9 to November 8.'],
    expected: 'All three rejected by validation with a reason the agent can say; no proposal, no booking.',
    steps: [
      [1, 'prepare_booking', { equipment_id: 'drone', quantity: 1, start_date: '2026-10-02', end_date: '2026-10-02' }],
      [2, 'prepare_booking', { equipment_id: 'tripod_b', quantity: 1, start_date: '2026-09-01', end_date: '2026-09-02' }],
      [3, 'prepare_booking', { equipment_id: 'tripod_b', quantity: 1, start_date: '2026-11-09', end_date: '2026-11-08' }],
    ],
    check(before, after, r) {
      const codes = r.map((x) => (x.errors || []).map((e) => e.code));
      return codes[0].includes('unknown_equipment') && codes[1].includes('start_in_past') && codes[2].includes('end_before_start')
        && after.booking_count === before.booking_count;
    },
  },
];

export function runScenario(sc) {
  const db = openDb(':memory:');
  seed(db);
  const sessionId = sc.id.toLowerCase();
  const draftIds = () => db.prepare('SELECT id FROM drafts WHERE session_id = ? ORDER BY rowid').all(sessionId).map((r) => r.id);
  const resolve = (args) => {
    if (args?.draft_id === '$draft') return { draft_id: draftIds().at(-1) ?? 'none' };
    if (args?.draft_id === '$draft0') return { draft_id: draftIds()[0] ?? 'none' };
    return args;
  };
  const before = snapshot(db);
  const steps = sc.steps.map(([turn, name, args, source = 'voice']) => {
    const a = resolve(args);
    return { turn, name, args: a, source, result: runTool(name, a, { db, sessionId, turn, source }) };
  });
  const after = snapshot(db);
  return { ...sc, before, after, steps, pass: !!sc.check(before, after, steps.map((s) => s.result)) };
}
