import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LIVE, PLANNED, PREVIEW, viewWiring, wiringAttrs, wiringBadge, wiringLabel, wiringOf, wiringSummary } from "./wiring.js";

test("the map matches which views actually route to a live renderer", () => {
  // The guard that matters. This map was first written when three views were
  // live; nine more shipped before it landed. Derive the truth from app.js
  // rather than restating it by hand, so the next one cannot drift silently.
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const body = app.match(/^const views = \{(.+?)\};/ms)[1];
  const routed = [];
  for (const pair of body.split(",")) {
    const [view, renderer] = pair.split(":").map((part) => part.trim());
    routed.push(view);
    assert.equal(wiringOf(view) === LIVE, renderer.startsWith("live"),
      `${view} routes to ${renderer} but the wiring map says ${wiringOf(view)}`);
  }
  assert.deepEqual(Object.keys(viewWiring).toSorted(), routed.toSorted());
});

test("an unknown view falls back to preview, never to live", () => {
  assert.equal(wiringOf("not-a-view"), PREVIEW);
  assert.equal(wiringOf("agents"), LIVE);
});

test("the sidebar summary is counted from the map, not written down", () => {
  const summary = wiringSummary({ a: LIVE, b: PREVIEW, c: PREVIEW, d: PLANNED });
  assert.equal(summary.label, "Mixed data");
  assert.equal(summary.detail, "1 of 4 views live · 2 preview · 1 planned");
});

test("the summary collapses when nothing or everything is wired", () => {
  assert.equal(wiringSummary({ a: PREVIEW, b: PLANNED }).label, "Preview");
  assert.equal(wiringSummary({ a: LIVE, b: LIVE }).detail, "Every view reads this Gateway tenant");
});

test("live surfaces carry no badge and no frame", () => {
  assert.equal(wiringBadge(LIVE), "");
  assert.equal(wiringAttrs(LIVE), "");
});

test("preview and planned stay distinct in label and markup", () => {
  assert.equal(wiringLabel(PREVIEW), "Preview data");
  assert.equal(wiringLabel(PLANNED), "Planned");
  assert.match(wiringBadge(PREVIEW), /wiring-badge preview/);
  assert.match(wiringBadge(PLANNED), /wiring-badge planned/);
  assert.equal(wiringAttrs(PREVIEW), ' data-wiring="preview"');
});
