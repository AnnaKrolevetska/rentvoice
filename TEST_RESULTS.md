# Test results

- **Part A** was run when this package was built: a clean extraction of
  `rentvoice-final.zip`, `npm install`, `npm test`, `npm start`, and browser checks.
- **Part B** needs your OpenAI key and microphone. It is a template; fill it in only with
  what you observed. Do not mark a voice check as passed without running it.

## Part A — automated and integration checks (run 2 Nov 2026, 00:48 Kyiv time)

Environment: Linux, Node.js 22.23.4, headless Chrome 1440 px and 390 px.
Desk date `APP_TODAY=2026-10-01`. Seed: BK-SEED-001, Camera A × 1, 10–12 Oct 2026.

### 1. Clean install from the ZIP

| Step | Result |
|---|---|
| Unzip `rentvoice-final.zip` into an empty folder | creates `rentvoice-v2/` with 35 files; no `.env`, database, `node_modules` or API key inside |
| `npm install` | `found 0 vulnerabilities`, no compiler needed |
| `npm test` | **34 tests, 34 pass, 0 fail**, 0 cancelled, 0 skipped |

`npm test`, by file:

| File | Checks |
|---|---|
| `test/scenarios.test.js` | S1 Normal booking · S2 Corrected dates · S3 Insufficient stock · S4 Interruption · S5 Repeated confirmation · X1 confirm in the same turn as the proposal is refused · X2/X3 seed boundary days · X4 invalid input · X5 dropping an unconfirmed proposal · X6 cancelling a confirmed booking is out of scope · inclusive day count · busiest-day availability · idempotency key · whole-period availability |
| `test/agent-instructions.test.js` | short greeting with no product list · greeting wiring · no catalog recital / never invent inventory · no redundant questions · concise style · interruptions keep known details · booking-safety rules present · cancellation rules · tools and session unchanged |
| `test/db-safety.test.js` | seed = Camera A 10–12 Oct 2026 · reopening a database keeps its bookings · reset writes a backup that still holds removed bookings · no backup for in-memory test DBs |
| `test/stock-label.test.js` | availability heading: today / one day / several days / across months and years / never "undefined" |

`npm run evidence` → `evidence/logic-checks.md`: 11/11 scenarios pass, with every tool
call and the bookings table before and after each scenario.

### 2. Moving into a new folder with existing data (simulated Mac)

An "old" `rentvoice/` folder had a `.env` and a database with a personal booking
(Camera A, 15–17 Oct). The commands from `START_HERE_MAC.md` were followed exactly.

| Step | Result |
|---|---|
| `cp …/rentvoice/.env …/rentvoice-v2/.env`; `cp …/rentvoice/data/rentvoice.db* …/rentvoice-v2/data/` | copied |
| `npm run db:snapshot` | 2 rows: BK-SEED-001 (10–12 Oct) and the personal booking (15–17 Oct) |
| `npm start` | `RentVoice on http://localhost:3000 (today=2026-10-01, model=gpt-realtime-2.1-mini)`, no warnings |
| `GET /`, `/styles.css`, `/app.js`, `/stock-label.js`, `/api/config` | all 200, correct content types; `database: rentvoice.db` |
| After a full conversation in the browser | personal booking still present; nothing reset |

### 3. Browser conversation

The page, server and database were real. Only the WebRTC link to OpenAI was replaced
by a stand-in that feeds the page the same events OpenAI sends.

| Check | Result |
|---|---|
| Performance & diagnostics | collapsed by default |
| Greeting sent to the model | `Say exactly this and nothing else: "Hi! Welcome to RentVoice. What would you like to rent today?"` |
| Reply while it is playing | marked "speaking" |
| Proposal (Camera A × 1, 15–17 Oct) | "Not booked yet" · "Proposal only — nothing is saved until you confirm" · 3 days, both dates included · available for these dates **1 of 2** (the personal booking holds the other) |
| User cuts in mid-reply | reply marked "Interrupted — not said in full"; client sent `response.cancel` |
| "Yes, confirm" | "Confirmed", ID BK-AA658B · remaining for these dates **0 of 2** |
| Copy booking ID | clipboard `BK-AA658B` (same row in `npm run db:snapshot`); button shows "Copied!"; screen reader hears "Booking ID copied to clipboard" |
| Copy transcript | 4 lines, "You"/"Assistant" labels, interrupted line tagged `[interrupted]` |
| Page text / JS errors | no "undefined", "NaN" or "[object"; no JavaScript errors |
| Mobile (390 px) | no horizontal scrolling |

