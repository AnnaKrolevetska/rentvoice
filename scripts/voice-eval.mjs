// Voice eval: plays the spoken test set into the SAME agent (same instructions,
// tools, VAD and booking code) over the Realtime WebSocket, as a live mic would:
// audio is streamed in real time, with silence between turns.
//
// Measures per user turn:
//   first_audio_ms  = end of the user's speech → first agent audio chunk received
//   useful_ms       = end of speech → first audio of the answer that uses a tool result
// Records tool calls, transcripts, DB before/after, token usage and cost.
//
// Usage: npm run voice-eval [-- --model gpt-realtime-2.1 --only S1,S4 --runs 2]
process.env.APP_TODAY ||= '2026-10-01';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import WebSocket from 'ws';
import { openDb, seed } from '../src/db.js';
import { runTool } from '../src/agent.js';
import { snapshot } from '../src/booking.js';
import { sessionConfig, config } from '../src/realtime-config.js';
import { realtimeResponseCost, transcriptionCost, PRICING_SOURCE, TTS_PRICES } from '../src/pricing.js';
import { stats } from '../src/metrics.js';

const KEY = process.env.OPENAI_API_KEY;
// Overridable only for the offline mock test (scripts/mock-realtime.mjs).
const API = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const WSS = process.env.OPENAI_REALTIME_URL || 'wss://api.openai.com/v1/realtime';
if (!KEY) { console.error('OPENAI_API_KEY missing (put it in .env)'); process.exit(1); }

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const MODEL = arg('model', config().model);
const ONLY = arg('only', '')?.split(',').filter(Boolean);
const RUNS = Number(arg('runs', 1));
const TTS_MODEL = 'gpt-4o-mini-tts', TTS_VOICE = 'ash';

const RATE = 24000, CHUNK_MS = 100, CHUNK_BYTES = (RATE * 2 * CHUNK_MS) / 1000;
const AUDIO_DIR = process.env.EVAL_AUDIO_DIR || 'test-set/audio';
const cases = JSON.parse(fs.readFileSync('test-set/voice-cases.json', 'utf8')).cases.filter((c) => !ONLY.length || ONLY.includes(c.id));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

// ---------- audio ----------
let ttsChars = 0;
async function tts(text, file) {
  const r = await fetch(`${API}/audio/speech`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, input: text, response_format: 'pcm' }),
  });
  if (!r.ok) throw new Error(`TTS failed ${r.status}: ${await r.text()}`);
  ttsChars += text.length;
  const buf = Buffer.from(await r.arrayBuffer());
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  fs.writeFileSync(file, buf);
  return buf;
}

function readWav(file) {
  const b = fs.readFileSync(file);
  const fmt = b.indexOf('fmt '), data = b.indexOf('data');
  const ch = b.readUInt16LE(fmt + 10), rate = b.readUInt32LE(fmt + 12), bits = b.readUInt16LE(fmt + 22);
  if (ch !== 1 || rate !== RATE || bits !== 16) throw new Error(`${file}: need 24 kHz mono 16-bit WAV (got ${rate} Hz, ${ch} ch, ${bits} bit)`);
  return b.subarray(data + 8, data + 8 + b.readUInt32LE(data + 4));
}

// Trim leading/trailing silence so "end of speech" is the real last syllable.
function trim(pcm) {
  const n = pcm.length / 2, win = 240; // 10 ms
  const loud = (i) => { let s = 0; for (let k = i; k < Math.min(n, i + win); k++) { const v = pcm.readInt16LE(k * 2) / 32768; s += v * v; } return Math.sqrt(s / win) > 0.01; };
  let a = 0, z = n - win;
  while (a < n - win && !loud(a)) a += win;
  while (z > a && !loud(z)) z -= win;
  return pcm.subarray(a * 2, Math.min(n, z + win) * 2);
}

