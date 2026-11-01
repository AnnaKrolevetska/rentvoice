# RentVoice — voice booking agent for an equipment rental desk

A browser voice agent for a small rental desk. You talk to it; it checks the real
test inventory in SQLite, reads back a summary, and saves **exactly one** booking
only after you say yes. Corrections, interruptions, pauses and repeated "yes" are
handled without saving obsolete or duplicate bookings.

- Inventory: Camera A × 2, Tripod B × 3, Microphone C × 1.
- Seed: one Camera A booking, **10–12 Oct 2026 inclusive**, as specified in the brief.
- One language (English), day-based rentals, one conversation at a time.

Related documents:

| File | What it is |
|---|---|
| `START_HERE_MAC.md` | Step-by-step setup on a Mac, in Ukrainian |
| `TEST_SCENARIOS.md` | The five required scenarios: script, expected result, recording steps, DB before/after, pass/fail criteria |
| `TEST_RESULTS.md` | Automated results from the build, plus a template for your voice results |
| `DELIVERY_NOTES.md` | Submission notes: tradeoffs, pricing assumptions, AI tools, limitations, time spent |
| `VIDEO_SCRIPT.md` | Three-minute walkthrough plan |

## Quick start

Requires Node.js 20.12+ (22 LTS recommended), Chrome or Edge, a microphone, and an
OpenAI API key with Realtime access.

```bash
npm install
cp .env.example .env        # then put your key in OPENAI_API_KEY
npm test                    # 34 checks, no API key needed
npm start                   # http://localhost:3000
```

Open http://localhost:3000, press the microphone button, allow the microphone, and
say: "I need one Camera A from October 15 to October 17."

- `npm install` needs no compiler: `.npmrc` sets `ignore-scripts=true`, because
  better-sqlite3 already ships ready-made binaries for macOS, Linux and Windows.
- The browser allows the microphone only on `localhost` or HTTPS.
- Use headphones; with speakers, the assistant's own voice can leak into the
  microphone and count as an interruption.

### Desk date

The brief seeds a booking for **10–12 Oct 2026**, and the desk refuses bookings that
start in the past, as a real desk would. `.env.example` therefore sets
**`APP_TODAY=2026-10-01`**, so October 2026 is still in the future and every scenario
is reproducible on any day. "Next weekend" is also resolved from that date. Keep this
line in `.env`; if it is missing and the real date is after the seed, the server prints
a warning at startup.

## Your data, test data and resets

Nothing resets or overwrites bookings automatically. On startup, an existing
database is opened as it is; the seed is written only into an empty database.

| Command | What it does | Touches your bookings? |
|---|---|---|
| `npm start` | App on `data/rentvoice.db` | uses them |
| `npm run start:test-db` | Same app on a **separate** `data/test-run.db`; use it to record the test scenarios | no |
| `npm run db:snapshot` / `npm run test-db:snapshot` | Prints inventory and bookings (read-only) — "DB before/after" evidence | no (read-only) |
| `npm run test-db:reset` | Restores `test-run.db` to the seed (backup first) | no |
| `npm run reset-db -- --yes` | Restores `rentvoice.db` to the seed; asks for `--yes`, backs up first | **yes** (backup in `data/backups/`) |
| **Reset to seed** button | Same as above, for whichever database the server uses; asks first, backs up first | **yes** (backup in `data/backups/`) |
| `npm run migrate-seed` (`-- --apply`) | Moves only `BK-SEED-001` to the seed dates in `src/db.js`, keeps everything else | only the seed row |

The bookings table in the app shows which database file is in use.

## Tests and evidence

