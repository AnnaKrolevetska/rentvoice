# Delivery notes — Voice equipment booking agent

> **Before sending:** replace every ⟨…⟩ with real numbers from your own runs
> (`npm run voice-eval`, the app's **Performance & diagnostics** section, or `GET /api/metrics`
> after live conversations). Do not keep a number you did not measure.

## Setup

- Local: `npm install` → `cp .env.example .env` (add `OPENAI_API_KEY`, keep `APP_TODAY=2026-10-01`)
  → `npm test` → `npm start` → http://localhost:3000. Details: README and `START_HERE_MAC.md`.
- Browser demo: any HTTPS Node host (Render, Railway, Fly.io) with `npm install` / `npm start`
  and `OPENAI_API_KEY`, `APP_TODAY`, `DEMO_PASSCODE` set (README → "Working browser demo").

## What was built

A browser voice agent (RentVoice) for a rental desk with Camera A × 2,
Tripod B × 3 and Microphone C × 1, and one seeded Camera A booking for 10–12 Oct 2026, as the brief specifies.
The user speaks; the agent asks for what is missing, checks real availability in
SQLite, reads back a summary and saves exactly one booking after an explicit yes.
The screen shows the conversation, the current proposal or confirmed booking, free
units for the requested dates, and the live bookings table.

- Demo: ⟨URL⟩ (passcode: ⟨…⟩) — or run locally, see README
- Repository: ⟨URL⟩
- Video (≤ 3 min): ⟨URL⟩

## Scope decisions (product judgment)

- **English only, one item type per booking, one conversation at a time**, as the brief allows.
  “A camera and a tripod” is handled by booking them one after the other.
- **The model talks; the server decides.** Availability, proposals and confirmation live
  in plain, tested code. The model can only call five tools, so a misheard or hallucinated
  “yes” cannot create an unavailable, obsolete or duplicate booking. This was the main
  quality investment.
- **Fixed desk date (1 Oct 2026)** so every check is reproducible whatever day it runs.
  Past start dates are refused, as at a real desk.
- **Confirm button as a backup to voice**, using the same idempotent path.
- **Cancelling:** the assistant can drop an *unconfirmed* proposal. Cancelling a *confirmed*
  booking is out of scope; the server reports "nothing was changed", and the assistant is told
  to say so rather than claim a cancellation.
- **Conversation design:** a short greeting, no catalog recital, no re-asking for details
  already given, concise replies, and details kept after an interruption. The rules are in
  `src/agent.js` and pinned by tests.
- **Safe test data:** recordings use a separate `data/test-run.db`. Resets are manual, ask
  first, and always back up to `data/backups/`.
- **Not built:** accounts, payments, cancelling or editing existing bookings, multiple
  items per booking, other languages, concurrent conversations beyond SQLite transactions.

## Quality / speed / cost tradeoff

| Option | Quality | Speed | Cost | Decision |
|---|---|---|---|---|
| Speech-to-speech `gpt-realtime-2.1-mini` | Good tool use; correctness guarded by server rules | One hop, no separate STT/TTS | Audio $10 in / $20 out per 1M tokens | **Chosen default** |
| Speech-to-speech `gpt-realtime-2.1` | Better at messy phrasing | Similar | ~3× mini (audio $32 / $64) | Available via `REALTIME_MODEL`; compared in eval ⟨if you ran it⟩ |
| STT → text LLM → TTS pipeline | Most inspectable | Three hops; barge-in is harder | Can be cheaper or dearer depending on talk time | Rejected for an 8-hour prototype |
| `semantic_vad` vs `server_vad` | Semantic waits through mid-sentence pauses | Silence-based answers sooner | — | **Semantic**: talking over the user is worse than a slightly later answer |

Measured result: ⟨e.g. "mini: median 1.1 s to first audio, 1.9 s to the answer after a
stock check, $0.0X per booking conversation; full model: … — mini kept because …"⟩

## Test set

Expected outcomes were written into the test files before the first run.

- **Logic level** (`scripts/scenarios.js`, no model, runs with `npm test` / `npm run evidence`):
  replays the exact tool calls of each conversation and checks the DB before/after.
- **Voice level** (`test-set/voice-cases.json`, `npm run voice-eval`): spoken audio streamed in
  real time into the same agent, judged by what ends up in the database.