async function audioFor(caseId, turnIdx, partIdx, text) {
  const base = path.join(AUDIO_DIR, `${caseId}_${turnIdx + 1}${partIdx ? String.fromCharCode(97 + partIdx) : ''}`);
  if (fs.existsSync(base + '.wav')) return { pcm: trim(readWav(base + '.wav')), source: 'recorded wav' };
  // Cached audio is reused only if it was synthesized from the same text.
  const same = fs.existsSync(base + '.txt') && fs.readFileSync(base + '.txt', 'utf8') === text;
  if (same && fs.existsSync(base + '.pcm')) return { pcm: trim(fs.readFileSync(base + '.pcm')), source: 'cached tts' };
  const pcm = await tts(text, base + '.pcm');
  fs.writeFileSync(base + '.txt', text);
  return { pcm: trim(pcm), source: 'new tts' };
}

// ---------- one conversation ----------
async function runCase(c) {
  const dbFile = path.join(os.tmpdir(), `rv-eval-${c.id}-${Date.now()}.db`);
  const db = openDb(dbFile);
  seed(db);
  const sessionId = `EVAL-${c.id}`;
  const before = snapshot(db);

  const ws = new WebSocket(`${WSS}?model=${encodeURIComponent(MODEL)}`, { headers: { Authorization: `Bearer ${KEY}` } });
  const log = [];          // human-readable timeline
  const transcript = [];   // { who, text }
  const tools = [];
  const turnsM = [];
  const usage = { responses: [], transcriptions: [] };
  const S = {
    turn: 0, responseTurn: new Map(), postTool: new Set(), pendingPostTool: false,
    userSpeaking: false, activeResponses: new Set(), playbackEnd: 0, busyTools: 0,
    currentAudioItem: null, itemAudioStart: 0, cutOff: [], audioAfterBarge: 0, bargeAt: null,
    pauseWindow: null, answeredDuringPause: false, lastAgentAudioAt: 0, firstAudioAfter: 0,
  };
  const t0 = now();
  const stamp = () => `${((now() - t0) / 1000).toFixed(2)}s`;
  const send = (ev) => ws.readyState === 1 && ws.send(JSON.stringify(ev));

  // Mic: a 100 ms clock that always streams — queued speech or silence.
  const queue = [];
  const SILENCE = Buffer.alloc(CHUNK_BYTES);
  let micTimer, nextTick = 0;
  const startMic = () => {
    nextTick = now();
    const tick = () => {
      const chunk = queue.length ? queue.shift() : SILENCE;
      send({ type: 'input_audio_buffer.append', audio: chunk.toString('base64') });
      if (chunk.onSent) chunk.onSent(now());
      nextTick += CHUNK_MS;
      micTimer = setTimeout(tick, Math.max(0, nextTick - now()));
    };
    tick();
  };
  const speak = (pcm) => new Promise((resolve) => {
    for (let i = 0; i < pcm.length; i += CHUNK_BYTES) {
      const part = Buffer.alloc(CHUNK_BYTES);
      pcm.copy(part, 0, i, Math.min(pcm.length, i + CHUNK_BYTES));
      queue.push(part);
    }
    queue.at(-1).onSent = (t) => resolve(t + ((pcm.length % CHUNK_BYTES || CHUNK_BYTES) / (RATE * 2)) * 1000 - CHUNK_MS);
  });

  const agentIdle = () => S.activeResponses.size === 0 && S.busyTools === 0 && now() > S.playbackEnd && !S.userSpeaking;
  async function waitIdle(minQuietMs = 1200, timeout = 30000) {
    const start = now();
    let quietSince = null;
    while (now() - start < timeout) {
      if (agentIdle()) { quietSince ??= now(); if (now() - quietSince >= minQuietMs) return true; } else quietSince = null;
      await sleep(50);
    }
    return false;
  }

  async function onResponseDone(resp) {
    S.activeResponses.delete(resp.id);
    if (resp.usage) usage.responses.push({ id: resp.id, status: resp.status, usage: resp.usage, cost: realtimeResponseCost(MODEL, resp.usage) });
    const calls = (resp.output || []).filter((o) => o.type === 'function_call');
    if (!calls.length) return;
    const turn = S.responseTurn.get(resp.id) ?? S.turn;
    const m = turnsM.find((x) => x.turn === turn);
    if (m) m.tool_calls += calls.length;
    S.busyTools++;
    for (const call of calls) {
      let result;
      if (resp.status !== 'completed') {
        result = { ok: false, error: 'interrupted', message: 'The user interrupted; this call was not executed. Follow their latest words.' };
      } else {
        let args = {};
        try { args = JSON.parse(call.arguments || '{}'); } catch { /* empty */ }
        result = runTool(call.name, args, { db, sessionId, turn, source: 'voice' });
        tools.push({ at: stamp(), turn, name: call.name, args, result });
      }
      log.push(`${stamp()} tool ${call.name} (turn ${turn}, response ${resp.status}) → ${JSON.stringify(result).slice(0, 160)}`);
      send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) } });
    }
    S.busyTools--;
    if (!S.userSpeaking && turn === S.turn) { S.pendingPostTool = true; send({ type: 'response.create' }); }
  }

  const done = new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('close', resolve);
    ws.on('message', (raw) => {
      const ev = JSON.parse(raw.toString());
      const t = now();
      switch (ev.type) {
        case 'error':
          if (!/cancel|not active|no active/i.test(ev.error?.code || '')) log.push(`${stamp()} ERROR ${JSON.stringify(ev.error)}`);
          break;
        case 'input_audio_buffer.speech_started':
          S.turn++; S.userSpeaking = true;
          log.push(`${stamp()} user speech started (turn ${S.turn})`);
          if (t < S.playbackEnd && S.currentAudioItem) {
            // Barge-in: stop "playback" and tell the server how much was heard.
            const heard = Math.max(0, Math.round(t - S.itemAudioStart));
            send({ type: 'response.cancel' });
            send({ type: 'conversation.item.truncate', item_id: S.currentAudioItem, content_index: 0, audio_end_ms: heard });
            S.cutOff.push({ at: stamp(), heard_ms: heard });
            S.bargeAt = t; S.playbackEnd = t;
            log.push(`${stamp()} BARGE-IN: agent cut off after ${heard} ms of audio`);
          }
          break;
        case 'input_audio_buffer.speech_stopped':
          S.userSpeaking = false;
          log.push(`${stamp()} user speech stopped`);
          break;
        case 'conversation.item.input_audio_transcription.completed':
          transcript.push({ who: 'user', text: ev.transcript?.trim(), at: stamp() });
          if (ev.usage) usage.transcriptions.push({ usage: ev.usage, cost: transcriptionCost(config().transcribeModel, ev.usage) });
          break;
        case 'response.created':
          S.activeResponses.add(ev.response.id);
          S.responseTurn.set(ev.response.id, S.turn);
          if (S.pendingPostTool) { S.postTool.add(ev.response.id); S.pendingPostTool = false; }
          break;
        case 'response.output_audio.delta': {
          const bytes = Buffer.byteLength(ev.delta, 'base64');
          if (S.currentAudioItem !== ev.item_id) { S.currentAudioItem = ev.item_id; S.itemAudioStart = Math.max(t, S.playbackEnd); }
          S.playbackEnd = Math.max(t, S.playbackEnd) + (bytes / (RATE * 2)) * 1000;
          S.lastAgentAudioAt = t;
          if (S.bargeAt && S.responseTurn.get(ev.response_id) < S.turn) S.audioAfterBarge += bytes;
          if (S.pauseWindow && t >= S.pauseWindow[0] && t <= S.pauseWindow[1] + 400) S.answeredDuringPause = true;
          const m = turnsM.find((x) => x.turn === S.responseTurn.get(ev.response_id));
          if (m) {
            if (m.first_audio == null && t > m.end) m.first_audio = t;
            if (m.useful == null && S.postTool.has(ev.response_id)) m.useful = t;
          }
          break;
        }
        case 'response.output_audio_transcript.done':
          transcript.push({ who: 'agent', text: ev.transcript, at: stamp() });
          break;
        case 'response.done':
          onResponseDone(ev.response);
          break;
      }
    });
  });

  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const { model: _m, ...sessionNoModel } = sessionConfig({ forWebSocket: true }); // model is fixed by the URL
  send({ type: 'session.update', session: sessionNoModel });
  startMic();
  await sleep(800);

  for (let i = 0; i < c.turns.length; i++) {
    const turn = c.turns[i];
    if (turn.mode === 'barge_in') {
      // Wait for the agent to start talking, then cut in.
      const start = now();
      while (!(S.playbackEnd > now() && S.lastAgentAudioAt > (turnsM.at(-1)?.end ?? 0)) && now() - start < 20000) await sleep(20);
      await sleep(turn.barge_after_ms ?? 800);
    } else if (i > 0) {
      await waitIdle();
    }
    const parts = Array.isArray(turn.say) ? turn.say : [turn.say];
    let end = null;
    for (let p = 0; p < parts.length; p++) {
      const { pcm, source } = await audioFor(c.id, i, p, parts[p]);
      log.push(`${stamp()} user says (${source}): "${parts[p]}"`);
      end = await speak(pcm);
      if (p < parts.length - 1) {
        S.pauseWindow = [end, end + turn.pause_ms];
        await sleep(turn.pause_ms);
      }
    }
    // Turn number this utterance got (speech_started already incremented it).
    await sleep(50);
    turnsM.push({ turn: S.turn, idx: i + 1, end, first_audio: null, useful: null, tool_calls: 0, said: parts.join(' ') });
  }
  await waitIdle(2500, 40000);
  clearTimeout(micTimer);
  const seconds = (now() - t0) / 1000;
  ws.close();
  await done.catch(() => {});

  const after = snapshot(db);
  db.close();
  fs.rmSync(dbFile, { force: true });
  for (const ext of ['-wal', '-shm']) fs.rmSync(dbFile + ext, { force: true });

  // ---- judge ----
  const created = after.bookings.filter((b) => !before.bookings.some((x) => x.id === b.id));
  const key = (b) => `${b.equipment_id}|${b.quantity}|${b.start_date}|${b.end_date}`;
  const want = c.expect.new_bookings.map(key).sort().join(';');
  const got = created.map(key).sort().join(';');
  const checks = { bookings_match: want === got };
  if (c.expect.agent_asks) checks.agent_asked = transcript.filter((x) => x.who === 'agent').some((x) => x.text?.includes('?'));
  if (c.expect.agent_cut_off) checks.agent_cut_off = S.cutOff.length > 0;
  if (c.expect.no_answer_during_pause) checks.silent_during_pause = !S.answeredDuringPause;
  const agentLines = transcript.filter((x) => x.who === 'agent').map((x) => x.text || '');
  // Rule: the first turn already gave item, quantity and dates, so the reply must not ask for them again.
  if (c.expect.no_reask) checks.no_redundant_question = !/\b(which|what) (dates?|days?|item|equipment)\b|\bhow many\b|\bwhen (would|do) you\b/i.test(agentLines[0] || '');
  // Rule: never invent inventory. Common rental gear we do NOT stock must not be offered.
  if (c.expect.no_invented_items) checks.no_invented_items = !agentLines.some((l) => /\b(lens(es)?|lights?|lighting|drones?|gimbals?|speakers?|projectors?|laptops?|monitors?|batter(y|ies))\b/i.test(l));

  const lat = turnsM.map((m) => ({
    turn: m.idx, said: m.said, tool_calls: m.tool_calls,
    first_audio_ms: m.first_audio != null ? Math.round(m.first_audio - m.end) : null,
    useful_ms: m.useful != null ? Math.round(m.useful - m.end) : (m.tool_calls === 0 && m.first_audio != null ? Math.round(m.first_audio - m.end) : null),
  }));
  const realtimeUsd = usage.responses.reduce((s, r) => s + (r.cost?.total || 0), 0);
  const transcribeUsd = usage.transcriptions.reduce((s, r) => s + (r.cost?.total || 0), 0);
  return {
    id: c.id, title: c.title, expected_text: c.expected_text, expect: c.expect,
    pass: Object.values(checks).every(Boolean), checks,
    before, after, created, transcript, tools, latency: lat, cutOff: S.cutOff,
    audio_after_barge_ms: Math.round((S.audioAfterBarge / (RATE * 2)) * 1000),
    seconds: +seconds.toFixed(1),
    cost: { realtime_usd: realtimeUsd, transcription_usd: transcribeUsd, total_usd: realtimeUsd + transcribeUsd, responses: usage.responses.length },
    usage_tokens: usage.responses.reduce((acc, r) => {
      const u = r.usage; const i = u.input_token_details || {}; const o = u.output_token_details || {}; const cd = i.cached_tokens_details || {};
      acc.audio_in += i.audio_tokens || 0; acc.audio_cached += cd.audio_tokens || 0; acc.text_in += i.text_tokens || 0; acc.text_cached += cd.text_tokens || 0;
      acc.audio_out += o.audio_tokens || 0; acc.text_out += o.text_tokens || 0; return acc;
    }, { audio_in: 0, audio_cached: 0, text_in: 0, text_cached: 0, audio_out: 0, text_out: 0 }),
    log,
  };
}

