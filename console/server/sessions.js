// Server-side session and login-transaction stores.
//
// In-memory on purpose. The hosted demo is a single box running a single
// console process, and an in-process map is the honest shape for that: no
// second component to secure, no token at rest, and a restart simply logs
// everyone out. It is also the part that does NOT generalise — running more
// than one console replica requires a shared store, and sessions would
// silently stop working (a user would bounce between replicas and appear
// logged out at random) rather than fail loudly. See AUTH_ARCHITECTURE.md.

import { randomBytes, timingSafeEqual } from 'node:crypto';

// 32 bytes from the CSPRNG. AUTH_ARCHITECTURE.md requires the browser receive
// an opaque high-entropy identifier and nothing else — no claims, no tokens.
function newId() {
  return randomBytes(32).toString('base64url');
}

export class SessionStore {
  #sessions = new Map();
  #idleMs;
  #absoluteMs;

  constructor({ idleMs, absoluteMs }) {
    this.#idleMs = idleMs;
    this.#absoluteMs = absoluteMs;
  }

  create(data, now = Date.now()) {
    const id = newId();
    this.#sessions.set(id, { ...data, createdAt: now, lastSeenAt: now });
    return id;
  }

  // Returns the session and its (possibly new) id, or null.
  //
  // Reading a session slides its idle window. Absolute expiry is measured from
  // creation and is deliberately not slid — that is the whole point of having
  // two bounds rather than one.
  get(id, now = Date.now()) {
    if (!id) return null;
    const s = this.#sessions.get(id);
    if (!s) return null;

    if (now - s.createdAt > this.#absoluteMs || now - s.lastSeenAt > this.#idleMs) {
      this.#sessions.delete(id);
      return null;
    }

    s.lastSeenAt = now;
    return s;
  }

  // Issue a new identifier for an existing session and retire the old one.
  // Called immediately after authentication so that a session identifier
  // observed before login cannot be replayed after it (session fixation).
  rotate(oldId, now = Date.now()) {
    const s = this.#sessions.get(oldId);
    if (!s) return null;
    this.#sessions.delete(oldId);
    const id = newId();
    this.#sessions.set(id, { ...s, lastSeenAt: now });
    return id;
  }

  destroy(id) {
    if (!id) return false;
    return this.#sessions.delete(id);
  }

  get size() {
    return this.#sessions.size;
  }

  // Bounded sweep so an abandoned tab's session does not sit in memory until
  // restart. Cheap: this map is operator-sized, not user-sized.
  sweep(now = Date.now()) {
    let removed = 0;
    for (const [id, s] of this.#sessions) {
      if (now - s.createdAt > this.#absoluteMs || now - s.lastSeenAt > this.#idleMs) {
        this.#sessions.delete(id);
        removed++;
      }
    }
    return removed;
  }
}

// Half-finished logins: the state, nonce and PKCE verifier that must survive
// the round trip to the provider. These live server-side rather than in a
// cookie so the verifier never reaches the browser at all.
export class TransactionStore {
  #txns = new Map();
  #ttlMs;

  constructor({ ttlMs }) {
    this.#ttlMs = ttlMs;
  }

  create(data, now = Date.now()) {
    const id = newId();
    this.#txns.set(id, { ...data, createdAt: now });
    return id;
  }

  // Single-use: a login transaction is consumed by the callback that completes
  // it, so a replayed callback finds nothing and is rejected.
  consume(id, now = Date.now()) {
    if (!id) return null;
    const t = this.#txns.get(id);
    if (!t) return null;
    this.#txns.delete(id);
    if (now - t.createdAt > this.#ttlMs) return null;
    return t;
  }

  sweep(now = Date.now()) {
    let removed = 0;
    for (const [id, t] of this.#txns) {
      if (now - t.createdAt > this.#ttlMs) {
        this.#txns.delete(id);
        removed++;
      }
    }
    return removed;
  }
}

// Constant-time compare for the OAuth `state` value. State is not a secret in
// the way a token is, but comparing it in constant time costs nothing and
// keeps the check free of a timing signal.
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
