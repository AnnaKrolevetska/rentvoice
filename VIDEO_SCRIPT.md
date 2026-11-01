# Video walkthrough (≤ 3:00)

Before recording: `npm run test-db:reset`, then `npm run start:test-db`. This uses a
separate test database, so your own bookings are untouched, and the bookings table says
"Database file: test-run.db". Open the app full screen, reload the page and use headphones.
The transcript and the bookings table are your captions. Full scripts and pass/fail
criteria: `TEST_SCENARIOS.md`.

| Time | Show | Say / do |
|---|---|---|
| 0:00–0:15 | App, empty | "A voice agent for a rental desk. It checks real stock in a database and only books after an explicit yes." Press the mic: the assistant greets you. Point at the equipment cards (free units) and the bookings table (1 seeded row, 10–12 Oct). |
| 0:15–0:50 | **Normal booking (S1)** | Start talking → "I need one Camera A from November fifth to November sixth." → agent reads back → "Yes, confirm." Show "Not booked yet" before the yes, then the green Booking details card (booking ID, 2 days, remaining units) and the new highlighted row (2 rows now). Click Copy booking ID. |
| 0:50–1:15 | **Insufficient stock (S3)** | "I need two Camera A units from October eleventh to twelfth." Agent: only one free, offers one or 13–14 Oct. "No thanks." Table still 2 rows. |
| 1:15–1:40 | **Correction (S2)** | "A tripod from November fifth to seventh." → while the summary shows: "Sorry, I meant eighth to ninth." Ticket updates to 8–9 Nov. "Yes." One new row, 8–9 Nov only. |
| 1:40–2:00 | **Interruption (S4)** | Ask for a camera, then cut in mid-sentence: "Actually, I need a tripod." The agent stops at once; its message is marked "Interrupted". |
| 2:00–2:20 | **Repeated confirmation (S5)** | After a booking, say "Yes, confirm" again. The assistant says it's already booked; the row count does not change. Open "What the agent checked" to show `duplicate: true`. |
| 2:20–2:45 | Evidence | Terminal: `npm test` (34 passing). `npm run test-db:snapshot` (DB after). Scroll `evidence/voice-eval-…md`: pass table, latency, cost. |
| 2:45–3:00 | Tradeoff | Open **Performance & diagnostics**: "Median ⟨x⟩ ms to first audio, ⟨$⟩ per booking with the mini model. I chose mini plus strict server rules over the bigger model, because the rules, not the model, guarantee correct bookings." |
