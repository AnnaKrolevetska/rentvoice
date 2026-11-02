# Voice eval — gpt-realtime-2.1-mini

Run 2026-11-02T00:49:58.787Z · desk date 2026-10-01 · VAD semantic_vad/medium · transcription gpt-4o-mini-transcribe
Audio: test phrases synthesized with gpt-4o-mini-tts (voice ash), streamed in real time in 100 ms chunks over the Realtime WebSocket; silence streamed between turns like an open mic.

**4/4 cases passed.**

| Case | Expected | Booked | Checks | Result |
|---|---|---|---|---|
| S2 Corrected dates | The 5–7 Nov proposal is replaced; only an 8–9 Nov booking is saved. | tripod_b ×1 2026-11-08→2026-11-09 | bookings_match: yes | PASS |
| S3 Insufficient stock | Agent says only one camera is free on 11–12 Oct and offers one camera or 13–14 Oct; user declines; nothing is saved. | — | bookings_match: yes | PASS |
| S4 Interruption | User cuts in while the agent is speaking about the camera; agent audio stops; the tripod is proposed and booked; no camera booking. | tripod_b ×1 2026-11-10→2026-11-11 | bookings_match: yes<br>agent_cut_off: yes | PASS |
| S5 Repeated confirmation | Second 'yes' does not add a row; agent says it is already booked. | camera_a ×1 2026-11-05→2026-11-06 | bookings_match: yes<br>no_redundant_question: yes | PASS |

## Speed

End of user speech → first agent audio chunk received: median 1990 ms, p90 2466 ms, min 1396, max 2726 (n=11).

End of user speech → first audio of the answer built on a tool result (turns with a stock check): median 2797 ms, p90 3818 ms, min 1990, max 3818 (n=9).

Measured over the network from this machine; in the browser add the WebRTC jitter buffer and speaker output (~50–150 ms). The semantic VAD wait is inside these numbers.

## Cost (variable, OpenAI API pricing page, rates listed Oct 2026 (USD))

| | Value |
|---|---|
| Total for 4 conversations | $0.0892 |
| Conversation time | 4.17 min |
| Per conversation minute | $0.0214 |
| Per confirmed booking (whole conversation) | $0.0238 |
| Test-audio synthesis (one-off, not per operation) | 421 chars with gpt-4o-mini-tts (≈ $0.00006 input + audio output tokens) |

| Case | Seconds | Responses | Audio in / cached | Text in / cached | Audio out | Text out | Realtime | Transcription | Total |
|---|---|---|---|---|---|---|---|---|---|
| S2 | 70.6 | 7 | 570 / 384 | 11611 / 9344 | 862 | 579 | $0.0225 | $0.0004 | $0.0229 |
| S3 | 49.5 | 3 | 202 / 0 | 5233 / 1600 | 613 | 464 | $0.0177 | $0.0003 | $0.0179 |
| S4 | 60.5 | 7 | 597 / 256 | 13236 / 9664 | 792 | 914 | $0.0242 | $0.0003 | $0.0246 |
| S5 | 69.7 | 6 | 460 / 256 | 11469 / 9216 | 906 | 575 | $0.0235 | $0.0003 | $0.0238 |

## S2 — Corrected dates: PASS

**Expected:** The 5–7 Nov proposal is replaced; only an 8–9 Nov booking is saved.

**Conversation**

- 🧑 User (9.47s): I'd like one Tripod B from November 5th to November 7th.
- 🤖 Agent (11.92s): Hi! Welcome to RentVoice. What would you like to rent today?

I’ve set up a booking for Tripod B, quantity one, from November 5, 2026 to November 7, 2026, for three rental days.

Shall I confirm?
- 🧑 User (29.46s): Sorry.
- 🧑 User (32.86s): I meant November 8th to November 9th.
- 🤖 Agent (33.62s): Got it, let me update that and then I’ll read the summary back to you.
- 🤖 Agent (35.62s): All set, I’ve updated the booking. It’s for Tripod B, quantity one, from November 8, 2026 to November 9, 2026, for two rental days.

