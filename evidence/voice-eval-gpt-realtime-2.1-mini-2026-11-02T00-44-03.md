# Voice eval — gpt-realtime-2.1-mini

Run 2026-11-02T00:44:03.606Z · desk date 2026-10-01 · VAD semantic_vad/medium · transcription gpt-4o-mini-transcribe
Audio: test phrases synthesized with gpt-4o-mini-tts (voice ash), streamed in real time in 100 ms chunks over the Realtime WebSocket; silence streamed between turns like an open mic.

**1/1 cases passed.**

| Case | Expected | Booked | Checks | Result |
|---|---|---|---|---|
| S1 Normal booking | Agent reads back 1 × Camera A, 5–6 Nov (2 days), asks to confirm; after yes exactly one booking row is added. | camera_a ×1 2026-11-05→2026-11-06 | bookings_match: yes<br>no_redundant_question: yes | PASS |

## Speed

End of user speech → first agent audio chunk received: median 3160 ms, p90 5103 ms, min 3160, max 5103 (n=2).

End of user speech → first audio of the answer built on a tool result (turns with a stock check): median 3160 ms, p90 6364 ms, min 3160, max 6364 (n=2).

Measured over the network from this machine; in the browser add the WebRTC jitter buffer and speaker output (~50–150 ms). The semantic VAD wait is inside these numbers.

## Cost (variable, OpenAI API pricing page, rates listed Oct 2026 (USD))

| | Value |
|---|---|
| Total for 1 conversations | $0.0175 |
| Conversation time | 0.95 min |
| Per conversation minute | $0.0183 |
| Per confirmed booking (whole conversation) | $0.0175 |
| Test-audio synthesis (one-off, not per operation) | 82 chars with gpt-4o-mini-tts (≈ $0.00001 input + audio output tokens) |

| Case | Seconds | Responses | Audio in / cached | Text in / cached | Audio out | Text out | Realtime | Transcription | Total |
|---|---|---|---|---|---|---|---|---|---|
| S1 | 57.3 | 4 | 310 / 128 | 7204 / 5184 | 647 | 387 | $0.0173 | $0.0003 | $0.0175 |

## S1 — Normal booking: PASS

**Expected:** Agent reads back 1 × Camera A, 5–6 Nov (2 days), asks to confirm; after yes exactly one booking row is added.

**Conversation**

- 🧑 User (6.19s): Hi.
- 🧑 User (11.28s): I need one camera A from November 5th to November 6th.
- 🤖 Agent (14.44s): Hi! Welcome to RentVoice. What would you like to rent today?

Here’s the proposed booking: Camera A, quantity 1, from November 5, 2026, for two days until November 6, 2026. Shall I confirm?
- 🧑 User (37.14s): Yes, please confirm.
- 🤖 Agent (37.61s): Let me get that booking confirmed for you.
- 🤖 Agent (39.92s): All set, you’re confirmed. The booking ID is B K dash B three five A seven C. The dates are November 5, 2026 to November 6, 2026, for two days. If you need anything else after this, just let me know.

**Tool calls**

- turn 2 `prepare_booking` `{"equipment_id":"camera_a","quantity":1,"start_date":"2026-11-05","end_date":"2026-11-06"}` → proposal DR-EBB1C0
- turn 3 `confirm_booking` `{"draft_id":"DR-EBB1C0"}` → booked BK-B35A7C

**Latency**

| Turn | Said | Tool calls | First audio | Useful answer |
|---|---|---|---|---|
| 1 | Hi, I need one Camera A from November fifth to November sixth. | 1 | 3160 ms | 3160 ms |
| 2 | Yes, please confirm. | 1 | 5103 ms | 6364 ms |

**DB before:** 1 rows (BK-SEED-001). **DB after:** 2 rows; new: BK-B35A7C camera_a ×1 2026-11-05→2026-11-06.

<details><summary>Timeline</summary>

```
4.74s user says (new tts): "Hi, I need one Camera A from November fifth to November sixth."
4.97s user speech started (turn 1)
5.80s user speech stopped
5.80s user speech started (turn 2)
10.79s user speech stopped
11.94s tool prepare_booking (turn 2, response completed) → {"ok":true,"available":true,"draft_created":true,"superseded_previous":false,"draft":{"draft_id":"DR-EBB1C0","equipment_id":"camera_a","equipment":"Camera A","q
30.05s user says (new tts): "Yes, please confirm."
30.37s user speech started (turn 3)
36.67s user speech stopped
37.62s tool confirm_booking (turn 3, response completed) → {"ok":true,"duplicate":false,"booking":{"booking_id":"BK-B35A7C","equipment_id":"camera_a","equipment":"Camera A","quantity":1,"start_date":"2026-11-05","end_da
```
</details>

