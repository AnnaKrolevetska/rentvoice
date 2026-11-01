// Browser side of the voice agent.
// Audio goes straight between the browser and OpenAI Realtime over WebRTC.
// Tool calls arrive on the data channel; we execute them on OUR server
// (which owns the database) and hand the results back to the model.

import { availabilityLabel } from './stock-label.js';

const $ = (id) => document.getElementById(id);
const S = {
  sessionId: null, model: null, pc: null, dc: null, mic: null,
  turn: 0,                       // user-turn counter (incremented when the user starts speaking)
  responseTurn: new Map(),       // response_id -> user turn when the response was created
  postTool: new Set(),           // responses we created after returning tool results
  pendingPostTool: false,
  userSpeaking: false,
  speakingResponse: null,        // response_id whose audio is playing
  agentBubbles: new Map(),       // response_id -> <li>
  userBubbles: new Map(),        // item_id -> <li>
  turnM: null,                   // latency record for the current user turn
  lastVoiceAt: 0,                // last time the mic level was above the speech threshold
  startedAt: 0,
  passcode: '',
  freshBookings: new Set(),
  draft: null,
  toolCount: 0,
  lastRange: null,               // dates of the latest availability/proposal request
  lastRequest: null,             // { equipment_id, quantity } when that request did not fit
};

// ---------- small helpers ----------
const now = () => performance.now();
async function api(url, body) {
  const opts = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-demo-passcode': S.passcode }, body: JSON.stringify(body) };
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { detail: j });
  return j;
}
const send = (ev) => { if (S.dc?.readyState === 'open') S.dc.send(JSON.stringify(ev)); };
const metric = (kind, payload) => S.sessionId && api('/api/metrics', { sessionId: S.sessionId, kind, payload }).catch(() => {});

const STATUS_TEXT = {
  idle: 'Ready when you are',
  connecting: 'Connecting…',
  ready: 'Listening — go ahead',
  listening: 'Hearing you…',
  thinking: 'Thinking…',
  checking: 'Checking availability…',
  speaking: 'Assistant is speaking — you can cut in',
  confirming: 'Waiting for your yes',
  booked: 'Booked',
  error: 'Something went wrong',
};
function setStatus(state, text) {
  $('status').dataset.state = state;
  $('voice').dataset.state = state;
  $('status-text').textContent = text || STATUS_TEXT[state];
}
// Header connection chip mirrors the WebRTC session.
function setConn(state) {
  const label = { offline: 'Offline', connecting: 'Connecting', live: 'Live', error: 'Connection failed' }[state];
  $('conn').dataset.conn = state;
  $('conn-text').textContent = state === 'live' && S.model ? `Live · ${S.model}` : label;
  $('voice').classList.toggle('live', state === 'live');
}
function idleStatus() {
  if (!S.pc) return setStatus('idle');
  if (S.draft?.status === 'pending') return setStatus('confirming');
  if (S.draft?.status === 'confirmed') return setStatus('booked', `Booked ${S.draft.booking_id}. Anything else?`);
  setStatus('ready');
}