Would you like me to confirm this?
- 🧑 User (55.31s): Yes, confirm it.
- 🤖 Agent (57.13s): All confirmed. The booking ID is B K dash 9 A 5 5 6 3. The dates are November 8, 2026 through November 9, 2026, for two rental days.

**Tool calls**

- turn 1 `prepare_booking` `{"equipment_id":"tripod_b","quantity":1,"start_date":"2026-11-05","end_date":"2026-11-07"}` → proposal DR-B59953
- turn 3 `prepare_booking` `{"equipment_id":"tripod_b","quantity":1,"start_date":"2026-11-08","end_date":"2026-11-09"}` → proposal DR-288C1D
- turn 4 `confirm_booking` `{"draft_id":"DR-288C1D"}` → booked BK-9A5563

**Latency**

| Turn | Said | Tool calls | First audio | Useful answer |
|---|---|---|---|---|
| 1 | I'd like one Tripod B from November fifth to November seventh. | 1 | 2466 ms | 2466 ms |
| 2 | Sorry, I meant November eighth to November ninth. | 1 | 1662 ms | 2768 ms |
| 3 | Yes, confirm it. | 1 | 1990 ms | 1990 ms |

**DB before:** 1 rows (BK-SEED-001). **DB after:** 2 rows; new: BK-9A5563 tripod_b ×1 2026-11-08→2026-11-09.

<details><summary>Timeline</summary>

```
3.34s user says (new tts): "I'd like one Tripod B from November fifth to November seventh."
3.64s user speech started (turn 1)
8.81s user speech stopped
9.78s tool prepare_booking (turn 1, response completed) → {"ok":true,"available":true,"draft_created":true,"superseded_previous":false,"draft":{"draft_id":"DR-B59953","equipment_id":"tripod_b","equipment":"Tripod B","q
27.53s user says (new tts): "Sorry, I meant November eighth to November ninth."
27.81s user speech started (turn 2)
29.02s user speech stopped
29.14s user speech started (turn 3)
32.38s user speech stopped
33.63s tool prepare_booking (turn 3, response completed) → {"ok":true,"available":true,"draft_created":true,"superseded_previous":true,"draft":{"draft_id":"DR-288C1D","equipment_id":"tripod_b","equipment":"Tripod B","qu
52.18s user says (new tts): "Yes, confirm it."
52.51s user speech started (turn 4)
54.80s user speech stopped
55.27s tool confirm_booking (turn 4, response completed) → {"ok":true,"duplicate":false,"booking":{"booking_id":"BK-9A5563","equipment_id":"tripod_b","equipment":"Tripod B","quantity":1,"start_date":"2026-11-08","end_da
```
</details>

## S3 — Insufficient stock: PASS

**Expected:** Agent says only one camera is free on 11–12 Oct and offers one camera or 13–14 Oct; user declines; nothing is saved.

**Conversation**

- 🧑 User (9.07s): I need two Camera A units from October 11th to October 12th.
- 🤖 Agent (10.17s): Got it, let me set that up for your cameras and then we’ll confirm the details.
- 🤖 Agent (12.93s): I’ve created a new proposal based on your request, but there’s one issue. Only one Camera A is available, so we can’t book two for October 11 to 12. We could book one on those dates. Or, if you need two, we could try the dates October 13 to 14, which are close to full availability. Which option would you like?
- 🧑 User (38.21s): No thanks, that's all for now.
- 🤖 Agent (39.54s): Got it—no worries. That request isn’t set and nothing is booked. Whenever you’re ready to try again, just say what you need and we’ll handle it.

**Tool calls**

- turn 1 `prepare_booking` `{"equipment_id":"camera_a","quantity":2,"start_date":"2026-10-11","end_date":"2026-10-12"}` → available=false, free 1

**Latency**

| Turn | Said | Tool calls | First audio | Useful answer |
|---|---|---|---|---|
| 1 | I need two Camera A units from October eleventh to October twelfth. | 1 | 2093 ms | 3452 ms |
| 2 | No thanks, that's all for now. | 0 | 2054 ms | 2054 ms |