| ID | Sample input (spoken) | Expected | Logic check | Voice result |
|---|---|---|---|---|
| S1 normal | “I need one Camera A from November fifth to November sixth.” → “Yes, please confirm.” | 1 booking, Camera A ×1, 5–6 Nov | PASS | ⟨PASS/FAIL + note⟩ |
| S2 correction | “…Tripod B from November fifth to seventh.” → “Sorry, I meant November eighth to ninth.” → “Yes.” | Old proposal superseded; 1 booking for 8–9 Nov | PASS | ⟨⟩ |
| S3 insufficient stock | “Two Camera A units from October eleventh to twelfth.” → “No thanks.” | Told only 1 free; offered 1 unit or 13–14 Oct; no booking | PASS | ⟨⟩ |
| S4 interruption | “A camera from November tenth to eleventh.” → (cuts in) “Actually, I need a tripod instead.” → “Yes.” | Agent audio stops; only a tripod booking | PASS | ⟨⟩ |
| S5 repeated confirm | “…one Camera A for November fifth to sixth.” → “Yes, confirm.” → “Yes, confirm the booking.” | One row; second yes reports “already booked” | PASS | ⟨⟩ |
| A1 ambiguity | “I need a camera for next weekend.” | Agent states exact dates or asks; no booking | — | ⟨⟩ |
| A2 decline | “Can I rent a drone for tomorrow?” | Not stocked; offers what exists; no booking | PASS (X4) | ⟨⟩ |
| C1 catalog question | “What equipment do you have?” | Brief overview, nothing invented, asks what is needed; no booking | — | ⟨⟩ |
| X5 drop proposal | “A tripod for November 20.” → “Actually, cancel that.” | Proposal dropped, nothing booked | PASS | — |
| X6 cancel confirmed | (after a booking) “Please cancel my booking.” | “Not supported here, nothing was changed”; booking stays | PASS | ⟨⟩ |
| P1 pause | “One tripod from November twelfth… [1.5 s] …to November fourteenth.” → “Yes.” | No answer during the pause; booking 12–14 Nov | — | ⟨⟩ |

DB before/after for every case: `evidence/logic-checks.md` and `evidence/voice-eval-*.md`.
Step-by-step recording instructions and pass/fail criteria for S1–S5: `TEST_SCENARIOS.md`.

## Measured speed

| Metric | Value | Where measured |
|---|---|---|
| End of user speech → first audible agent audio, median / p90 | ⟨⟩ / ⟨⟩ ms (n=⟨⟩) | Browser, real mic, ⟨your machine, network⟩ |
| End of user speech → answer built on a stock check, median | ⟨⟩ ms | Browser |
| Same two metrics in the voice eval (network, no playback) | ⟨⟩ / ⟨⟩ ms | `evidence/voice-eval-*.md` |
| Time to a confirmed booking (start → booking ID on screen) | ⟨⟩ s | Video / app |

**Method:** browser, real audio sampled every 10 ms. Measured from the last moment the
microphone carried speech (when the server reports end of speech) to the first moment
the assistant's incoming audio is audible. The semantic-VAD wait is included, because
the user feels it. "Answer after a stock check" is the first audio of the reply built on
a tool result.

## Cost per operation

**Pricing assumptions** (OpenAI API pricing page, rates listed Oct 2026, USD per 1M tokens):

| Component | Model | Rate |
|---|---|---|
| Recognition + reasoning + speech (one model) | `gpt-realtime-2.1-mini` | audio in $10, cached audio $0.30, audio out $20; text in $0.60, cached $0.06, out $2.40 |
| On-screen transcript | `gpt-4o-mini-transcribe` | $1.25 in / $5 out per 1M tokens (≈ $0.003 per audio minute) |
| Larger model for comparison | `gpt-realtime-2.1` | audio $32 / $0.40 / $64; text $4 / $0.40 / $24 |
| Test-audio synthesis (one-off, not per operation) | `gpt-4o-mini-tts` | $0.60 per 1M text tokens in, $12 per 1M audio tokens out |
| Paid intermediaries | none | Browser ↔ OpenAI is direct; no telephony or other vendors |

What the per-operation **estimate** covers (calculated from OpenAI's reported token usage,
not taken from a bill):

