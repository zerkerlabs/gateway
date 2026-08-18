# Gateway Console Authentication Architecture

> **Current state:** The Gateway console is an unauthenticated, fixture-backed preview. It does not create a browser session, contact a Gateway, discover an OIDC provider, or read, retain, refresh, or transmit a token. The Gateway API supports OIDC bearer authentication; console authentication is not implemented.

## Status

**Recommendation pending human approval:** use a same-origin backend-for-frontend (BFF) with a server-side session for this control-plane console.

This is a recommendation, not an approved architecture or implementation plan. Both options below remain proposals. Work must stop before implementation until the approval checklist at the end of this document is resolved by the security and platform owners.

## Goals

- Authenticate an operator to a tenant-scoped Gateway without exposing Gateway bearer or refresh tokens to browser JavaScript.
- Preserve Gateway authorization and non-disclosure invariants, including cross-tenant `404` responses.
- Represent client identity, tenant identity, and an acting user without trusting browser-supplied identity fields.
- Keep high-risk invocation-body access separate from ordinary invocation metadata.
- Support explicit expiry, refresh, logout, revocation, audit, and failure behavior.

## Non-goals

- Selecting or configuring an identity provider.
- Defining claim names, tenant mappings, roles, scopes, or production hostnames.
- Implementing login, callback, logout, sessions, cookies, CSRF controls, CORS, token validation, or an API client.
- Enabling live reads or any mutation from this fixture preview.
- Accepting, persisting, rendering, logging, or transmitting credentials or tokens.
- Approving invocation-body capture or access.

## Decision matrix

| Concern | Same-origin BFF session | SPA Authorization Code + PKCE (S256) |
|---|---|---|
| Browser token exposure | Gateway access and refresh tokens remain server-side. The browser receives only an opaque session identifier in an `HttpOnly` cookie. | The access token is available to browser JavaScript while in memory. No client secret is possible in a public client. |
| XSS impact | XSS may perform actions through an active session, but cannot directly read an `HttpOnly` session cookie or server-held Gateway tokens. Strong CSP and output safety still matter. | XSS may read an in-memory access token and use it outside the page until expiry. PKCE does not remove this risk. |
| CSRF | Cookie authentication requires an approved CSRF strategy for every state-changing request, plus Origin/Referer validation. | Bearer headers are not automatically attached cross-site, reducing classic CSRF exposure. Login CSRF still requires `state`; other browser channels still need review. |
| CORS | Console and BFF share an origin. Browser-to-Gateway CORS is unnecessary. | Gateway or an approved edge must allow the exact console origins, methods, and headers. Wildcard origins are not acceptable. |
| Refresh and logout | BFF owns refresh, rotation, revocation, and session invalidation. Logout can delete server session state before clearing the cookie. | Browser refresh behavior is a human decision. Long-lived refresh material increases browser exposure; silent iframe flows have platform and privacy limitations. |
| Revocation | Server session can be revoked independently and associated server-held grants can be revoked where the provider supports it. | Revocation must account for each tab's in-memory state and provider behavior. A closed tab is not proof of server-side revocation. |
| Operations | Adds a stateful security component, session store, trusted-proxy posture, and protected token custody. | Avoids a session service but adds public-client registration, strict browser token handling, CORS, callback handling, and a larger XSS blast radius. |
| Local development | Requires an approved local callback, secure-cookie strategy, and BFF/Gateway development boundary. | Requires an approved public-client callback and exact local origin in provider and CORS allowlists. |
| Primary failure mode | Session store, cookie, CSRF, proxy trust, or token custody errors can affect every operator session. | XSS, token lifetime, multi-tab refresh, callback, or CORS errors can expose or strand browser-held authorization. |
| Fit for this console | Preferred for a credential and payment control plane because browser token exposure is minimized and Gateway traffic stays server-to-server. | Viable only if the team accepts browser token exposure and can maintain a strict CSP, memory-only token lifecycle, and exact CORS policy. |

## Recommendation pending human approval

Use a **same-origin BFF session** if the human gate approves it. The console operates sensitive tenant-scoped catalog, policy, credential metadata, invocation, and payment surfaces. Keeping Gateway access and refresh tokens out of browser JavaScript reduces direct token theft, avoids browser-to-Gateway CORS, and gives the platform one server-side point for session expiry, revocation, redaction, and audit correlation.

This does not make the BFF safe by default. Cookie authentication introduces CSRF obligations, and the BFF becomes a high-value token custodian. It requires a reviewed session store, proxy trust, secure cookies, CSRF controls, CSP, token validation, logout, revocation, and operational ownership.

