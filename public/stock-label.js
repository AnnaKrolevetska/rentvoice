// Heading above the equipment cards, e.g.
//   "Availability today"
//   "Availability for 5 Nov 2026 (1 day)"
//   "Availability for 9 Nov – 13 Nov 2026 (5 days)"
// Pure function (no DOM) so it is unit-tested in test/stock-label.test.js.
// It never trusts optional server fields blindly: the day count is derived from
// the dates themselves (both dates included), so a missing or stale field can
// never show "undefined".

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function parse(iso) {
  if (typeof iso !== 'string' || !ISO.test(iso)) return null;
  const t = Date.parse(iso + 'T00:00:00Z');
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== iso ? null : t;
}

/** Calendar days from start to end, both included. null if the dates are invalid. */
export function daysInclusive(start, end) {
  const a = parse(start), z = parse(end);
  if (a === null || z === null || z < a) return null;
  return Math.round((z - a) / DAY_MS) + 1;
}

const fmt = (iso, withYear) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', {
  day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC',
});

/** "5 Nov 2026", "9 Nov – 13 Nov 2026", "30 Dec 2026 – 2 Jan 2027" */
export function formatRange(start, end) {
  if (start === end) return fmt(start, true);
  return `${fmt(start, start.slice(0, 4) !== end.slice(0, 4))} – ${fmt(end, true)}`;
}

/**
 * @param stock    the `stock` object from GET /api/state ({ start, end, source?, days? })
 * @param hasRange true when the user has asked about dates in this conversation
 */
export function availabilityLabel(stock, hasRange = false) {
  const known = ['today', 'proposal', 'request', 'booking'];
  // Older servers did not send `source`: infer it from what the page knows.
  const source = known.includes(stock?.source) ? stock.source : hasRange ? 'request' : 'today';
  if (source === 'today') return 'Availability today';

  const days = daysInclusive(stock?.start, stock?.end);
  if (days === null) return 'Availability today';
  return `Availability for ${formatRange(stock.start, stock.end)} (${days} day${days === 1 ? '' : 's'})`;
}
