// Which console surfaces read the live Gateway, and which do not.
//
// Two questions get asked about a surface, and they are independent:
//
//   delivery truth  — does the capability exist in the product at all?
//                     "Products & portals" does not ship, so nothing will ever
//                     make that screen work. Lives in view-model.js as
//                     deliveryTruthLabel().
//
//   wiring state    — is this console surface reading the live Gateway yet?
//                     Stack & health is shipped OSS and the gateway answers
//                     /healthz today; the screen just still renders a fixture.
//                     That is a console gap, not a product gap.
//
// Reading "not wired" as "not built" makes the product look thinner than it
// is; reading it the other way round makes it look further along. So the two
// keep different words, and neither is ever rendered by dimming — reduced
// contrast collides with the stale and unavailable states UX_RUBRIC.md
// requires to stay distinct. Preview surfaces keep full contrast inside a
// marked frame, and the absence of a mark is what signals "this is real".

export const LIVE = 'live';
export const PREVIEW = 'preview';
export const PLANNED = 'planned';

// The single source of truth. Nav pins, the sidebar summary, and the topbar
// context line all derive from this, so a view going live is a one-line change
// rather than a hunt through markup and prose.
//
// Keep it in step with the `views` map in app.js — wiring.test.js reads that
// map and fails if the two disagree. That test exists because this map was
// first written when three views were live and nine more shipped before it
// landed; the prose it replaced drifted exactly the same way.
export const viewWiring = {
  overview: LIVE,
  attention: LIVE,
  activity: LIVE,
  invocations: LIVE,
  analytics: LIVE,
  agents: LIVE,
  environments: PREVIEW,
  policies: LIVE,
  credentials: LIVE,
  products: PLANNED,
  payments: LIVE,
  stack: PREVIEW,
};

// An unknown view is PREVIEW, never LIVE. The failure modes are not
// symmetric: labelling live data as preview costs a little credibility,
// labelling preview data as live is the honesty gate failing.
export function wiringOf(view, map = viewWiring) {
  return map[view] ?? PREVIEW;
}

export function wiringLabel(state) {
  if (state === LIVE) return 'Live data';
  if (state === PLANNED) return 'Planned';
  return 'Preview data';
}

// Counted, not written down. The sentence this replaces — "Agent catalog is
// live · other views are fixtures" — was true the day it was typed and wrong
// nine views later.
export function wiringSummary(map = viewWiring) {
  const states = Object.values(map);
  const live = states.filter((s) => s === LIVE).length;
  const preview = states.filter((s) => s === PREVIEW).length;
  const planned = states.filter((s) => s === PLANNED).length;

  if (!live) return { label: 'Preview', detail: 'No view is connected to Gateway yet', state: PREVIEW };
  if (!preview && !planned) return { label: 'Live', detail: 'Every view reads this Gateway tenant', state: LIVE };

  const rest = [preview && `${preview} preview`, planned && `${planned} planned`].filter(Boolean).join(' · ');
  return { label: 'Mixed data', detail: `${live} of ${states.length} views live · ${rest}`, state: PREVIEW };
}

// --- markup ------------------------------------------------------------------

// One badge, usable at any granularity: a nav item, a panel heading, a single
// card. Sub-view marking is the point — with most views now live, the case
// that matters is a live screen carrying one panel that is not, which a
// per-view label gets wrong.
export function wiringBadge(state, { compact = false } = {}) {
  if (state === LIVE) return '';
  return `<span class="wiring-badge ${state}${compact ? ' compact' : ''}">${wiringLabel(state)}</span>`;
}

// Frame attributes for a container whose contents are not wired. The class
// hook drives a dashed border; the data attribute is what tests assert on.
export function wiringAttrs(state) {
  return state === LIVE ? '' : ` data-wiring="${state}"`;
}