The SPA option remains documented because infrastructure, hosting, or identity-provider constraints may change the decision. Choosing the SPA option must be an explicit acceptance of its browser-token and XSS tradeoffs.

## Proposed flow A: same-origin BFF session

All route names in this section are conceptual placeholders, not implemented endpoints.

```text
Operator browser             Proposed same-origin BFF             OIDC provider             Gateway API
       |                                 |                              |                         |
       | GET proposed login route        |                              |                         |
       |-------------------------------->| generate state, nonce, PKCE  |                         |
       |                                 | redirect authorization       |                         |
       |<--------------------------------|----------------------------->|                         |
       | authenticate and consent at provider                           |                         |
       |<----------------------------------------------------------------                         |
       | GET proposed callback + code   |                              |                         |
       |-------------------------------->| validate state; exchange code |                         |
       |                                 |----------------------------->|                         |
       |                                 | validate issuer/audience/time |                         |
       |                                 | map approved tenant/identity  |                         |
       |                                 | store grants server-side      |                         |
       | opaque Secure HttpOnly cookie   |                              |                         |
       |<--------------------------------|                              |                         |
       | same-origin proposed API read   |                              |                         |
       |-------------------------------->| validate session/authorization|                         |
       |                                 | bearer request, tenant from approved identity mapping  |
       |                                 |------------------------------------------------------->|
       |                                 | preserve status/redacted body |                         |
       |<--------------------------------|<-------------------------------------------------------|
       | session/access grant expires    |                              |                         |
       |-------------------------------->| approved server-side refresh, rotation, or reauthentication|
       |<--------------------------------| no browser token exposure     |                         |
       | proposed logout                 |                              |                         |
       |-------------------------------->| invalidate session first      |                         |
       |                                 | revoke grant if supported     |------------------------>|
       | expired opaque cookie           |                              |                         |
       |<--------------------------------|                              |                         |
```

### Required BFF controls

- Gateway access and refresh tokens stay in an encrypted server-side session store. They never enter HTML, JavaScript, URLs, client-readable cookies, browser storage, logs, analytics, or error bodies.
- The browser receives an opaque, high-entropy session identifier only.
- The session cookie must be `Secure` and `HttpOnly`. `SameSite`, path, domain, name, and lifetime require explicit approval. Production must not weaken `Secure` for convenience.
- Rotate the session identifier after authentication and security-relevant changes. Prevent fixation and define concurrent-session behavior.
- Set absolute and idle expiry. Define refresh timing, failure, provider outage, stale authorization, and forced reauthentication.
- Invalidate server-side session state before clearing the cookie at logout. Define provider logout and token revocation separately; a cleared cookie alone is not revocation.
- Validate `Origin` and, as defense in depth, `Referer` on state-changing requests. Add an approved CSRF mechanism for every mutation before mutations exist. `SameSite` alone is not the complete CSRF control.
- Do not relay arbitrary browser headers to Gateway. Construct approved headers server-side and strip hop-by-hop, authorization, cookie, forwarding, and tenant/identity injection attempts.
- Trust forwarded host/protocol/client-address headers only from approved proxies. Build redirects from approved configuration, never untrusted request headers.
- Return caller-safe errors. Do not expose tokens, provider responses, stack traces, internal addresses, session IDs, claim values, or whether another tenant owns a resource.

## Proposed flow B: SPA Authorization Code + PKCE

All route names and callback locations in this section are conceptual placeholders, not implemented destinations.

```text
Operator browser SPA                          OIDC provider                         Gateway API
       | generate verifier/challenge, state, nonce    |                                  |
       | authorization request with PKCE S256         |                                  |
       |--------------------------------------------->|                                  |
       | authenticate and consent                     |                                  |
       |<---------------------------------------------|                                  |
       | callback with authorization code             |                                  |
       | exchange code + verifier as public client    |                                  |
       |--------------------------------------------->|                                  |
       | tokens                                       |                                  |
       |<---------------------------------------------|                                  |
       | validate issuer/audience/time/nonce           |                                  |
       | retain access token in memory only            |                                  |
       | bearer API request under exact CORS policy    |                                  |
       |-------------------------------------------------------------------------------->|
       | caller-safe response preserving tenant 404    |                                  |
       |<--------------------------------------------------------------------------------|
       | access token expires                           |                                  |
       | approved in-memory refresh behavior or full reauthentication; never storage      |
       | proposed logout: clear every tab's in-memory state and invoke approved            |
       | revocation/provider logout behavior            |                                  |
```

