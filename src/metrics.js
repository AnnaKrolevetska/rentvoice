// Aggregates the measurements stored in the `events` table.
export function stats(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0 };
  const q = (p) => v[Math.min(v.length - 1, Math.ceil(p * v.length) - 1)];
  return { n: v.length, min: v[0], median: q(0.5), p90: q(0.9), max: v.at(-1), mean: Math.round(v.reduce((a, b) => a + b, 0) / v.length) };
}

export function summarizeMetrics(db, sessionId = null) {
  const rows = db.prepare(
    `SELECT session_id, kind, payload FROM events WHERE kind IN ('latency','usage','transcription_usage','session')
     AND (? IS NULL OR session_id = ?) ORDER BY id`
  ).all(sessionId, sessionId).map((r) => ({ ...r, payload: JSON.parse(r.payload) }));

  const lat = rows.filter((r) => r.kind === 'latency').map((r) => r.payload);
  const perSession = new Map();
  const S = (id) => perSession.get(id) || perSession.set(id, { realtime: 0, transcription: 0, seconds: 0, responses: 0, model: null }).get(id);

  for (const r of rows) {
    const s = S(r.session_id);
    if (r.kind === 'usage' && r.payload.cost) { s.realtime += r.payload.cost.total; s.responses++; s.model = r.payload.model || s.model; }
    if (r.kind === 'transcription_usage' && r.payload.cost) s.transcription += r.payload.cost.total;
    if (r.kind === 'session' && r.payload.event === 'end') s.seconds = Math.max(s.seconds, r.payload.seconds || 0);
  }

  const bookings = db.prepare(
    `SELECT session_id, COUNT(*) AS n FROM bookings WHERE session_id IS NOT NULL AND session_id <> 'seed'
     AND (? IS NULL OR session_id = ?) GROUP BY session_id`
  ).all(sessionId, sessionId);
  const bookingsBySession = Object.fromEntries(bookings.map((b) => [b.session_id, b.n]));

  let cost = 0, seconds = 0, bookedCost = 0, bookedCount = 0;
  const sessionsOut = [];
  for (const [id, s] of perSession) {
    if (!s.responses && !s.transcription) continue;
    const total = s.realtime + s.transcription;
    cost += total; seconds += s.seconds;
    const nb = bookingsBySession[id] || 0;
    if (nb) { bookedCost += total; bookedCount += nb; }
    sessionsOut.push({ sessionId: id, model: s.model, seconds: Math.round(s.seconds), responses: s.responses, realtimeUsd: +s.realtime.toFixed(5), transcriptionUsd: +s.transcription.toFixed(5), totalUsd: +total.toFixed(5), bookings: nb });
  }

  return {
    latency: {
      first_audible_ms: stats(lat.map((l) => l.first_audible_ms)),
      useful_answer_ms: stats(lat.map((l) => l.useful_answer_ms)),
      last: lat.at(-1) || null,
    },
    cost: {
      total_usd: +cost.toFixed(5),
      session_minutes: +(seconds / 60).toFixed(2),
      usd_per_conversation_minute: seconds ? +((cost / seconds) * 60).toFixed(4) : null,
      usd_per_confirmed_booking: bookedCount ? +(bookedCost / bookedCount).toFixed(4) : null,
      sessions: sessionsOut,
    },
  };
}