### 4. Test database and resets

| Step | Result |
|---|---|
| `npm run test-db:reset` | backup `data/backups/test-run-…db`; `test-run.db` → 1 row (seed) |
| `npm run start:test-db` | server uses `test-run.db` (shown under the bookings table) |
| **Reset to seed** button (on the test DB) | backup written first; 1 row afterwards |
| `npm run db:snapshot` (personal DB) | unchanged, 3 rows |
| `npm run reset-db` without `--yes` | refuses (exit 1); personal DB unchanged |

### Not verified here (needs your machine)

- Real voice conversations with OpenAI Realtime: speech, pauses, interruptions.
- Whether the model follows the conversational rules: no re-asking, brief catalog answers,
  cancellation wording.
- Real latency and cost numbers.
- `npm run voice-eval` (calls OpenAI; costs a few cents).

---

## Part B — voice tests (fill in after running)

Record with the separate test database (`npm run test-db:reset`, then
`npm run start:test-db`). Scripts, recording steps and pass/fail criteria:
`TEST_SCENARIOS.md`.

| ID | What you say | Expected | Actual (what happened) | DB before → after | Result |
|---|---|---|---|---|---|
| S1 | "I need one Camera A from November fifth to November sixth." → "Yes, please confirm." | 1 booking, Camera A ×1, 5–6 Nov; no re-asking | ⟨⟩ | 1 → ⟨⟩ rows | ⟨PASS/FAIL⟩ |
| S2 | "One Tripod B from November fifth to seventh." → "Sorry, I meant November eighth to ninth." → "Yes." | Only 8–9 Nov saved | ⟨⟩ | 1 → ⟨⟩ | ⟨⟩ |
| S3 | "Two Camera A units from October eleventh to twelfth." → "No thanks." | Says only 1 free; offers 1 unit or 13–14 Oct; nothing saved | ⟨⟩ | 1 → ⟨⟩ | ⟨⟩ |
| S4 | "A camera from November tenth to eleventh." → cut in: "Actually, I need a tripod instead." → "Yes." | Assistant stops at once; only a tripod booking | ⟨⟩ | 1 → ⟨⟩ | ⟨⟩ |
| S5 | "Book one Camera A for November fifth to sixth." → "Yes, confirm." → "Yes, confirm the booking." | One row; second yes → "already booked" | ⟨⟩ | 1 → ⟨⟩ | ⟨⟩ |
| A1 | "I need a camera for next weekend." | States exact dates or asks; nothing saved | ⟨⟩ | 1 → ⟨⟩ | ⟨⟩ |
| A2 | "Can I rent a drone for tomorrow?" | Not stocked; offers what exists; nothing saved | ⟨⟩ | 1 → ⟨⟩ | ⟨⟩ |
| C1 | "What equipment do you have?" | Brief overview, nothing invented, then asks what you need; nothing saved | ⟨⟩ | 1 → ⟨⟩ | ⟨⟩ |
| P1 | "One tripod from November twelfth… [pause 1.5 s] …to November fourteenth." → "Yes." | No answer during the pause; 12–14 Nov booked | ⟨⟩ | 1 → ⟨⟩ | ⟨⟩ |
| X6 | After a booking: "Please cancel my booking." | "Not supported here, nothing was changed"; booking stays | ⟨⟩ | ⟨⟩ → same | ⟨⟩ |

### Latency (Performance & diagnostics, or `evidence/voice-eval-*.md`)

| Metric | Median | p90 | n | Where measured |
|---|---|---|---|---|
| End of your speech → first audible reply | ⟨⟩ ms | ⟨⟩ ms | ⟨⟩ | Browser, ⟨Mac model, Wi-Fi/wired⟩ |
| End of your speech → answer after a stock check | ⟨⟩ ms | ⟨⟩ ms | ⟨⟩ | Browser |
| Same, voice eval (network, no playback) | ⟨⟩ ms | ⟨⟩ ms | ⟨⟩ | `npm run voice-eval` |

### Cost (estimates at list prices; see README → Measurement methodology)

| Metric | Value |
|---|---|
| Model | ⟨gpt-realtime-2.1-mini⟩ |
| Estimated cost per conversation minute | ⟨$⟩ |
| Estimated cost per confirmed booking (whole conversation) | ⟨$⟩ |
| Actual spend on testing (OpenAI usage page) | ⟨$⟩ |
| Hosting (separate, fixed) | ⟨$0 local / $… per month⟩ |

### What failed

⟨Anything that did not behave as expected, with the transcript line that shows it.⟩