// ---------- transcript ----------
// Each turn: <li class="user|agent|system"><span class="who">You</span><span class="msg">…</span></li>
// Assistant text is marked "streaming" while it is still being spoken, "cut" if it was
// interrupted, and becomes plain only when the full reply has finished.
const WHO = { user: 'You', agent: 'Assistant' };
const nearBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 80;
function stickToBottom(wasNear) {
  const box = $('transcript');
  if (wasNear) box.scrollTop = box.scrollHeight; // only follow if the reader hasn't scrolled up
}
function bubble(cls, text) {
  const box = $('transcript');
  const wasNear = nearBottom(box);
  const hint = box.querySelector('.hint');
  if (hint) hint.remove();
  const li = document.createElement('li');
  li.className = cls;
  const role = cls.split(' ')[0];
  if (WHO[role]) li.append(Object.assign(document.createElement('span'), { className: 'who', textContent: WHO[role] }));
  li.append(Object.assign(document.createElement('span'), { className: 'msg', textContent: text }));
  box.append(li);
  $('btn-copy-transcript').disabled = false;
  stickToBottom(wasNear || hint);
  return li;
}
function setMsg(li, text, append = false) {
  const box = $('transcript');
  const wasNear = nearBottom(box);
  const m = li.querySelector('.msg');
  m.textContent = append ? m.textContent + text : text;
  stickToBottom(wasNear);
}
function userBubble(itemId) {
  if (!S.userBubbles.has(itemId)) S.userBubbles.set(itemId, bubble('user pending', '…'));
  return S.userBubbles.get(itemId);
}
function agentBubble(responseId) {
  if (!S.agentBubbles.has(responseId)) S.agentBubbles.set(responseId, bubble('agent streaming', ''));
  return S.agentBubbles.get(responseId);
}
function markInterrupted(responseId) {
  const li = S.agentBubbles.get(responseId);
  if (li && li.classList.contains('streaming')) { li.classList.remove('streaming'); li.classList.add('cut'); }
}
function transcriptText() {
  const lines = [...$('transcript').querySelectorAll('li:not(.hint)')].map((li) => {
    const who = li.querySelector('.who')?.textContent || 'System';
    const msg = li.querySelector('.msg')?.textContent.trim() || '';
    const tag = li.classList.contains('cut') ? ' [interrupted]' : li.classList.contains('streaming') ? ' [in progress]' : '';
    return `${who}: ${msg}${tag}`;
  });
  return [`RentVoice transcript${S.sessionId ? ` · session ${S.sessionId}` : ''} · ${new Date().toISOString()}`, ...lines].join('\n');
}
function logTool(name, args, result) {
  S.toolCount++;
  $('toolcount').textContent = S.toolCount;
  const li = document.createElement('li');
  const short = { ...result }; delete short.overlapping_bookings;
  li.innerHTML = `<b>${name}</b> <code>${escapeHtml(JSON.stringify(args))}</code> → <code>${escapeHtml(JSON.stringify(short))}</code>`;
  $('toollog').append(li);
}
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- live waveform + latency probes ----------
// The waveform is driven by the REAL mic and agent audio levels (no fake animation).
const level = { you: 0, agent: 0 };
function paintMeter(who, rms) {
  // Smooth: rise fast, fall slowly.
  const v = Math.min(1, Math.sqrt(rms) * 2.4);
  level[who] = v > level[who] ? v : level[who] * 0.86 + v * 0.14;
}
const wave = (() => {
  const cv = $('wave'), ctx = cv.getContext('2d');
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let t = 0;
  function resize() {
    const r = cv.getBoundingClientRect(), d = devicePixelRatio || 1;
    cv.width = Math.max(1, r.width * d); cv.height = Math.max(1, r.height * d);
    ctx.setTransform(d, 0, 0, d, 0, 0);
  }
  addEventListener('resize', resize);
  resize();
  function line(w, h, amp, freq, phase, color, alpha, width) {
    ctx.beginPath();
    for (let x = 0; x <= w; x += 2) {
      const k = x / w;
      const env = Math.pow(Math.sin(Math.PI * k), 2.2); // taper at both ends
      const y = h / 2 + Math.sin(k * Math.PI * freq + phase) * amp * env + Math.sin(k * Math.PI * freq * 2.3 - phase * 1.4) * amp * 0.35 * env;
      x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.strokeStyle = color; ctx.globalAlpha = alpha; ctx.lineWidth = width; ctx.stroke(); ctx.globalAlpha = 1;
  }
  function frame() {
    const r = cv.getBoundingClientRect(), w = r.width, h = r.height;
    ctx.clearRect(0, 0, w, h);
    const live = !!S.pc;
    if (!reduce) t += 0.035 + (level.you + level.agent) * 0.12;
    const base = live ? 3 : 1.5;
    const you = css('--you'), agent = css('--accent'), quiet = css('--line-2');
    // Faint baseline
    line(w, h, 0, 1, 0, quiet, 1, 1);
    // User voice (cool blue) and assistant voice (purple), each from its own audio level.
    const ya = base + level.you * h * 0.42, aa = base + level.agent * h * 0.42;
    line(w, h, ya, 3, t * 1.1, you, 0.35, 6);
    line(w, h, ya * 0.7, 4, -t, you, 0.9, 2);
    line(w, h, aa, 2.6, t * 0.9 + 1, agent, 0.25, 8);
    line(w, h, aa * 0.8, 3.4, t * 1.3 + 2, agent, 0.95, 2.4);
    if (!live) { level.you *= 0.9; level.agent *= 0.9; }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  return { resize };
})();
function rmsProbe(stream, ctx) {
  const src = ctx.createMediaStreamSource(stream);
  const an = ctx.createAnalyser();
  an.fftSize = 512;
  src.connect(an);
  const buf = new Float32Array(an.fftSize);
  return () => { an.getFloatTimeDomainData(buf); let s = 0; for (const v of buf) s += v * v; return Math.sqrt(s / buf.length); };
}
let probeTimer = null;
const SPEECH_RMS = 0.015; // empirically: quiet room noise < 0.005, speech > 0.03
function startProbes(micStream, agentStream) {
  const ctx = new AudioContext();
  const mic = rmsProbe(micStream, ctx);
  const agent = rmsProbe(agentStream, ctx);
  let frame = 0;
  probeTimer = setInterval(() => {
    const m = mic(), a = agent(), t = now();
    if (m > SPEECH_RMS) S.lastVoiceAt = t;
    // First audible agent sound after the user's turn ended.
    if (a > SPEECH_RMS && S.turnM && S.speakingResponse) {
      if (S.turnM.first_audible == null) S.turnM.first_audible = t;
      if (S.turnM.useful == null && S.postTool.has(S.speakingResponse)) S.turnM.useful = t;
    }
    if (++frame % 2 === 0) { paintMeter('you', m); paintMeter('agent', a); }
  }, 10);
  return ctx;
}

function finishTurnMetrics(reason) {
  const m = S.turnM;
  if (!m || m.sent) return;
  m.sent = true;
  if (m.first_audible == null) return; // the agent never answered audibly (e.g. user cut in at once)
  const useful = m.useful ?? (m.tool_calls === 0 ? m.first_audible : null);
  const rec = {
    turn: m.turn,
    first_audible_ms: Math.round(m.first_audible - m.end_of_speech),
    useful_answer_ms: useful != null ? Math.round(useful - m.end_of_speech) : null,
    vad_wait_ms: Math.round(m.speech_stopped_at - m.end_of_speech),
    tool_calls: m.tool_calls,
    finished_by: reason,
  };
  metric('latency', rec);
  $('m-last').textContent = `${rec.first_audible_ms} ms`;
  setTimeout(refreshMetrics, 300);
}

// ---------- realtime events ----------
function onEvent(ev) {
  switch (ev.type) {
    case 'input_audio_buffer.speech_started': {
      finishTurnMetrics('next_turn');
      S.turn++;
      S.userSpeaking = true;
      if (S.speakingResponse) {
        // Barge-in: the server also cancels (interrupt_response), we clear local playback at once.
        markInterrupted(S.speakingResponse);
        send({ type: 'response.cancel' });
        send({ type: 'output_audio_buffer.clear' });
        S.speakingResponse = null;
      }
      setStatus('listening');
      break;
    }
    case 'input_audio_buffer.speech_stopped': {
      S.userSpeaking = false;
      const t = now();
      // End of the user's turn = last moment the mic carried speech energy.
      const end = S.lastVoiceAt && t - S.lastVoiceAt < 3000 ? S.lastVoiceAt : t;
      S.turnM = { turn: S.turn, end_of_speech: end, speech_stopped_at: t, first_audible: null, useful: null, tool_calls: 0 };
      setStatus('thinking');
      break;
    }
    case 'input_audio_buffer.committed':
      userBubble(ev.item_id);
      break;
    case 'conversation.item.input_audio_transcription.completed': {
      const li = userBubble(ev.item_id);
      li.classList.remove('pending');
      setMsg(li, ev.transcript?.trim() || '(unclear speech)');
      if (ev.usage) metric('transcription_usage', { usage: ev.usage });
      break;
    }
    case 'conversation.item.input_audio_transcription.failed':
      { const li = userBubble(ev.item_id); li.classList.remove('pending'); setMsg(li, '(could not transcribe)'); }
      break;
    case 'response.created':
      S.responseTurn.set(ev.response.id, S.turn);
      if (S.pendingPostTool) { S.postTool.add(ev.response.id); S.pendingPostTool = false; }
      break;
    case 'response.output_audio_transcript.delta':
      setMsg(agentBubble(ev.response_id), ev.delta, true);
      break;
    case 'response.output_audio_transcript.done': {
      // Full text of a reply that was spoken to the end.
      const li = agentBubble(ev.response_id);
      if (!li.classList.contains('cut')) { li.classList.remove('streaming'); if (ev.transcript) setMsg(li, ev.transcript); }
      break;
    }
    case 'output_audio_buffer.started':
      S.speakingResponse = ev.response_id;
      setStatus('speaking');
      break;
    case 'output_audio_buffer.stopped':
    case 'output_audio_buffer.cleared':
      if (!ev.response_id || ev.response_id === S.speakingResponse) S.speakingResponse = null;
      if (!S.userSpeaking) idleStatus();
      break;
    case 'response.done':
      if (ev.response?.status && ev.response.status !== 'completed') markInterrupted(ev.response.id);
      onResponseDone(ev.response);
      break;
    case 'error':
      // Cancelling when nothing is playing is expected after a barge-in.
      if (/cancel|not active|no active|buffer/i.test(ev.error?.code || '') ) break;
      console.warn('Realtime error', ev.error);
      bubble('system', `Error: ${ev.error?.message || 'unknown'}`);
      break;
  }
}

async function onResponseDone(resp) {
  if (resp.usage) metric('usage', { usage: resp.usage, model: S.model, response_id: resp.id, status: resp.status });
  const calls = (resp.output || []).filter((o) => o.type === 'function_call');
  if (!calls.length) {
    // A spoken answer with no tool calls ends the turn once it is heard.
    if (resp.status === 'completed') setTimeout(() => finishTurnMetrics('answered'), 1500);
    return;
  }
  const turn = S.responseTurn.get(resp.id) ?? S.turn;
  if (S.turnM) S.turnM.tool_calls += calls.length;
  setStatus('checking');
  for (const c of calls) {
    let result;
    if (resp.status !== 'completed') {
      // The user interrupted this response: do NOT act on its tool calls.
      result = { ok: false, error: 'interrupted', message: 'The user interrupted; this call was not executed. Follow their latest words.' };
    } else {
      let args = {};
      try { args = JSON.parse(c.arguments || '{}'); } catch { /* keep {} */ }
      try { result = await api('/api/tool', { sessionId: S.sessionId, name: c.name, args, turn }); }
      catch (e) { result = { ok: false, error: 'server_error', message: e.message }; }
      logTool(c.name, args, result);
      rememberRequest(c.name, args, result);
    }
    send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: c.call_id, output: JSON.stringify(result) } });
  }
  await refreshState();
  // Speak the result only if the user has not started a newer turn meanwhile;
  // otherwise their new turn produces the next answer (never talk over them).
  if (!S.userSpeaking && turn === S.turn) {
    S.pendingPostTool = true;
    send({ type: 'response.create' });
  } else {
    idleStatus();
  }
}

