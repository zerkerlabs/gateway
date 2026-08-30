// Display formatting for live gateway records.
//
// One rule runs through every function here, and it is the console's contract
// rather than a style preference: a value the gateway did not give us renders
// as "Unknown", never as zero. Those are different statements — "this agent
// made no calls" and "we do not know how many calls this agent made" lead an
// operator to opposite conclusions — and collapsing them is the specific
// failure UX_RUBRIC.md exists to prevent.
//
// So every formatter takes a possibly-absent value and returns a string, and
// the absent case is always the unknown string. Callers never have to remember
// to guard; forgetting to guard is how zeroes get invented.

export const UNKNOWN = 'Unknown';

// USDC has six decimals, and the gateway carries amounts as smallest-unit
// decimal strings ("250000" is $0.25). They are strings and not numbers on
// purpose — a token amount is an exact integer and JSON numbers are floats —
// so this parses the string rather than reaching for Number() and rounding.
const USDC_DECIMALS = 6;

export function usdc(amount, asset = 'USDC') {
  if (amount === null || amount === undefined || amount === '') return UNKNOWN;
  const digits = String(amount);
  if (!/^[0-9]+$/.test(digits)) return UNKNOWN;

  const padded = digits.padStart(USDC_DECIMALS + 1, '0');
  const whole = padded.slice(0, -USDC_DECIMALS);
  const frac = padded.slice(-USDC_DECIMALS);

  // Show cents at minimum, then whatever significant precision remains — a
  // $0.000025 per-call price is a real thing to price an agent at, and
  // rounding it to $0.00 would make the catalog lie about what it charges.
  const trimmed = frac.replace(/0+$/, '');
  const shown = trimmed.length <= 2 ? frac.slice(0, 2) : trimmed;
  const value = `${Number(whole).toLocaleString('en-US')}.${shown}`;
  return asset === 'USDC' ? `$${value}` : `${value} ${asset}`;
}

export function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return UNKNOWN;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function count(n) {
  return Number.isFinite(n) ? n.toLocaleString('en-US') : UNKNOWN;
}

// Three outcomes, not two. An unknown numerator or denominator is unknown; a
// known-zero denominator has no ratio to report and says so, rather than
// rendering 0% — "0% of nothing failed" reads as a clean bill of health for a
// window in which nothing happened at all.
export function percent(part, total, { empty = 'No calls' } = {}) {
  if (!Number.isFinite(part) || !Number.isFinite(total)) return UNKNOWN;
  if (total === 0) return empty;
  const pct = (part / total) * 100;
  if (pct > 0 && pct < 0.1) return '<0.1%';
  return `${pct.toFixed(pct < 10 ? 1 : 0)}%`;
}

export function timestamp(iso) {
  if (!iso) return UNKNOWN;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return UNKNOWN;
  return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

// Relative time is for recency at a glance ("3m ago"), and it is deliberately
// coarse: anything past a week reads as an absolute date, because "47d ago" is
// harder to act on than the date itself.
export function relative(iso, now = Date.now()) {
  if (!iso) return UNKNOWN;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return UNKNOWN;

  const delta = now - then;
  if (delta < 0) return timestamp(iso);
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)}d ago`;
  return timestamp(iso);
}

// A rate limit of null is not "unlimited" — it means no per-agent override is
// set, and the process-wide limiter still applies. Saying "unlimited" would be
// a materially wrong claim about the agent's blast radius.
export function rateLimit(perSecond, burst) {
  if (!Number.isFinite(perSecond)) return 'Process default';
  const rate = perSecond >= 1 ? `${perSecond}/s` : `${perSecond * 60}/min`;
  return Number.isFinite(burst) ? `${rate} · burst ${burst}` : rate;
}

// Pricing is the agent's payment gate. Absent pricing means the gate is off,
// which is a definite fact and not an unknown — hence "No payment gate" rather
// than UNKNOWN.
export function pricing(p) {
  if (!p) return 'No payment gate';
  const base = `${usdc(p.amount, p.asset)} / call`;
  const overrides = p.tools ? Object.keys(p.tools).length : 0;
  if (!overrides) return base;
  return `${base} · ${overrides} tool ${overrides === 1 ? 'override' : 'overrides'}`;
}