| Command | What it does | Needs API key |
|---|---|---|
| `npm test` | 34 automated checks: the five required scenarios, cancellation scope, boundary dates, whole-period availability, invalid input, idempotency, seed/backups, availability heading, conversational rules | no |
| `npm run evidence` | Writes `evidence/logic-checks.md`: expected result, every tool call, DB before/after for each scenario | no |
| `npm run voice-eval` | Plays the spoken test set (`test-set/voice-cases.json`) into the real agent; writes `evidence/voice-eval-<model>-<time>.md` with transcripts, tool calls, DB before/after, latency and cost | yes (costs a few cents) |
| `npm run voice-eval -- --model gpt-realtime-2.1 --runs 3` | Same, with the larger model and three runs | yes |
| `npm run voice-eval:mock` | Checks the eval harness against an offline mock (not the model) | no |

The voice eval uses its own temporary databases and never touches `data/`. The first run
synthesizes the test phrases once with OpenAI TTS and caches them in `test-set/audio/`.
To test with a real voice, put a recording named `<case>_<turn>.wav` (24 kHz, mono,
16-bit) in that folder; recordings take priority over synthesized audio.

## How it works

```
Browser (mic, speaker, UI)
  │  WebRTC audio  ───────────────────────────►  OpenAI Realtime (gpt-realtime-2.1-mini)
  │  data channel: events, tool calls  ◄──────►  speech-in → reasoning → speech-out, semantic VAD
  │
  │  HTTP: /api/tool, /api/confirm, /api/state, /api/metrics
  ▼
Node server (Express) ── booking rules ── SQLite (inventory, bookings, drafts, events)
```

1. The server mints a short-lived Realtime key (`/v1/realtime/client_secrets`) with the
   instructions, tools and voice settings. The real API key never reaches the browser.
2. Audio flows directly between the browser and OpenAI over WebRTC.
3. When the model calls a tool, the browser forwards it to our server, which owns the
   database, and passes the result back to the model.

### The rules that make bookings safe

The model only talks; **the server decides**.

| Requirement | Enforced by |
|---|---|
| Real availability | `availability()` counts units out on the busiest single day of the range (dates inclusive). The model never states stock without a tool result. |
| Unavailable ≠ booked | `prepare_booking` creates no proposal when stock is short; it returns free units and the nearest dates that fit. |
| Corrections leave no obsolete choices | Each conversation has at most one pending proposal. A new `prepare_booking` marks the previous one `superseded`, and confirming a superseded proposal fails. |
| Explicit confirmation | `confirm_booking` from voice is refused unless the user spoke **after** the proposal was made (user-turn counter tagged on every response). |
| Repeated confirmation ≠ duplicate | One booking per proposal: `bookings.source_draft_id` is `UNIQUE`; a second confirm (voice or button) returns the same booking with `duplicate: true`. |
| Stock changed in between | Availability is re-checked inside the same `BEGIN IMMEDIATE` transaction that inserts the booking. |
| Interruption | Server VAD cancels the reply when the user starts talking; the client also clears its audio buffer. Tool calls from an interrupted reply are **not executed**. If the user is mid-turn when a tool result arrives, the assistant waits instead of talking over them. |
| Pauses | `semantic_vad` waits until the sentence sounds finished, so "from the twelfth… to the fourteenth" is one turn. |
| Cancelling | `cancel_pending` only drops the current **unconfirmed** proposal. Cancelling a confirmed booking is outside the prototype's scope; the tool reports "nothing was changed", and the assistant is told never to claim otherwise. |

### Conversation behaviour

The opening line is "Hi! Welcome to RentVoice. What would you like to rent today?"
The assistant takes everything the customer already said, asks only for what is missing
or ambiguous, keeps replies short, and does not recite the catalog unprompted; asked
"what do you have?", it gives a brief overview from the real inventory. After an
interruption it keeps the details already understood. The rules live in
`buildInstructions()` in `src/agent.js` and are pinned by `test/agent-instructions.test.js`.

### On screen

- **Conversation**: "You" and "Assistant" turns. A reply is marked *speaking* while it
  plays and *Interrupted — not said in full* if you cut in. **Copy transcript** copies
  the conversation with those markers, for test evidence.
- **Booking details**: proposals are marked "Not booked yet"; a confirmed booking shows
  the booking ID from the database, equipment, quantity, dates, inclusive length and
  remaining units for those dates, with **Copy booking ID**.