// ---------- connect / disconnect ----------
async function start() {
  $('btn-start').disabled = true;
  $('mic-label').textContent = 'Connecting…';
  setStatus('connecting');
  setConn('connecting');
  try {
    const cfg = await api('/api/config');
    if (cfg.passcodeRequired && !S.passcode) {
      S.passcode = prompt('Demo passcode') || '';
    }
    const session = await api('/api/session', {});
    S.sessionId = session.sessionId; S.model = session.model;

    const pc = new RTCPeerConnection();
    S.pc = pc;
    const audioEl = $('agent-audio');
    const agentStream = new Promise((resolve) => { pc.ontrack = (e) => { audioEl.srcObject = e.streams[0]; resolve(e.streams[0]); }; });

    S.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    pc.addTrack(S.mic.getAudioTracks()[0], S.mic);

    const dc = pc.createDataChannel('oai-events');
    S.dc = dc;
    dc.onmessage = (m) => { try { onEvent(JSON.parse(m.data)); } catch (e) { console.error(e); } };
    dc.onopen = () => {
      S.startedAt = Date.now();
      // Short spoken greeting so the user knows the line is open.
      const greeting = session.greeting || 'Hi! Welcome to RentVoice. What would you like to rent today?';
      send({ type: 'response.create', response: { instructions: `Say exactly this and nothing else: "${greeting}"` } });
      idleStatus();
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const r = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST', body: offer.sdp,
      headers: { Authorization: `Bearer ${session.clientSecret}`, 'Content-Type': 'application/sdp' },
    });
    if (!r.ok) throw new Error(`OpenAI rejected the call (${r.status}): ${await r.text()}`);
    await pc.setRemoteDescription({ type: 'answer', sdp: await r.text() });

    S.audioCtx = startProbes(S.mic, await agentStream);
    $('btn-stop').hidden = false;
    setConn('live');
    $('voice-sub').textContent = 'Speak naturally. Pause, correct yourself, or cut in whenever you like.';
    $('m-model').textContent = `Voice model: ${S.model}`;
    pc.onconnectionstatechange = () => { if (['failed', 'disconnected'].includes(pc.connectionState)) { bubble('system', 'Connection lost.'); stop(); } };
    refreshState();
  } catch (e) {
    console.error(e);
    setStatus('error', e.detail?.error === 'passcode_required' ? 'Wrong demo passcode' : `Could not start: ${e.message}`);
    if (e.detail?.detail) bubble('system', JSON.stringify(e.detail.detail).slice(0, 300));
    cleanup();
    setConn('error');
    $('btn-start').disabled = false;
    $('mic-label').textContent = 'Try again';
  }
}

