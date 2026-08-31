// The capability map: a static roadmap of what Gateway delivers today versus
// what's still planned. It isn't backed by a read, so both the fixture and
// the live Overview page render the exact same markup — only the attribute
// used to wire up navigation differs, since the live page binds its own
// clicks (see overview-view.js's file header) instead of app.js's `data-view`
// convention.

function badge(label, tone) {
  return `<span class="status ${tone}"><i aria-hidden="true"></i>${label}</span>`;
}

function capabilityCard(navAttr, title, copy, items, target, deliveryStates) {
  return `<button class="capability-card" ${navAttr}="${target}"><span class="card-top"><strong>${title}</strong><span class="delivery-badges">${deliveryStates.map(([label, tone]) => badge(label, tone)).join("")}</span></span><p>${copy}</p><ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul><span class="card-link">Open surface →</span></button>`;
}

export function renderCapabilitySection(navAttr = "data-view") {
  return `<section class="capability-section"><div class="section-heading"><div><p class="kicker">Capability map</p><h2>Capability delivery status</h2></div><p>Roadmap context follows operational evidence. Available products and future integrations remain labeled separately.</p></div><div class="capability-grid">
    ${capabilityCard(navAttr, "Discover", "Inventory local agents and runtime environments.", ["Catalog", "Local discovery", "Enrollment evidence"], "agents", [["Available OSS", "available"]])}
    ${capabilityCard(navAttr, "Control", "Apply identity, credentials, rates and policy before traffic moves.", ["OIDC tenancy", "Policy decisions", "Protected credentials"], "policies", [["Available", "available"]])}
    ${capabilityCard(navAttr, "Observe", "Inspect request and agent metadata without guessing what happened.", ["Invocations", "Latency & errors", "Metadata-only activity"], "analytics", [["Available OSS", "available"]])}
    ${capabilityCard(navAttr, "Monetize", "Gate paid routes and settle through a separate facilitator.", ["x402 gate", "USDC on Base", "Settlement records"], "payments", [["Available", "available"]])}
    ${capabilityCard(navAttr, "Verify", "Bind high-risk actions to deterministic evidence and signed records.", ["Reason certificates", "Treeship evidence", "Guard enforcement"], "stack", [["Standalone", "standalone"], ["Integration path", "integration"], ["Planned", "planned"]])}
    ${capabilityCard(navAttr, "Publish & work", "Turn agents into products and dispatch bounded missions.", ["Customer portals", "Plans & docs", "Remote missions"], "products", [["Planned", "planned"]])}
  </div></section>`;
}
