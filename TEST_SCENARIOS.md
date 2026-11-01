# Test scenarios — the five required checks

The brief asks for recorded checks of a normal booking, corrected dates, insufficient
stock, an interruption and a repeated confirmation, with the database state before and
after. This sheet gives, for each one:
- the spoken script;
- the expected outcome (written before testing);
- how to record the actual outcome;
- the database before and after;
- pass/fail criteria.

**Do not write an outcome you did not observe.** Put actual results in `TEST_RESULTS.md`
(Part B) and `DELIVERY_NOTES.md`.

The same five conversations also run automatically at the logic level, without the voice
model: `npm test` (S1–S5) and `npm run evidence`, which writes `evidence/logic-checks.md`.
These are the reproducible baseline. The steps below record the real voice behaviour on
top of it.

## Setup (once per recording session)

Use the separate test database so your own bookings are never touched:

```bash
npm run test-db:reset        # test-run.db = seed only (backup made first)
npm run start:test-db        # app on data/test-run.db
```

Open http://localhost:3000. The bookings table should say **Database file:
test-run.db** and show one row: BK-SEED-001, Camera A, 10–12 Oct. Use headphones.

**Before each scenario:**
1. Press Ctrl+C in the server window.
2. Run `npm run test-db:reset`, then `npm run test-db:snapshot`. This is the "before"
   state; screenshot or copy it.
3. Run `npm run start:test-db`.
4. Reload the page and press the microphone button.

**After each scenario:**
1. Click **Copy transcript** and paste it into your notes.
2. Screenshot the Booking details panel and the Bookings table.
3. Open a second Terminal window, `cd` to the project, and run `npm run test-db:snapshot`.
   This is the "after" state.

Screen recording on a Mac: press Cmd+Shift+5 and choose Options → Microphone. macOS
does not record the assistant's audio from headphones; the on-screen transcript shows
what it said.

Seed state ("before" for every scenario): **1 row**, BK-SEED-001 · camera_a × 1 ·
2026-10-10 → 2026-10-12.

---

## S1 — Normal booking

**Say:**
1. "Hi, I need one Camera A from November fifth to November sixth."
2. After the summary: "Yes, please confirm."

**Expected:**
- The assistant does not re-ask for item, quantity or dates.
- It reads back one Camera A, 5–6 Nov, 2 days, and asks to confirm.
- Booking details shows "Not booked yet" until you say yes, then "Confirmed" with a booking ID.

**DB after:** 2 rows: the seed plus one new row, camera_a × 1, 2026-11-05 → 2026-11-06.

**Pass if:**
- exactly one new row, with these values;
- the ID in the panel equals the ID in the snapshot;
- no row was created before your "yes".

**Fail if:** a row appears before "yes", there is more than one new row, or any value differs.

## S2 — Corrected dates

**Say:**
1. "I'd like one Tripod B from November fifth to November seventh."
2. Before confirming: "Sorry, I meant November eighth to November ninth."
3. "Yes, confirm it."

**Expected:**
- The panel switches to 8–9 Nov, 2 days.
- The 5–7 Nov proposal is never offered again.
- One booking is saved, for 8–9 Nov.

**DB after:** 2 rows: the seed plus tripod_b × 1, 2026-11-08 → 2026-11-09.

**Pass if:** exactly one new row, with the corrected dates.

**Fail if:** any row has 5–7 Nov, or there are two new rows.

## S3 — Insufficient stock

**Say:**
1. "I need two Camera A units from October eleventh to October twelfth."
2. After the reply: "No thanks, that's all for now."

**Expected:**
- The assistant says only one camera is free on those dates; the seed holds the other.
- It offers one camera on the same dates, or two cameras on 13–14 Oct.
- Nothing is booked.
- The Camera A card shows "You asked for 2 · only 1 available".

**DB after:** 1 row (unchanged).

**Pass if:** the row count is unchanged and the assistant never says the booking was made.

**Fail if:** any new row appears, or the assistant claims the two cameras were booked.

## S4 — Interruption

**Say:**
1. "I need a camera from November tenth to November eleventh."
2. While the assistant is reading the camera summary, cut in: "Actually, I need a tripod
   instead."
3. After the new summary: "Yes, confirm."

**Expected:**
- The assistant stops speaking at once; its message is marked "Interrupted — not said in full".
- It proposes one Tripod B for 10–11 Nov, keeping the dates you already gave.
- Only the tripod is booked.

**DB after:** 2 rows: the seed plus tripod_b × 1, 2026-11-10 → 2026-11-11.

**Pass if:**
- the audio stops within about a second;
- the transcript shows the interrupted message;
- exactly one new row, for the tripod;
- no camera row.

**Fail if:** the assistant keeps talking over you, or a Camera A row for 10–11 Nov appears.

## S5 — Repeated confirmation

**Say:**
1. "Book one Camera A for November fifth to November sixth."
2. "Yes, confirm."
3. "Yes, confirm the booking."
4. Optionally, click **Confirm booking** if it is still visible. The button disappears
   after confirmation, so a second voice "yes" is the main check.

**Expected:**
- The first yes saves the booking.
- The second yes gets "it's already booked"; nothing new is created.
- In "What the assistant checked" the second confirm shows `"duplicate":true` with the same booking ID.

**DB after:** 2 rows: the seed plus camera_a × 1, 2026-11-05 → 2026-11-06.

**Pass if:** exactly one new row after two confirmations.

**Fail if:** two new rows.

---

## Extra checks (recommended, not required by the brief)

| ID | Say | Expected | DB after |
|---|---|---|---|
| A1 ambiguity | "I need a camera for next weekend." | States the exact dates it understood (10–11 Oct) or asks; books nothing yet | unchanged |
| A2 decline | "Can I rent a drone for tomorrow?" | Says drones aren't available; offers what exists | unchanged |
| C1 catalog | "What equipment do you have?" | Brief overview from the real inventory, nothing invented, asks what you need | unchanged |
| P1 pause | "One tripod from November twelfth… [pause 1.5 s] …to November fourteenth." → "Yes." | No reply during the pause; books 12–14 Nov (3 days) | +1 row |
| X6 cancel confirmed | After a confirmed booking: "Please cancel my booking." | Says cancelling confirmed bookings isn't supported here and nothing was changed | booking row still there |

The automated equivalents of S1–S5, X5 and X6 (cancellation scope) run in `npm test`.
`npm run voice-eval` replays S1–S5, A1, A2, C1 and P1 with synthesized speech and writes
the DB before/after, latency and cost to `evidence/voice-eval-*.md`.
