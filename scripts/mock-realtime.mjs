// npm run voice-eval:mock — offline stand-in for the OpenAI Realtime WebSocket + TTS, to exercise the eval's
// control flow (VAD events, tool round-trips, barge-in, usage, report). Not a model.
import http from 'node:http';
import { WebSocketServer } from 'ws';

const RATE = 24000;
const server = http.createServer((req, res) => {
  if (req.url.endsWith('/realtime/client_secrets')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ value: 'ek_mock', expires_at: 0 })); }
  // TTS mock: 1.2 s of a 200 Hz tone as PCM16
  const n = RATE * 1.2, b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 200 * i) / RATE) * 8000), i * 2);
  res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(b);
});
const wss = new WebSocketServer({ server });
let rid = 0;
wss.on('connection', (ws) => {
  const send = (e) => ws.readyState === 1 && ws.send(JSON.stringify(e));
  let speaking = false, silentMs = 0, utt = 0, lastDraft = null, active = null;
  const usage = { total_tokens: 300, input_tokens: 250, output_tokens: 50, input_token_details: { text_tokens: 200, audio_tokens: 50, cached_tokens: 100, cached_tokens_details: { text_tokens: 100, audio_tokens: 0 } }, output_token_details: { text_tokens: 10, audio_tokens: 40 } };

  function speakResponse(text) {
    const id = 'resp_' + ++rid, item = 'item_' + rid;
    active = { id, cancelled: false };
    const me = active;
    send({ type: 'response.created', response: { id } });
    let k = 0;
    const iv = setInterval(() => {
      if (me.cancelled || k >= 20) {
        clearInterval(iv);
        if (!me.cancelled) send({ type: 'response.output_audio_transcript.done', response_id: id, item_id: item, transcript: text });
        send({ type: 'response.done', response: { id, status: me.cancelled ? 'cancelled' : 'completed', output: [], usage } });
        if (active === me) active = null;
        return;
      }
      send({ type: 'response.output_audio.delta', response_id: id, item_id: item, delta: Buffer.alloc(4800).toString('base64') }); // 100 ms
      k++;
    }, 50);
  }
  function toolResponse(name, args) {
    const id = 'resp_' + ++rid;
    send({ type: 'response.created', response: { id } });
    setTimeout(() => send({ type: 'response.done', response: { id, status: 'completed', output: [{ type: 'function_call', name, call_id: 'call_' + rid, arguments: JSON.stringify(args) }], usage } }), 150);
  }
  ws.on('message', (raw) => {
    const ev = JSON.parse(raw);
    if (ev.type === 'session.update') send({ type: 'session.updated' });
    if (ev.type === 'input_audio_buffer.append') {
      const b = Buffer.from(ev.audio, 'base64'); let loud = false;
      for (let i = 0; i < b.length; i += 2) if (Math.abs(b.readInt16LE(i)) > 1000) { loud = true; break; }
      if (loud) {
        silentMs = 0;
        if (!speaking) { speaking = true; send({ type: 'input_audio_buffer.speech_started' }); if (active) active.cancelled = true; }
      } else if (speaking && (silentMs += 100) >= 500) {
        speaking = false; utt++;
        send({ type: 'input_audio_buffer.speech_stopped' });
        send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u' + utt, transcript: `(mock utterance ${utt})`, usage: { type: 'tokens', input_tokens: 20, output_tokens: 8 } });
        // Script: utterance 1 → propose; later utterances → confirm the last proposal.
        if (utt === 1) toolResponse('prepare_booking', { equipment_id: 'camera_a', quantity: 1, start_date: '2026-11-05', end_date: '2026-11-06' });
        else if (process.env.MOCK_MODE === 'barge' && utt === 2) toolResponse('prepare_booking', { equipment_id: 'tripod_b', quantity: 1, start_date: '2026-11-10', end_date: '2026-11-11' });
        else toolResponse('confirm_booking', { draft_id: lastDraft });
      }
    }
    if (ev.type === 'conversation.item.create' && ev.item.type === 'function_call_output') {
      const out = JSON.parse(ev.item.output); if (out.draft) lastDraft = out.draft.draft_id;
    }
    if (ev.type === 'response.create') speakResponse('Mock answer about the booking?');
    if (ev.type === 'response.cancel' && active) active.cancelled = true;
  });
});
server.listen(8787, () => console.log('mock on 8787'));
const ix = process.argv.indexOf('--exit-after');
if (ix > 0) setTimeout(() => process.exit(0), Number(process.argv[ix + 1]) * 1000);