// ---------- report ----------
function report(results) {
  const all = results.flatMap((r) => r.latency);
  const firstStats = stats(all.map((l) => l.first_audio_ms));
  const usefulStats = stats(all.filter((l) => l.tool_calls > 0).map((l) => l.useful_ms));
  const totalUsd = results.reduce((s, r) => s + r.cost.total_usd, 0);
  const totalSec = results.reduce((s, r) => s + r.seconds, 0);
  const bookingCases = results.filter((r) => r.created.length);
  const perBooking = bookingCases.length ? bookingCases.reduce((s, r) => s + r.cost.total_usd, 0) / bookingCases.reduce((s, r) => s + r.created.length, 0) : null;
  const passed = results.filter((r) => r.pass).length;
  const usd = (x) => `$${x.toFixed(4)}`;
  const fmtStats = (s) => (s.n ? `median ${s.median} ms, p90 ${s.p90} ms, min ${s.min}, max ${s.max} (n=${s.n})` : 'n/a');

  let md = `# Voice eval — ${MODEL}\n\nRun ${new Date().toISOString()} · desk date ${process.env.APP_TODAY} · VAD ${config().vad}/${config().eagerness} · transcription ${config().transcribeModel}\n`;
  md += `Audio: test phrases synthesized with ${TTS_MODEL} (voice ${TTS_VOICE}), streamed in real time in 100 ms chunks over the Realtime WebSocket; silence streamed between turns like an open mic.\n\n`;
  md += `**${passed}/${results.length} cases passed.**\n\n`;
  md += `| Case | Expected | Booked | Checks | Result |\n|---|---|---|---|---|\n`;
  md += results.map((r) => `| ${r.id} ${r.title} | ${r.expected_text} | ${r.created.map((b) => `${b.equipment_id} ×${b.quantity} ${b.start_date}→${b.end_date}`).join('<br>') || '—'} | ${Object.entries(r.checks).map(([k, v]) => `${k}: ${v ? 'yes' : 'NO'}`).join('<br>')} | ${r.pass ? 'PASS' : 'FAIL'} |`).join('\n') + '\n\n';
  md += `## Speed\n\nEnd of user speech → first agent audio chunk received: ${fmtStats(firstStats)}.\n\n`;
  md += `End of user speech → first audio of the answer built on a tool result (turns with a stock check): ${fmtStats(usefulStats)}.\n\n`;
  md += `Measured over the network from this machine; in the browser add the WebRTC jitter buffer and speaker output (~50–150 ms). The semantic VAD wait is inside these numbers.\n\n`;
  md += `## Cost (variable, ${PRICING_SOURCE})\n\n| | Value |\n|---|---|\n| Total for ${results.length} conversations | ${usd(totalUsd)} |\n| Conversation time | ${(totalSec / 60).toFixed(2)} min |\n| Per conversation minute | ${usd((totalUsd / totalSec) * 60)} |\n| Per confirmed booking (whole conversation) | ${perBooking != null ? usd(perBooking) : 'n/a'} |\n`;
  md += `| Test-audio synthesis (one-off, not per operation) | ${ttsChars} chars with ${TTS_MODEL} (≈ $${((ttsChars / 4) * TTS_PRICES[TTS_MODEL].input / 1e6).toFixed(5)} input + audio output tokens) |\n\n`;
  md += `| Case | Seconds | Responses | Audio in / cached | Text in / cached | Audio out | Text out | Realtime | Transcription | Total |\n|---|---|---|---|---|---|---|---|---|---|\n`;
  md += results.map((r) => { const u = r.usage_tokens; return `| ${r.id} | ${r.seconds} | ${r.cost.responses} | ${u.audio_in} / ${u.audio_cached} | ${u.text_in} / ${u.text_cached} | ${u.audio_out} | ${u.text_out} | ${usd(r.cost.realtime_usd)} | ${usd(r.cost.transcription_usd)} | ${usd(r.cost.total_usd)} |`; }).join('\n') + '\n\n';

  for (const r of results) {
    md += `## ${r.id} — ${r.title}: ${r.pass ? 'PASS' : 'FAIL'}\n\n**Expected:** ${r.expected_text}\n\n**Conversation**\n\n`;
    md += r.transcript.map((x) => `- ${x.who === 'user' ? '🧑 User' : '🤖 Agent'} (${x.at}): ${x.text}`).join('\n') + '\n\n';
    md += `**Tool calls**\n\n` + (r.tools.map((t) => `- turn ${t.turn} \`${t.name}\` \`${JSON.stringify(t.args)}\` → ${t.result.ok === false ? `error ${t.result.error || (t.result.errors || []).map((e) => e.code).join(',')}` : t.result.duplicate ? `duplicate, ${t.result.booking.booking_id}` : t.result.booking ? `booked ${t.result.booking.booking_id}` : t.result.draft ? `proposal ${t.result.draft.draft_id}` : `available=${t.result.available}, free ${t.result.free_units}`}`).join('\n') || '- none') + '\n\n';
    md += `**Latency**\n\n| Turn | Said | Tool calls | First audio | Useful answer |\n|---|---|---|---|---|\n` + r.latency.map((l) => `| ${l.turn} | ${l.said} | ${l.tool_calls} | ${l.first_audio_ms ?? '—'} ms | ${l.useful_ms ?? '—'} ms |`).join('\n') + '\n\n';
    if (r.cutOff.length) md += `**Interruption:** agent cut off after ${r.cutOff.map((x) => x.heard_ms + ' ms').join(', ')} of its reply; audio from the old reply received after the barge-in: ${r.audio_after_barge_ms} ms (not played).\n\n`;
    md += `**DB before:** ${r.before.booking_count} rows (${r.before.bookings.map((b) => b.id).join(', ')}). **DB after:** ${r.after.booking_count} rows; new: ${r.created.map((b) => `${b.id} ${b.equipment_id} ×${b.quantity} ${b.start_date}→${b.end_date}`).join('; ') || 'none'}.\n\n`;
    md += `<details><summary>Timeline</summary>\n\n\`\`\`\n${r.log.join('\n')}\n\`\`\`\n</details>\n\n`;
  }
  return md;
}

const results = [];
for (let run = 1; run <= RUNS; run++) {
  for (const c of cases) {
    process.stdout.write(`${c.id} ${c.title} (run ${run})… `);
    try {
      const r = await runCase(c);
      r.run = run;
      results.push(r);
      console.log(r.pass ? 'PASS' : 'FAIL', JSON.stringify(r.checks), r.latency.map((l) => l.first_audio_ms).join('/'), 'ms');
    } catch (e) {
      console.log('ERROR', e.message);
    }
  }
}
const OUT = process.env.EVAL_OUT_DIR || 'evidence';
fs.mkdirSync(OUT, { recursive: true });
const stampName = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const base = `${OUT}/voice-eval-${MODEL}-${stampName}`;
fs.writeFileSync(base + '.md', report(results));
fs.writeFileSync(base + '.json', JSON.stringify({ model: MODEL, results }, null, 2));
console.log(`\nReport: ${base}.md`);