function cleanup() {
  clearInterval(probeTimer);
  S.audioCtx?.close().catch(() => {});
  S.mic?.getTracks().forEach((t) => t.stop());
  S.dc?.close(); S.pc?.close();
  S.pc = S.dc = S.mic = null;
  level.you = level.agent = 0;
}

function stop() {
  finishTurnMetrics('end');
  if (S.startedAt) metric('session', { event: 'end', seconds: (Date.now() - S.startedAt) / 1000 });
  S.startedAt = 0;
  cleanup();
  $('btn-stop').hidden = true; $('btn-start').disabled = false;
  $('mic-label').textContent = 'Start a new conversation';
  setConn('offline');
  setStatus('idle', 'Conversation ended');
  setTimeout(refreshMetrics, 400);
}

// ---------- screen state ----------
async function refreshState() {
  const qs = new URLSearchParams();
  if (S.sessionId) qs.set('sessionId', S.sessionId);
  if (S.lastRange) { qs.set('start', S.lastRange.start); qs.set('end', S.lastRange.end); }
  const st = await api(`/api/state${qs.toString() ? `?${qs}` : ''}`);
  S.draft = st.draft;
  if (st.lastBookingId) S.freshBookings.add(st.lastBookingId);
  renderTicket(st.draft);
  renderStock(st.stock);
  renderDb(st.db);
  $('today').textContent = `Desk date ${fmtDate(st.today, true)}`;
}