- **Equipment**: free units for the requested dates; **Bookings table**: live database
  rows; **Performance & diagnostics**: collapsed by default.

## Measurement methodology and pricing assumptions

**Latency (measured):** in the browser, on real audio, sampled every 10 ms.
- End of the user's turn: the last moment the microphone level was above the speech
  threshold, taken when the server reports the end of speech.
- First audible answer: the first moment the assistant's incoming audio is above the
  same threshold.
- The semantic-VAD wait is included, because the user feels it.
- **Answer after a stock check** is the first audio of the reply built on a tool result.
- `npm run voice-eval` measures the same interval over the network, without speaker playback.

**Cost (estimated, not a bill):** calculated per reply from the token usage OpenAI
returns (`response.done.usage`: text and audio, cached and uncached, input and output),
plus input-transcription usage, at the list prices in `src/pricing.js` (OpenAI pricing
page, rates listed Oct 2026).

| Included | How |
|---|---|
| Recognition | Audio input tokens of the speech-to-speech model, plus `gpt-4o-mini-transcribe` for the on-screen transcript |
| Reasoning | Text input/output tokens (instructions, tool results, history; cached tokens at the cached rate) |
| Speech generation | Audio output tokens |
| Retries | Every reply has its own usage and is counted, including cancelled replies after an interruption and re-asked questions |
| Paid intermediaries | None: the browser talks to OpenAI directly; no telephony or other vendors |
| **Not included** | Hosting (fixed cost, listed separately in DELIVERY_NOTES.md); one-off TTS for the test audio |

Free API credits are not treated as zero cost: estimates use list prices.

## Configuration (`.env`)

| Variable | Default | Notes |
|---|---|---|
| `OPENAI_API_KEY` | — | required for voice |
| `APP_TODAY` | real date | `2026-10-01` in `.env.example` (keep it) |
| `REALTIME_MODEL` | `gpt-realtime-2.1-mini` | or `gpt-realtime-2.1` |
| `REALTIME_VOICE` | `marin` | |
| `TRANSCRIBE_MODEL` | `gpt-4o-mini-transcribe` | for the on-screen transcript |
| `VAD_TYPE` / `VAD_EAGERNESS` | `semantic_vad` / `medium` | `server_vad` is faster but cuts in on pauses |
| `DEMO_PASSCODE` | empty | set it when hosting publicly; the page asks for it |
| `DB_PATH`, `PORT` | `data/rentvoice.db`, `3000` | |

## Working browser demo (hosting)

Any Node host with HTTPS works (Render, Railway, Fly.io). The microphone needs HTTPS.

1. Push the repository (without `.env`; `.gitignore` excludes it).
2. Create a Node web service: build command `npm install`, start command `npm start`.
3. Set environment variables:
   - `OPENAI_API_KEY`;
   - `APP_TODAY=2026-10-01`;
   - `DEMO_PASSCODE=<something>`, so a public URL cannot spend your key.
4. Open the HTTPS URL in Chrome and enter the passcode when asked.

Without a persistent disk, the SQLite file resets on redeploy and the app re-seeds
itself. Hosting is a fixed cost, separate from the per-conversation estimate above.

## Project layout

```
src/booking.js          availability, validation, proposals, idempotent confirm, cancel scope
src/agent.js            greeting, instructions, tool schemas, tool dispatcher
src/realtime-config.js  session config shared by the app and the eval
src/server.js           HTTP API, ephemeral keys, backups before reset
src/db.js               schema, seed, backups
src/pricing.js          price table + cost per reply
src/metrics.js          latency and cost aggregation
public/                 UI (index.html, styles.css, app.js, stock-label.js)
test/                   node:test suite (34 checks)
scripts/                evidence, voice eval, offline mock, DB snapshot/reset/migrate
test-set/               spoken test cases (+ cached audio)
evidence/               generated reports
```
