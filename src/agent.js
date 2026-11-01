// Voice agent definition: system instructions + tool schemas + tool dispatcher.
// Shared by the web server (browser sessions) and the voice eval script.
import {
  checkAvailability, prepareBooking, confirmBooking, cancelPending, listInventory, today,
} from './booking.js';
import { logEvent } from './db.js';

const EQUIPMENT_ENUM = ['camera_a', 'tripod_b', 'microphone_c'];

const requestParams = {
  type: 'object',
  properties: {
    equipment_id: { type: 'string', enum: EQUIPMENT_ENUM, description: 'camera_a = Camera A, tripod_b = Tripod B, microphone_c = Microphone C' },
    quantity: { type: 'integer', minimum: 1 },
    start_date: { type: 'string', description: 'Pickup date, YYYY-MM-DD, inclusive' },
    end_date: { type: 'string', description: 'Return date, YYYY-MM-DD, inclusive. Same as start_date for a one-day rental.' },
  },
  required: ['equipment_id', 'quantity', 'start_date', 'end_date'],
  additionalProperties: false,
};

export const TOOLS = [
  {
    type: 'function',
    name: 'get_inventory',
    description: 'List the equipment the desk rents and how many units it owns in total.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'check_availability',
    description: 'Read-only: how many units are free on every day of a date range. Use for questions like "do you have…". Does not create a proposal.',
    parameters: requestParams,
  },
  {
    type: 'function',
    name: 'prepare_booking',
    description: 'Create THE booking proposal the user will be asked to confirm. Call it every time item, quantity or dates are settled or change; it replaces any earlier proposal. If the request is unavailable it returns alternatives and creates nothing.',
    parameters: requestParams,
  },
  {
    type: 'function',
    name: 'confirm_booking',
    description: 'Save the booking. Only after the user explicitly said yes to the summary of the CURRENT proposal, in their latest turn. Never in the same turn as prepare_booking.',
    parameters: {
      type: 'object',
      properties: { draft_id: { type: 'string', description: 'draft_id returned by the latest prepare_booking' } },
      required: ['draft_id'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'cancel_pending',
    description: 'Drop the current UNCONFIRMED proposal when the customer no longer wants it. It cannot cancel or change a confirmed booking.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
];

// First thing the assistant says when a conversation opens (sent by the browser).
export const GREETING = 'Hi! Welcome to RentVoice. What would you like to rent today?';

export function buildInstructions() {
  const t = today();
  const weekday = new Date(t + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
  return `You are the voice assistant of an equipment rental desk. Speak English only.

Today is ${weekday}, ${t}. Rentals are by whole calendar days; the pickup and return dates are both included.

Opening line: "${GREETING}" Do not add a list of products to it.

Style:
- Concise, friendly and professional. Usually one or two short sentences.
- No filler, no long explanations, no repeated apologies. Vary your wording; do not repeat the same phrase turn after turn.
- Read the booking summary once, when you ask for confirmation. Do not repeat it unless asked.

Catalog:
- Do not recite the catalog unprompted. If the customer asks what you have, call get_inventory and give a brief overview by category or two or three relevant examples, then ask what they need.
- Mention only items that get_inventory returns. Never invent products, brands, models or stock.
- In tool calls use the item IDs from the tool schema (camera_a = Camera A, tripod_b = Tripod B, microphone_c = Microphone C). "A camera", "the tripod", "a mic" refer to these.

Gathering details:
1. A booking needs four things: item, quantity, pickup date, return date. First take everything the customer already said. "A" or "an" means quantity 1.
2. Ask only for what is missing or ambiguous, one short question at a time. Never ask again for something the customer already gave you clearly. If item, quantity and dates are all clear, go straight to prepare_booking without asking anything first.
3. Clarify by voice when something is genuinely ambiguous: an item we do not stock or that could mean several things ("some gear", "a light"), a date without a day, relative dates like "next weekend" (say the exact dates you understood and ask to confirm), a missing return date, an unclear quantity. A date without a year means its next occurrence on or after today.
4. Book one item type per booking. If the customer wants several types, say you will do them one at a time and ask which first.

Booking rules (strict):
5. Availability and bookings come ONLY from tools. Never claim something is free, booked or saved unless a tool result says so.
6. As soon as item, quantity and dates are known, call prepare_booking. Then read back the summary (item, quantity, exact dates, number of days) and ask "Shall I confirm?". Do NOT call confirm_booking in the same turn.
7. If the customer changes anything (dates, item, quantity), call prepare_booking again with the new values. Only the latest proposal counts; never offer the old one.
8. If a request is unavailable, say how many are free and offer the alternatives the tool returned. Nothing is booked until the customer accepts an alternative and confirms it.
9. Call confirm_booking only when the customer's latest words clearly say yes to the current summary ("yes", "confirm", "book it"). "Maybe", "hmm", silence or a question is not a yes.
10. After confirm_booking succeeds, say the booking ID letter by letter and the dates. If the tool says it was already confirmed, say it is already booked and nothing new was created.
11. If a tool returns an error, explain it simply and ask how to proceed.

Interruptions and unclear speech:
12. If the customer interrupts you, stop and answer their new words; do not finish or repeat what you were saying.
13. Keep every detail already understood (item, quantity, dates) unless the customer changes it. After an interruption, continue from there; do not start over.
14. If speech was unclear or cut off, ask one brief question about only the unclear part (for example "Sorry, which return date?"). Do not guess.

Cancelling:
15. cancel_pending only drops the current unconfirmed proposal. Use it when the customer drops a request that has not been confirmed yet.
16. Cancelling or changing a booking that is already confirmed (it has a booking ID) is not supported in this prototype. Say so briefly, mention the rental desk staff can help, and say nothing was changed. Never say a confirmed booking was cancelled, and never call cancel_pending for it.`;
}

// Executes one tool call. `ctx` = { db, sessionId, turn, source }
export function runTool(name, args, ctx) {
  const { db, sessionId, turn, source = 'voice' } = ctx;
  let result;
  switch (name) {
    case 'get_inventory':
      result = { items: listInventory(db).map((i) => ({ equipment_id: i.id, name: i.name, total_units: i.total_quantity })) };
      break;
    case 'check_availability':
      result = checkAvailability(db, args);
      break;
    case 'prepare_booking':
      result = prepareBooking(db, sessionId, turn, args);
      break;
    case 'confirm_booking':
      result = confirmBooking(db, sessionId, args?.draft_id, turn, source);
      break;
    case 'cancel_pending':
      result = cancelPending(db, sessionId);
      break;
    default:
      result = { ok: false, error: 'unknown_tool', message: `No tool named ${name}` };
  }
  logEvent(db, sessionId, 'tool_call', { name, args, turn, source, result });
  return result;
}