const ICON = { camera_a: 'i-camera', tripod_b: 'i-tripod', microphone_c: 'i-mic' };
const icon = (id, cls = 'ico') => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;
const fmtDate = (iso, year = false) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : { weekday: 'short' }), timeZone: 'UTC' });

// Copy helper with a visible + screen-reader confirmation.
async function copyText(text, button, label) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  const msg = ok ? 'Copied!' : 'Copy failed';
  button.querySelector('.copy-label').textContent = msg;
  button.classList.toggle('copied', ok);
  $('sr-live').textContent = ok ? `${label} copied to clipboard` : `Could not copy ${label}`;
  clearTimeout(button._t);
  button._t = setTimeout(() => { button.querySelector('.copy-label').textContent = button.dataset.label; button.classList.remove('copied'); }, 2000);
}

function renderTicket(d) {
  const t = $('ticket'), body = $('ticket-body'), badge = $('ticket-badge');
  if (!d) {
    t.dataset.state = 'empty';
    badge.textContent = 'No request yet';
    body.innerHTML = `<div class="empty"><div class="empty-ico">${icon('i-calendar')}</div>
      <p>Tell the assistant what you need and for which dates. The details will appear here before anything is booked.</p></div>`;
    return;
  }
  t.dataset.state = d.status;
  const confirmed = d.status === 'confirmed';
  badge.innerHTML = confirmed ? `${icon('i-check')}Confirmed` : 'Not booked yet';
  const days = `${d.rental_days} day${d.rental_days > 1 ? 's' : ''}`;
  const stock = d.free_for_dates != null
    ? `<div class="bk-meta"><span>${confirmed ? 'Remaining for these dates' : 'Available for these dates'}</span><strong>${d.free_for_dates} of ${d.total_units}</strong></div>` : '';
  const core = `
    <div class="bk-item"><div class="bk-icon">${icon(ICON[d.equipment_id] || 'i-camera')}</div>
      <div><div class="bk-name">${d.equipment}</div><div class="bk-qty">Quantity ${d.quantity}</div></div></div>
    <div class="bk-dates">
      <div class="bk-date"><span>Pickup</span><strong>${fmtDate(d.start_date)}</strong></div>
      <div class="bk-arrow">${icon('i-arrow')}</div>
      <div class="bk-date"><span>Return</span><strong>${fmtDate(d.end_date)}</strong></div>
    </div>
    <div class="bk-meta"><span>Rental length</span><strong>${days}, both dates included</strong></div>
    ${stock}`;
  if (confirmed) {
    // booking_id comes from the database row (via /api/state), never generated here.
    body.innerHTML = `${core}
      <div class="bk-id"><span>${icon('i-check')} Saved · Booking ID</span><strong id="bk-id-value">${d.booking_id}</strong></div>
      <button class="btn btn-ghost btn-block btn-copy" id="btn-copy-id" data-label="Copy booking ID">${icon('i-copy')}<span class="copy-label">Copy booking ID</span></button>`;
    $('btn-copy-id').onclick = (e) => copyText(d.booking_id, e.currentTarget, 'Booking ID');
  } else {
    body.innerHTML = `<p class="bk-pending-note">${icon('i-clock')}Proposal only — nothing is saved until you confirm.</p>${core}
      <button class="btn btn-primary btn-block" id="btn-confirm">${icon('i-check')}Confirm booking</button>
      <p class="bk-hint">Or just say “yes”.</p>`;
    $('btn-confirm').onclick = () => confirmByButton(d.draft_id);
  }
}