### Required SPA controls

- Register a public client. Do not embed or simulate a client secret.
- Use Authorization Code with PKCE S256 for every authorization. Use a fresh high-entropy verifier, OAuth `state`, and OIDC `nonce`; bind and validate each response.
- Strictly validate issuer, audience, authorized party/client relationship where applicable, signature, nonce, and all relevant time claims using a reviewed library and provider metadata policy.
- Keep access tokens in memory only. Never put access or refresh tokens in `localStorage`, `sessionStorage`, IndexedDB, Cache Storage, service-worker caches, URLs, logs, analytics, or rendered errors.
- Human reviewers must decide whether refresh tokens are permitted for this public client. If allowed, require rotation/reuse detection and document the residual browser exposure. If not allowed, define reauthentication behavior.
- Apply a strict CSP and dependency policy. PKCE prevents an intercepted authorization code from being redeemed without its verifier; it does not protect an access token from XSS after login.
- Configure exact allowed origins, methods, and headers. Do not reflect origins and do not combine credentialed requests with wildcard origins.
- Define multi-tab login, refresh, logout, and revocation behavior without using browser storage as a token-sharing channel.
- Treat provider logout, local in-memory clearing, token expiry, and revocation as separate events.

## Identity and authorization trust boundaries

No claim names are selected here. The following mappings require human approval and Gateway contract verification:

| Identity fact | Authority | Boundary |
|---|---|---|
| Issuer and signing keys | Approved OIDC provider metadata/configuration | Reject tokens from any other issuer or unapproved key path. |
| Audience/client relationship | Approved app and Gateway registrations | The console/BFF must not reinterpret a token issued for another audience. |
| Client identity | Validated token and approved registration | Never derive it from a browser header, query value, or form field. |
| Tenant identity | Approved claim-to-tenant mapping | Never accept a browser-selected tenant as authorization. A selector may request context only after server authorization. |
| Subject/acting user | Approved subject and acting-user mapping | Preserve client and acting-user identities separately in authorization and audit evidence. |
| Roles/scopes | Approved provider/Gateway contract | UI visibility is not authorization. Gateway/BFF enforce every resource operation. |
| Resource ownership | Gateway tenant-scoped lookup | Lists and details include only caller-owned resources. |

### Cross-tenant non-disclosure

Cross-tenant resources return `404`. The console and any BFF must preserve that response without replacing it with “forbidden,” “owned by another tenant,” or any copy that confirms existence. The invariant applies to:

- list membership and counts;
- detail and mutation responses;
- search suggestions and cached data;
- error bodies and support identifiers;
- audit data returned to the caller;
- materially different fallback copy or retry behavior.

Logs available only to approved operators may record a coarse authorization failure according to an approved audit policy, but must not include tokens, credentials, sensitive claims, or resource content.

## Invocation body boundary

Invocation metadata and invocation bodies are different authorization and collection domains.

- Native agent activity never collects prompts, messages, arguments, outputs, commands, paths, files, environment values, or credentials.
- Proxy request/response body capture is a separate Gateway feature and is off by default.
- A body can be read only if it was separately captured and the caller has the high-risk `invocations:read_body` scope.
- A body-read response is capped at **1 MiB**.
- The console/BFF must not prefetch, cache, log, index, analyze, put into browser storage, include in telemetry, or retain bodies after navigation.
- Possessing `invocations:read_body` does not enable capture and does not authorize native activity content.
- Approval of this authentication architecture does not approve body capture or body rendering. Those require a separate privacy and authorization review.

## Threat and control table