**DB before:** 1 rows (BK-SEED-001). **DB after:** 1 rows; new: none.

<details><summary>Timeline</summary>

```
2.63s user says (new tts): "I need two Camera A units from October eleventh to October twelfth."
2.88s user speech started (turn 1)
8.51s user speech stopped
10.18s tool prepare_booking (turn 1, response completed) → {"ok":true,"available":false,"requested_quantity":2,"free_units":1,"total_units":2,"equipment":"Camera A","dates_human":"11 October 2026 – 12 October 2026","ren
34.84s user says (new tts): "No thanks, that's all for now."
35.18s user speech started (turn 2)
37.65s user speech stopped
```
</details>

## S4 — Interruption: PASS

**Expected:** User cuts in while the agent is speaking about the camera; agent audio stops; the tripod is proposed and booked; no camera booking.

**Conversation**

- 🧑 User (6.68s): I need a camera from November 10th.
- 🧑 User (9.42s): to November 11th.
- 🤖 Agent (10.37s): Okay, let me check what cameras are available and then we’ll choose one.
- 🧑 User (16.51s): Actually, I need a tripod instead.
- 🤖 Agent (17.61s): Got it, switching to a tripod—let me check and set up that request.
- 🤖 Agent (19.84s): All set. I’ve got 1 Tripod B reserved from November 10, 2026 to November 11, 2026, which is 2 days. The draft ID is D R dash D 0 8 D 8 2. Shall I confirm?
- 🧑 User (41.44s): Yes, confirm.
- 🤖 Agent (42.06s): Okay, thanks for confirming. I’ll go ahead and finish that booking now.
- 🤖 Agent (43.85s): It’s confirmed. The booking ID is B K dash 4 1 6 7 B F. The dates are November 10, 2026 to November 11, 2026, for 2 days.

**Tool calls**

- turn 2 `get_inventory` `{}` → available=undefined, free undefined
- turn 2 `check_availability` `{"equipment_id":"camera_a","quantity":1,"start_date":"2026-11-10","end_date":"2026-11-11"}` → available=true, free 2
- turn 4 `prepare_booking` `{"equipment_id":"tripod_b","quantity":1,"start_date":"2026-11-10","end_date":"2026-11-11"}` → proposal DR-D08D82
- turn 5 `confirm_booking` `{"draft_id":"DR-D08D82"}` → booked BK-4167BF

**Latency**

| Turn | Said | Tool calls | First audio | Useful answer |
|---|---|---|---|---|
| 1 | I need a camera from November tenth to November eleventh. | 2 | 2726 ms | — ms |
| 2 | Actually, I need a tripod instead. | 1 | 1705 ms | 2977 ms |
| 3 | Yes, confirm. | 1 | 1396 ms | 2365 ms |

**Interruption:** agent cut off after 2706 ms of its reply; audio from the old reply received after the barge-in: 0 ms (not played).

**DB before:** 1 rows (BK-SEED-001). **DB after:** 2 rows; new: BK-4167BF tripod_b ×1 2026-11-10→2026-11-11.

<details><summary>Timeline</summary>

```
3.15s user says (new tts): "I need a camera from November tenth to November eleventh."
3.36s user speech started (turn 1)
6.36s user speech stopped
6.37s user speech started (turn 2)
9.06s user speech stopped
10.37s tool get_inventory (turn 2, response completed) → {"items":[{"equipment_id":"camera_a","name":"Camera A","total_units":2},{"equipment_id":"tripod_b","name":"Tripod B","total_units":3},{"equipment_id":"microphon
12.22s tool check_availability (turn 2, response completed) → {"ok":true,"available":true,"requested_quantity":1,"free_units":2,"total_units":2,"equipment":"Camera A","dates_human":"10 November 2026 – 11 November 2026","re
12.41s user says (new tts): "Actually, I need a tripod instead."
12.68s user speech started (turn 3)
12.68s BARGE-IN: agent cut off after 2706 ms of audio
13.87s user speech started (turn 4)
16.12s user speech stopped
17.63s tool prepare_booking (turn 4, response completed) → {"ok":true,"available":true,"draft_created":true,"superseded_previous":false,"draft":{"draft_id":"DR-D08D82","equipment_id":"tripod_b","equipment":"Tripod B","q
38.94s user says (new tts): "Yes, confirm."
39.26s user speech started (turn 5)
41.12s user speech stopped
42.08s tool confirm_booking (turn 5, response completed) → {"ok":true,"duplicate":false,"booking":{"booking_id":"BK-4167BF","equipment_id":"tripod_b","equipment":"Tripod B","quantity":1,"start_date":"2026-11-10","end_da
```
</details>