async function confirmByButton(draftId) {
  $('btn-confirm').disabled = true;
  const res = await api('/api/confirm', { sessionId: S.sessionId, draftId }).catch((e) => ({ ok: false, message: e.message }));
  logTool('confirm_booking (button)', { draft_id: draftId }, res);
  await refreshState();
  // Tell the agent what happened so the conversation stays consistent.
  const note = res.ok
    ? `The customer pressed the Confirm button. Booking ${res.booking.booking_id} is saved${res.duplicate ? ' (it was already saved before; nothing new)' : ''}. Acknowledge briefly.`
    : `The customer pressed Confirm but it failed: ${res.message}. Explain briefly.`;
  send({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: note }] } });
  if (!S.userSpeaking && !S.speakingResponse) send({ type: 'response.create' });
}

// Keep the stock panel on the dates the user actually asked about, even when the
// request did not fit (an unavailable request creates no proposal).
function rememberRequest(name, args, result) {
  if (!['check_availability', 'prepare_booking'].includes(name) || !result?.ok) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.start_date || '') || !/^\d{4}-\d{2}-\d{2}$/.test(args.end_date || '')) return;
  S.lastRange = { start: args.start_date, end: args.end_date };
  S.lastRequest = result.available === false ? { equipment_id: args.equipment_id, quantity: args.quantity } : null;
}

function renderStock(stock) {
  $('stock-dates').textContent = availabilityLabel(stock, !!(S.draft || S.lastRange));
  $('stock-list').innerHTML = stock.items.map((i) => {
    // Purple bars = units free on EVERY day of the range (server: busiest day).
    const units = Array.from({ length: i.total }, (_, k) => `<span class="unit${k < i.available ? ' free' : ''}"></span>`).join('');
    const inDraft = S.draft && S.draft.equipment_id === i.equipment_id && S.draft.status === 'pending';
    const asked = !inDraft && stock.source === 'request' && S.lastRequest?.equipment_id === i.equipment_id;
    const want = inDraft ? S.draft.quantity : asked ? S.lastRequest.quantity : 0;
    const short = want > i.available;
    const cls = i.available === 0 ? 'none' : i.available < i.total ? 'low' : 'ok';
    const label = { none: 'Fully booked', low: 'Limited', ok: 'Available' }[cls];
    const note = short ? `You asked for ${want} · ${i.available === 0 ? 'none' : `only ${i.available}`} available`
      : inDraft ? `${want} in your request`
      : i.available === 0 ? 'All units booked for these dates'
      : i.booked === 0 ? (i.total === 1 ? 'Available for these dates' : 'All units available for these dates')
      : `${i.booked} booked · ${i.available} still available`;
    const a11y = `${i.name}: ${i.available} available / ${i.total} total`;
    return `<li class="stock-card${inDraft || asked ? ' selected' : ''}${short ? ' short' : ''}" aria-label="${a11y}">
      <div class="sc-top"><div class="sc-icon">${icon(ICON[i.equipment_id] || 'i-camera')}</div><span class="sc-status ${cls}">${label}</span></div>
      <div class="sc-body"><div class="sc-name">${i.name}</div><div class="sc-count">${i.available} <small>available <span class="sep">/</span> ${i.total} total</small></div></div>
      <div class="units" role="img" aria-label="${i.available} available / ${i.total} total">${units}</div>
      <div class="sc-note">${note}</div></li>`;
  }).join('');
}