| Part of the voice stack | Included? |
|---|---|
| Recognition | Yes: audio input tokens + `gpt-4o-mini-transcribe` for the transcript |
| Reasoning | Yes: text input/output tokens, cached tokens at the cached rate |
| Speech generation | Yes: audio output tokens |
| Retries | Yes: every reply has its own usage, including cancelled replies after a barge-in and re-asked questions |
| Paid intermediaries | None used |
| Hosting | No: fixed cost, listed below |

| Measured | Value |
|---|---|
| Variable cost per conversation minute | ⟨$⟩ |
| Variable cost per confirmed booking (whole conversation) | ⟨$⟩ |
| Share: audio out / audio in / text / transcription | ⟨…⟩ |

**Hosting (separate, fixed):** ⟨e.g. Render Starter $7/month, or $0 on the free tier with
sleep⟩. Free API credits, if used, are not counted as zero: the figures above are list prices.

## AI tools and models used

| Tool / model | Used for |
|---|---|
| ChatGPT (⟨model shown in your ChatGPT⟩) | First read of the brief, scope and plan |
| Claude (Claude Opus 5.5, claude.ai) | Architecture, all code, tests, voice eval, offline mock, docs draft |
| `gpt-realtime-2.1-mini` (runtime) | Speech in, reasoning, tool calls, speech out |
| `gpt-4o-mini-transcribe` (runtime) | Transcript shown on screen and in reports |
| `gpt-4o-mini-tts` (test only) | Synthesizing the spoken test set |

**Reused components:**
- Express 5, better-sqlite3 13 and ws 8 (npm);
- the WebRTC connection pattern from OpenAI's Realtime documentation;
- Lucide-style line icons, redrawn inline;
- Google Fonts (Plus Jakarta Sans).

**Written for this brief:**
- booking rules (busiest-day availability, superseding proposals, idempotent confirm,
  cancellation scope);
- the tool protocol and user-turn tagging;
- interruption handling;
- latency probes and cost accounting;
- the UI;
- the test set, voice-eval harness and offline mock;
- DB snapshot, backup and migration scripts.
⟨Add what you changed yourself: copy, design tweaks, prompt edits, fixes after testing.⟩

**How AI output was checked (examples):**

1. *Overlap logic.* The planning notes suggested computing availability as “total minus
   overlapping bookings”. That over-counts two short bookings that overlap the request
   but not each other. Availability now uses the busiest single day, and a dedicated test
   covers it: bookings on 10–12 and 14–15 Oct leave 1 camera free for 10–15 Oct, not 0.
2. *Do the tests catch real bugs?* The inclusive-date overlap rule was deliberately broken
   (`<=` → `<`); S3 and X3 failed as they should. Then the rule was restored.
3. ⟨Your own check, e.g. "I listened to S4 and confirmed the agent stopped mid-word" or
   "I compared the cost in the report with the OpenAI usage dashboard: $X vs $Y".⟩

## What failed or is unfinished

- ⟨Every voice-eval FAIL, with the transcript line that shows why.⟩
- Latency is measured to the first audible sound, which can be a short filler
  (“Let me check”). Hence the separate “useful answer” metric.
- The barge-in threshold is a fixed mic level. A noisy room can trigger false
  interruptions; the browser's echo cancellation helps, but it was not tuned per device.
- `gpt-4o-mini-transcribe` is scheduled for retirement on 26 Feb 2027; it is only used
  for the transcript, so switching is a config change.
- Cancelling or editing confirmed bookings is not supported (by design for this scope).
- The conversational rules (no re-asking, brief catalog answers) are instructions to the
  model; tests pin the instructions, but only voice runs show whether the model follows them.
- Cost figures are estimates from reported token usage at list prices; check them against
  the OpenAI usage page.
- One conversation at a time: proposals are per session, but there is no lock between
  two people proposing the last unit. The final re-check inside the write transaction
  prevents double-booking; the second person simply gets “no longer available”.

## What I would improve next

1. Per-device calibration of the speech threshold, and a “push to talk” fallback for noisy rooms.
2. Speak a short filler while a tool runs (or prefetch availability as soon as item and dates
   are heard) to cut the time to a useful answer.
3. Edit and cancel existing bookings by voice (“move my booking to Friday”).
4. Multi-item baskets (camera + tripod in one confirmation).
5. Run the voice eval nightly on real recorded voices with different accents and
   track pass rate, latency and cost over time.

## Time spent

⟨h:mm total⟩ — ⟨rough split: planning, build, testing, video, notes⟩