## S5 — Repeated confirmation: PASS

**Expected:** Second 'yes' does not add a row; agent says it is already booked.

**Conversation**

- 🧑 User (8.87s): Book one, Camera A, for November 5th to November 6th.
- 🤖 Agent (10.05s): Hi! Welcome to RentVoice. What would you like to rent today?
- 🤖 Agent (12.08s): I’ve prepared a booking for one Camera A. Pickup is November 5, 2026, and return is November 6, 2026, for two days. Shall I confirm?
- 🧑 User (29.33s): Yes, confirm.
- 🤖 Agent (30.24s): Okay, let me get that booking confirmed.
- 🤖 Agent (32.33s): All set—your booking is confirmed. The booking ID starts with B and ends with 1 7 5 6. The dates are November 5, 2026 through November 6, 2026, for two days.
- 🧑 User (50.33s): Yes, confirm the booking.
- 🤖 Agent (51.11s): Got it, I’ll confirm that booking now.
- 🤖 Agent (53.21s): It’s already confirmed, so no changes were saved. Your booking ID is BK-C11756, and the dates are November 5, 2026 through November 6, 2026, for two days.

**Tool calls**

- turn 1 `prepare_booking` `{"equipment_id":"camera_a","quantity":1,"start_date":"2026-11-05","end_date":"2026-11-06"}` → proposal DR-FAF383
- turn 2 `confirm_booking` `{"draft_id":"DR-FAF383"}` → booked BK-C11756
- turn 3 `confirm_booking` `{"draft_id":"DR-FAF383"}` → duplicate, BK-C11756

**Latency**

| Turn | Said | Tool calls | First audio | Useful answer |
|---|---|---|---|---|
| 1 | Book one Camera A for November fifth to November sixth. | 1 | 2416 ms | 3818 ms |
| 2 | Yes, confirm. | 1 | 1984 ms | 2848 ms |
| 3 | Yes, confirm the booking. | 1 | 1656 ms | 2797 ms |

**DB before:** 1 rows (BK-SEED-001). **DB after:** 2 rows; new: BK-C11756 camera_a ×1 2026-11-05→2026-11-06.

<details><summary>Timeline</summary>

```
2.89s user says (new tts): "Book one Camera A for November fifth to November sixth."
3.09s user speech started (turn 1)
8.49s user speech stopped
10.06s tool prepare_booking (turn 1, response completed) → {"ok":true,"available":true,"draft_created":true,"superseded_previous":false,"draft":{"draft_id":"DR-FAF383","equipment_id":"camera_a","equipment":"Camera A","q
26.56s user says (new tts): "Yes, confirm."
26.79s user speech started (turn 2)
28.99s user speech stopped
30.25s tool confirm_booking (turn 2, response completed) → {"ok":true,"duplicate":false,"booking":{"booking_id":"BK-C11756","equipment_id":"camera_a","equipment":"Camera A","quantity":1,"start_date":"2026-11-05","end_da
47.11s user says (new tts): "Yes, confirm the booking."
47.39s user speech started (turn 3)
49.99s user speech stopped
51.12s tool confirm_booking (turn 3, response completed) → {"ok":true,"duplicate":true,"message":"This booking was already confirmed earlier; nothing new was saved.","booking":{"booking_id":"BK-C11756","equipment_id":"c
```
</details>

