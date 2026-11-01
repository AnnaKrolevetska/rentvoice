// Conversational rules given to the voice model (src/agent.js).
// The model's speech itself is checked by `npm run voice-eval`; these tests pin
// down what the model is told, so a prompt edit cannot silently drop a rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.APP_TODAY = '2026-10-01';
const { GREETING, buildInstructions, TOOLS } = await import('../src/agent.js');
const { sessionConfig } = await import('../src/realtime-config.js');
const text = buildInstructions();

test('greeting is the short welcome and lists no products', () => {
  assert.equal(GREETING, 'Hi! Welcome to RentVoice. What would you like to rent today?');
  assert.doesNotMatch(GREETING, /camera|tripod|microphone|mic\b/i);
  assert.ok(text.includes(`"${GREETING}"`), 'instructions carry the exact opening line');
  assert.match(text, /Do not add a list of products/);
});

test('browser speaks the greeting it receives from the server', () => {
  const app = fs.readFileSync('public/app.js', 'utf8');
  const server = fs.readFileSync('src/server.js', 'utf8');
  assert.match(server, /greeting: GREETING/);
  assert.match(app, /session\.greeting/);
  assert.ok(app.includes(GREETING), 'fallback greeting matches');
  assert.doesNotMatch(app, /ask what equipment and dates they need/); // old greeting removed
});

test('catalog: no unprompted listing, overview on request, never invent inventory', () => {
  assert.match(text, /Do not recite the catalog unprompted/);
  assert.match(text, /call get_inventory and give a brief overview by category or two or three relevant examples/);
  assert.match(text, /Mention only items that get_inventory returns\. Never invent/);
});

test('no redundant questions: use what was said, ask only for missing or ambiguous details', () => {
  assert.match(text, /First take everything the customer already said/);
  assert.match(text, /Ask only for what is missing or ambiguous/);
  assert.match(text, /Never ask again for something the customer already gave you clearly/);
  assert.match(text, /go straight to prepare_booking without asking anything first/);
});

test('concise, natural style', () => {
  assert.match(text, /Concise, friendly and professional/);
  assert.match(text, /one or two short sentences/);
  assert.match(text, /do not repeat the same phrase/);
});

test('interruptions and unclear speech keep known details and ask briefly', () => {
  assert.match(text, /If the customer interrupts you, stop and answer their new words/);
  assert.match(text, /Keep every detail already understood/);
  assert.match(text, /ask one brief question about only the unclear part/);
});

test('booking-safety rules are still in the instructions', () => {
  for (const rule of [
    /Availability and bookings come ONLY from tools/,
    /Do NOT call confirm_booking in the same turn/,
    /call prepare_booking again with the new values\. Only the latest proposal counts/,
    /Nothing is booked until the customer accepts an alternative and confirms it/,
    /Call confirm_booking only when the customer's latest words clearly say yes/,
    /nothing new was created/,
    /the pickup and return dates are both included/,
  ]) assert.match(text, rule);
});

test('tools and session wiring are unchanged', () => {
  assert.deepEqual(TOOLS.map((t) => t.name), ['get_inventory', 'check_availability', 'prepare_booking', 'confirm_booking', 'cancel_pending']);
  const s = sessionConfig();
  assert.equal(s.instructions, text);
  assert.equal(s.tools, TOOLS);
  assert.equal(s.audio.input.turn_detection.interrupt_response, true);
});

test('cancelling: pending proposal vs confirmed booking', () => {
  assert.match(text, /cancel_pending only drops the current unconfirmed proposal/);
  assert.match(text, /Cancelling or changing a booking that is already confirmed .* is not supported in this prototype/);
  assert.match(text, /Never say a confirmed booking was cancelled/);
  const tool = TOOLS.find((t) => t.name === 'cancel_pending');
  assert.match(tool.description, /cannot cancel or change a confirmed booking/);
});