const fmtShort = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
// "10–12 Nov" within one month, "30 Nov – 2 Dec" across months.
const fmtSpan = (a, z) => a.slice(0, 7) === z.slice(0, 7)
  ? `${Number(a.slice(8))}–${fmtShort(z)}` : `${fmtShort(a)} – ${fmtShort(z)}`;
function renderDb(db) {
  $('db-count').textContent = db.booking_count;
  const name = (id) => ({ camera_a: 'Camera A', tripod_b: 'Tripod B', microphone_c: 'Microphone C' }[id] || id);
  $('db-rows').innerHTML = db.bookings.map((b) => {
    const fresh = S.freshBookings.has(b.id);
    const tag = fresh ? '<span class="new-tag">NEW</span>' : b.id.startsWith('BK-SEED') ? '<span class="seed-tag">seed</span>' : '';
    return `<tr class="${fresh ? 'fresh' : ''}"><td>${b.id}${tag}</td><td>${name(b.equipment_id)}</td><td>${b.quantity}</td><td class="dates" title="${b.start_date} → ${b.end_date} (inclusive)">${fmtSpan(b.start_date, b.end_date)}</td></tr>`;
  }).join('');
}

async function refreshMetrics() {
  const all = await api('/api/metrics').catch(() => null);
  if (!all) return;
  const f = (s) => (s?.n ? `${s.median} ms <small>n=${s.n}</small>` : '—');
  $('m-median').innerHTML = f(all.latency.first_audible_ms);
  $('m-useful').innerHTML = f(all.latency.useful_answer_ms);
  $('m-permin').textContent = all.cost.usd_per_conversation_minute != null ? `≈ $${all.cost.usd_per_conversation_minute.toFixed(3)}` : '—';
  const mine = all.cost.sessions.find((s) => s.sessionId === S.sessionId);
  if (mine) $('m-cost').textContent = `≈ $${mine.totalUsd.toFixed(4)}`;
}

// Record the conversation length even if the tab is closed mid-call.
window.addEventListener('pagehide', () => {
  if (!S.startedAt || !S.sessionId) return;
  const body = JSON.stringify({ sessionId: S.sessionId, kind: 'session', payload: { event: 'end', seconds: (Date.now() - S.startedAt) / 1000 } });
  navigator.sendBeacon('/api/metrics', new Blob([body], { type: 'application/json' }));
});

$('btn-copy-transcript').onclick = (e) => copyText(transcriptText(), e.currentTarget, 'Transcript');
$('btn-start').onclick = start;
$('btn-stop').onclick = stop;
$('btn-reset').onclick = async () => {
  if (!confirm(`Reset ${S.dbName || 'the database'} to the test seed?\n\nEvery booking except the seeded Camera A (10–12 Oct 2026) will be removed. A backup copy is saved first in data/backups/.`)) return;
  const r = await api('/api/reset', {}).catch((e) => ({ ok: false, error: e.message }));
  S.freshBookings.clear();
  S.lastRange = S.lastRequest = null;
  $('db-note').textContent = r.ok ? `Reset done. Backup saved: ${r.backup || '(none)'}` : `Reset failed: ${r.error}`;
  refreshState();
};
// Which database file this server uses (e.g. rentvoice.db, or test-run.db for recordings).
api('/api/config').then((c) => {
  S.dbName = c.database;
  if (c.database) $('db-note').textContent = `Database file: ${c.database}`;
}).catch(() => {});
// ?session=<id> reopens the screen state of an earlier conversation (read-only view).
S.sessionId = new URLSearchParams(location.search).get('session');
refreshState();
refreshMetrics();
