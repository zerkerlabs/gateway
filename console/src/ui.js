// Shared rendering primitives.
//
// Every page is a function returning an HTML string, so this file holds the
// pieces they all share: escaping, the status vocabulary, the two chart shapes,
// and — most importantly — the three ways a value can be absent.
//
// Loading, unknown, and zero are three different statements and this console
// is not allowed to collapse them. `skeleton()` is "still reading",
// `unknownBig()` is "the gateway could not tell us", and a plain zero is a
// measured zero. Everything else in here is layout.

import { UNKNOWN } from './live/format.js';

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

export const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US') : UNKNOWN);

export function pct(x) {
  if (!Number.isFinite(x)) return UNKNOWN;
  // An exact zero is "0%", not "0.0%": the decimal implies a measurement
  // precise enough to have rounded, and nothing was rounded here.
  if (x === 0) return '0%';
  if (x < 0.001) return '<0.1%';
  return `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;
}

export function ms(v) {
  if (!Number.isFinite(v)) return UNKNOWN;
  return v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`;
}

export function bytes(v) {
  if (!Number.isFinite(v)) return UNKNOWN;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}

export function ago(iso, now = Date.now()) {
  if (!iso) return UNKNOWN;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return UNKNOWN;
  const s = (now - t) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function when(iso) {
  if (!iso) return UNKNOWN;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return UNKNOWN;
  return `${d.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

// USDC smallest units are exact integers carried as strings; parse the string
// rather than reaching for Number(), which would round a real per-call price.
export function usdc(amount) {
  if (amount === null || amount === undefined || amount === '') return UNKNOWN;
  const digits = String(amount);
  if (!/^\d+$/.test(digits)) return UNKNOWN;
  const padded = digits.padStart(7, '0');
  const whole = Number(padded.slice(0, -6)).toLocaleString('en-US');
  const frac = padded.slice(-6).replace(/0+$/, '');
  return `$${whole}.${frac.length <= 2 ? padded.slice(-6).slice(0, 2) : frac}`;
}

export const dot = (tone) => `<span class="dot ${esc(tone)}"></span>`;
export const tag = (tone, text) => `<span class="tag ${esc(tone)}">${esc(text)}</span>`;
export const st = (tone, text) => `<span class="st">${dot(tone)}${esc(text)}</span>`;

export const skeleton = (cls = '') => `<span class="skeleton ${cls}" aria-hidden="true"></span>`;

// The two absent states, rendered so they cannot be mistaken for each other or
// for a number. `loading` is transient and shaped like the value it will
// become; `unknown` is a settled fact about what the gateway could not answer.
export function big(value, { tone = null, state = 'ready' } = {}) {
  if (state === 'loading') return `<div class="big">${skeleton()}</div>`;
  if (state !== 'ready') return `<div class="big unknown">${esc(UNKNOWN)}</div>`;
  return `<div class="big">${tone ? dot(tone) : ''}${esc(value)}</div>`;
}

export function answer({ title, body, detail, source, wide = false }) {
  return `<div class="ans${wide ? ' wide' : ''}">
    <h2>${esc(title)}</h2>
    ${body}
    <p>${detail}</p>
    <p class="src">${esc(source)}</p>
  </div>`;
}

export const notice = (tone, html) => `<p class="notice ${esc(tone)}">${html}</p>`;
export const empty = (text) => `<div class="empty">${esc(text)}</div>`;

export function table(cols, rows, { emptyText = 'Nothing here yet.' } = {}) {
  if (!rows.length) return `<div class="card">${empty(emptyText)}</div>`;
  return `<div class="card tw"><table><thead><tr>${cols
    .map((c) => `<th${c.num ? ' class="num"' : ''}>${esc(c.label)}</th>`)
    .join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

// --- charts ------------------------------------------------------------------
//
// Both take counts that were computed server-side. Neither invents a scale: the
// axis label names the peak the data actually reaches, so a chart of four calls
// and a chart of four thousand are not drawn identically without saying so.

export function spark(counts, label) {
  const W = 600, H = 110, pad = 6;
  if (!counts.length) return empty('No traffic in this window.');
  const max = Math.max(1, ...counts);
  const step = counts.length > 1 ? (W - 2 * pad) / (counts.length - 1) : 0;
  const pts = counts.map((v, i) => [pad + i * step, H - pad - (v / max) * (H - 2 * pad - 14)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">
    <line class="grid" x1="0" x2="${W}" y1="${H - pad}" y2="${H - pad}"/>
    <path class="area" d="${d} L${last[0]} ${H - pad} L${pts[0][0]} ${H - pad} Z"/>
    <path class="line" d="${d}"/>
    <circle class="end" cx="${last[0]}" cy="${last[1]}" r="5"/>
    <text x="${W - pad}" y="${Math.max(12, last[1] - 10)}" text-anchor="end">${counts[counts.length - 1]} latest</text>
    <text x="${pad}" y="12">peak ${max}</text>
  </svg>`;
}

export function bars(counts, labels, cls, unit) {
  const W = 600, H = 140, pad = 6;
  if (!counts.length) return empty(`No ${unit} in this window.`);
  const bw = (W - 2 * pad) / counts.length;
  const max = Math.max(1, ...counts);
  const every = Math.ceil(counts.length / 7);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(unit)} per period">
    <line class="grid" x1="0" x2="${W}" y1="${H - 22}" y2="${H - 22}"/>
    ${counts.map((v, i) => {
      const h = (v / max) * (H - 44);
      const x = pad + i * bw + 2;
      return `<rect class="bar ${esc(cls)}" x="${x}" y="${H - 22 - h}" width="${Math.max(1, bw - 4)}" height="${h}" rx="3" data-tip="${v} ${esc(unit)} · ${esc(labels[i])}"/>
        ${v ? `<text x="${x + (bw - 4) / 2}" y="${H - 26 - h}" text-anchor="middle">${v}</text>` : ''}
        ${i % every === 0 || i === counts.length - 1 ? `<text x="${x + (bw - 4) / 2}" y="${H - 6}" text-anchor="middle">${esc(labels[i])}</text>` : ''}`;
    }).join('')}
  </svg>`;
}

export function hbars(rows, format) {
  if (!rows.length) return empty('Nothing to compare yet.');
  const max = Math.max(1, ...rows.map((r) => r.v));
  // The bar is an SVG rect rather than a div with a width style: this console
  // is served under a CSP that forbids inline style attributes, and a
  // presentation attribute on an SVG shape is not one.
  return `<div class="hbars">${rows.map((r) => `<div class="hbar">
    <span>${esc(r.k)}</span>
    <svg class="track" viewBox="0 0 100 10" preserveAspectRatio="none" role="img" aria-label="${esc(`${r.k}: ${format(r.v)}`)}"><rect class="fill" x="0" y="0" height="10" rx="2" width="${((r.v / max) * 100).toFixed(2)}"/></svg>
    <span class="v">${esc(format(r.v))}</span>
  </div>`).join('')}</div>`;
}

// --- windows -----------------------------------------------------------------
//
// One window control drives every page. The bucket follows from it, because a
// 30-day chart drawn in hourly buckets is 720 bars nobody can read, and the
// gateway caps the range at 31 days regardless.

export const WINDOWS = {
  '24h': { label: 'last 24 hours', word: 'today', ms: 86400000, bucket: 'hour' },
  '7d': { label: 'last 7 days', word: 'this week', ms: 7 * 86400000, bucket: 'day' },
  '30d': { label: 'last 30 days', word: 'this month', ms: 30 * 86400000, bucket: 'day' },
};

export const sinceOf = (win, now = Date.now()) => new Date(now - WINDOWS[win].ms).toISOString();

// Fold analytics groups into per-bucket totals for the traffic chart, and into
// per-agent rows for the catalog.
//
// Percentiles are never merged across buckets here. A p95 is not summable, and
// a merged one would be a number that is not a percentile of anything — so a
// multi-bucket window reports per-agent latency as unknown and the page says
// where the real figure lives (the window totals).
export function foldGroups(groups = []) {
  const agents = new Map();
  for (const g of groups) {
    const a = agents.get(g.agent_id) || { calls: 0, errors: 0, buckets: 0, p95: null };
    a.calls += g.count || 0;
    for (const n of Object.values(g.by_error_class || {})) a.errors += n || 0;
    a.buckets += 1;
    a.p95 = g.latency_ms?.p95 ?? null;
    agents.set(g.agent_id, a);
  }
  for (const a of agents.values()) {
    if (a.buckets > 1) {
      a.p95 = null;
      a.merged = true;
    }
  }
  return { agents };
}

// Build the full bucket timeline for a window and fill it from the groups.
//
// The gateway returns only buckets that have rows in them, which is correct for
// an aggregate and wrong for a chart: plotting just those makes an hour of
// traffic and a week of it look identical, and a single populated bucket draws
// as one dot. So the axis is generated from the window and the counts are
// dropped into it — an empty bucket is a real zero and is drawn as one.
export function denseBuckets(groups = [], win, now = Date.now()) {
  const stepMs = WINDOWS[win].bucket === 'hour' ? 3600000 : 86400000;
  const spanMs = WINDOWS[win].ms;
  const slots = Math.max(1, Math.round(spanMs / stepMs));

  // Bucket starts are truncated the same way the gateway truncates them, so a
  // group's bucket_start lands in exactly one slot.
  const truncate = (t) => {
    const d = new Date(t);
    if (WINDOWS[win].bucket === 'hour') d.setUTCMinutes(0, 0, 0);
    else d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  };

  const end = truncate(now);
  const counts = new Array(slots).fill(0);
  const labels = [];
  for (let i = 0; i < slots; i += 1) {
    const t = new Date(end - (slots - 1 - i) * stepMs);
    labels.push(
      WINDOWS[win].bucket === 'hour'
        ? `${String(t.getUTCHours()).padStart(2, '0')}:00`
        : t.toISOString().slice(5, 10)
    );
  }
  for (const g of groups) {
    const idx = slots - 1 - Math.round((end - truncate(g.bucket_start)) / stepMs);
    if (idx >= 0 && idx < slots) counts[idx] += g.count || 0;
  }
  return { counts, labels };
}