| Threat | Shared requirement | BFF-specific control | SPA-specific control |
|---|---|---|---|
| XSS | Strict CSP, safe rendering, constrained dependencies, no secrets in DOM/errors | `HttpOnly` session and server-held tokens reduce direct token extraction; actions through the session remain possible | Memory-only token handling; accept that active XSS can extract the access token |
| CSRF/login CSRF | OAuth `state`; exact redirects | Origin/Referer validation plus approved CSRF defense for mutations; deliberate `SameSite` | Bearer header not ambient; validate `state`/`nonce` and review any cookie-based provider interactions |
| Session theft/fixation | TLS, short lifetimes, reauthentication policy | Opaque high-entropy ID, rotation, server invalidation, secure cookie | No app session cookie; protect in-memory grants and callback state |
| Token leakage | Redaction, no URL/log/analytics/storage tokens | Encrypt and restrict server token store; never send Gateway tokens to browser | Memory only; never storage, URL, DOM, service worker, or analytics |
| Open redirect | Exact configured redirect/logout allowlists | Ignore untrusted forwarded host unless from approved proxy | Build provider requests from approved static origin/callback configuration |
| Tenant confusion | Approved claim mapping; Gateway remains authoritative | Construct tenant context server-side from validated session | Derive tenant context only from validated token; never browser selector/header |
| Stale authorization | Define expiry and re-check points | Refresh claims/session or force reauthentication; invalidate server session | Short access-token life; approved refresh/reauthentication behavior |
| Logout/revocation failure | Treat local logout, provider logout, expiry, and revocation separately | Invalidate session before cookie clear; revoke server-held grants where supported | Clear every tab's memory and perform approved provider/revocation flow |
| Sensitive logging | Structured allowlist and redaction tests | No session IDs, grants, provider bodies, claims, or Gateway body content | No tokens, callback code, verifier, nonce, claims, or body content |
| Proxy/header trust | Approved proxy list and host/proto policy | Strip inbound auth/tenant/forwarding headers; construct Gateway request | Exact CORS and redirect origins; no browser-supplied authorization context beyond bearer token |

## Failure and operator behavior

The future implementation must distinguish, without leaking sensitive detail:

- no console session;
- expired session/token;
- provider unavailable;
- Gateway unavailable;
- caller not authorized for an operation;
- caller-safe cross-tenant/not-found `404`;
- high-risk body scope absent;
- body capture disabled or body not captured.

Unknown, unavailable, expired, and not found must not be presented as zero. Automatic retries must not replay mutations. Login and refresh failures must not loop indefinitely.

## Audit and privacy requirements

Before live mode, humans must approve an allowlisted audit schema for login, logout, expiry, revocation, tenant context selection, authorization failure, and mutation attempts. Audit records must identify the approved client and acting-user dimensions without storing tokens, credentials, body content, prompts, arguments, outputs, environment values, provider error bodies, or raw security headers.

The browser must not use local or session storage for tokens. If non-sensitive UI preferences are later stored, they require a separate key allowlist and must not include tenant data, operator identity, resource data, search history, or invocation content.

## Staged next steps after approval

1. Verify the chosen option against the current Gateway OpenAPI and OIDC middleware contract.
2. Resolve every approval item below and record owners.
3. Threat-model the selected deployment and data flow.
4. Write contract tests for issuer/audience/claim validation, tenant isolation, cross-tenant `404`, expiry, revocation, CSRF where applicable, redaction, and body-scope denial.
5. Implement authentication in a separate human-reviewed change without enabling mutations.
6. Connect only tenant-scoped read operations after authentication verification.
7. Add mutations only after separate authorization, confirmation, CSRF, idempotency, and audit approval.

> ## Human approval required before implementation
>
> No authentication work may begin until owners approve and record all of the following:
>
> - [ ] Architecture choice: same-origin BFF or SPA Authorization Code + PKCE.
> - [ ] OIDC provider and application registrations for each environment.
> - [ ] Exact issuer, audience, authorized-party/client validation, and metadata/JWKS policy.
> - [ ] Claim names and mapping for client identity, tenant identity, subject, and acting user.
> - [ ] Roles, scopes, resource authorization model, and UI capability treatment.
> - [ ] Absolute/idle session or token lifetimes, refresh timing, rotation, reuse detection, and forced reauthentication.
> - [ ] Cookie name, domain, path, `Secure`, `HttpOnly`, `SameSite`, and local-development posture if BFF is selected.
> - [ ] CSRF mechanism and Origin/Referer policy for every future state-changing route.
> - [ ] Exact login callback, post-logout, and allowed-origin lists; open-redirect prevention.
> - [ ] BFF deployment, server-side session/token encryption, key custody, backup, replica, and trusted-proxy posture if selected.
> - [ ] CSP, dependency policy, trusted origins, and browser hardening.
> - [ ] Logout, provider logout, token revocation, session invalidation, multi-tab, and incident response semantics.
> - [ ] Approval process for `invocations:read_body`, body-capture posture, 1 MiB cap, and no-cache/no-log handling.
> - [ ] Audit event schema, retention, access, correlation, and redaction tests.
> - [ ] Mutation authorization, confirmation, CSRF, idempotency, and caller-visible audit evidence.
> - [ ] Caller-safe failure copy and tests for cross-tenant `404` non-disclosure.
>
> **Implementation remains blocked until this checklist is approved.**
