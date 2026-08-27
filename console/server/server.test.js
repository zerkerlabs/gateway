// The tests that matter here are the security controls, not the happy path:
// each one corresponds to a line in AUTH_ARCHITECTURE.md that would otherwise
// be a claim in a document rather than a property of the code.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './index.js';
import { SessionStore, TransactionStore, safeEqual } from './sessions.js';

const ORIGIN = 'https://console.demo.zerker.ai';

const config = {
  origin: ORIGIN,
  issuer: 'https://tenant.us.auth0.com/',
  clientId: 'client-abc',
  clientSecret: 'secret-xyz',
  audience: 'https://gateway.demo.zerker.ai',
  gatewayBaseURL: 'http://gateway:8080',
  redirectURI: `${ORIGIN}/auth/callback`,
  postLogoutURI: `${ORIGIN}/`,
  cookieSecure: true,
  sessionIdleMs: 60_000,
  sessionAbsoluteMs: 600_000,
  txnTtlMs: 60_000,
  staticDir: '../dist',
};

// A stand-in provider. The real flow is exercised against Auth0; what these
// tests need is deterministic control over what the provider "returns".
function fakeOIDC(overrides = {}) {
  return {
    authorizationURL: ({ state, nonce, challenge }) =>
      `https://tenant.us.auth0.com/authorize?state=${state}&nonce=${nonce}` +
      `&code_challenge=${challenge}&code_challenge_method=S256`,
    exchangeCode: async () => ({
      access_token: 'gateway-access-token',
      refresh_token: 'refresh-token',
      id_token: 'id-token',
      expires_in: 3600,
    }),
    verifyIdToken: async () => ({ sub: 'auth0|123', email: 'jacob@zerker.ai', name: 'Jacob' }),
    refresh: async () => ({ access_token: 'refreshed', expires_in: 3600 }),
    logoutURL: () => 'https://tenant.us.auth0.com/v2/logout',
    ...overrides,
  };
}

const silent = { info() {}, warn() {}, error() {}, log() {} };

function harness({ oidc = fakeOIDC(), upstream } = {}) {
  const sessions = new SessionStore({ idleMs: config.sessionIdleMs, absoluteMs: config.sessionAbsoluteMs });
  const txns = new TransactionStore({ ttlMs: config.txnTtlMs });
  const calls = [];

  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (upstream) return upstream(String(url), init);
    return new Response(JSON.stringify({ agents: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const app = createApp({ config, oidc, sessions, txns, fetchImpl, logger: silent });
  return { app, sessions, txns, calls };
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

// Completes a login and returns the session cookie value.
async function login(base, txns) {
  const start = await fetch(`${base}/auth/login`, { redirect: 'manual' });
  const txnCookie = start.headers.getSetCookie().find((c) => c.startsWith('__Host-zg_txn='));
  const txnId = decodeURIComponent(txnCookie.split(';')[0].split('=')[1]);
  const state = new URL(start.headers.get('location')).searchParams.get('state');

  const cb = await fetch(`${base}/auth/callback?code=abc&state=${state}`, {
    headers: { cookie: `__Host-zg_txn=${txnId}` },
    redirect: 'manual',
  });
  const sessionCookie = cb.headers.getSetCookie().find((c) => c.startsWith('__Host-zg_session='));
  return { cookie: sessionCookie.split(';')[0], status: cb.status };
}

describe('session store', () => {
  test('absolute expiry is not slid by activity', () => {
    const s = new SessionStore({ idleMs: 1000, absoluteMs: 2000 });
    const id = s.create({ sub: 'a' }, 0);
    assert.ok(s.get(id, 900));
    assert.ok(s.get(id, 1800));
    assert.equal(s.get(id, 2100), null, 'session outlived its absolute bound');
  });

  test('idle expiry drops an abandoned session', () => {
    const s = new SessionStore({ idleMs: 1000, absoluteMs: 100_000 });
    const id = s.create({ sub: 'a' }, 0);
    assert.equal(s.get(id, 1500), null);
  });

  test('rotation retires the previous identifier', () => {
    const s = new SessionStore({ idleMs: 1000, absoluteMs: 10_000 });
    const first = s.create({ sub: 'a' }, 0);
    const second = s.rotate(first, 10);
    assert.notEqual(first, second);
    assert.equal(s.get(first, 20), null, 'pre-rotation id still works (session fixation)');
    assert.ok(s.get(second, 20));
  });
});

describe('login transactions', () => {
  test('a transaction is single-use', () => {
    const t = new TransactionStore({ ttlMs: 1000 });
    const id = t.create({ state: 's' }, 0);
    assert.ok(t.consume(id, 10));
    assert.equal(t.consume(id, 20), null, 'callback replay succeeded');
  });

  test('an expired transaction is refused', () => {
    const t = new TransactionStore({ ttlMs: 1000 });
    const id = t.create({ state: 's' }, 0);
    assert.equal(t.consume(id, 2000), null);
  });
});

test('safeEqual rejects length and value mismatches', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual(undefined, 'abc'), false);
});

describe('http surface', () => {
  let h, server, base;
  beforeEach(async () => {
    h = harness();
    ({ server, base } = await listen(h.app));
  });
  afterEach(() => server.close());

  test('healthz needs no session', async () => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
  });

  test('unauthenticated session probe leaks nothing', async () => {
    const res = await fetch(`${base}/auth/session`);
    assert.deepEqual(await res.json(), { authenticated: false });
  });

  test('login sets an HttpOnly SameSite=Lax transaction cookie and asks for S256', async () => {
    const res = await fetch(`${base}/auth/login`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('__Host-zg_txn='));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Secure/);
    assert.match(res.headers.get('location'), /code_challenge_method=S256/);
  });

  test('a mismatched state is refused', async () => {
    const start = await fetch(`${base}/auth/login`, { redirect: 'manual' });
    const txnId = decodeURIComponent(
      start.headers.getSetCookie().find((c) => c.startsWith('__Host-zg_txn=')).split(';')[0].split('=')[1]
    );
    const res = await fetch(`${base}/auth/callback?code=abc&state=forged`, {
      headers: { cookie: `__Host-zg_txn=${txnId}` },
      redirect: 'manual',
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'invalid_state' });
  });

  test('a callback with no transaction is refused', async () => {
    const res = await fetch(`${base}/auth/callback?code=abc&state=whatever`, { redirect: 'manual' });
    assert.equal(res.status, 400);
  });

  test('the api is closed without a session', async () => {
    const res = await fetch(`${base}/api/v1/agents`);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'no_session' });
  });

  test('a completed login can read the api, and the browser never sees a token', async () => {
    const { cookie, status } = await login(base, h.txns);
    assert.equal(status, 302);

    const res = await fetch(`${base}/api/v1/agents`, { headers: { cookie } });
    assert.equal(res.status, 200);

    const proxied = h.calls.at(-1);
    assert.equal(proxied.url, 'http://gateway:8080/v1/agents');
    assert.equal(proxied.init.headers.get('authorization'), 'Bearer gateway-access-token');
    assert.doesNotMatch(cookie, /gateway-access-token/);
  });

  test('browser-supplied identity and credential headers never reach the gateway', async () => {
    const { cookie } = await login(base, h.txns);
    await fetch(`${base}/api/v1/agents`, {
      headers: {
        cookie,
        'x-tenant': 'someone-else',
        'x-forwarded-for': '10.0.0.1',
        'x-user-id': 'root',
      },
    });
    const sent = h.calls.at(-1).init.headers;
    assert.equal(sent.get('x-tenant'), null, 'a caller could assert its own tenant');
    assert.equal(sent.get('x-forwarded-for'), null);
    assert.equal(sent.get('x-user-id'), null);
    assert.equal(sent.get('cookie'), null, 'session cookie forwarded upstream');
  });

  test('a mutation without a matching Origin is refused (CSRF)', async () => {
    const { cookie } = await login(base, h.txns);
    const before = h.calls.length;

    const res = await fetch(`${base}/api/v1/agents`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ name: 'x' }),
    });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'bad_origin' });
    assert.equal(h.calls.length, before, 'the forged mutation still reached the gateway');
  });

  test('a mutation from the console origin is forwarded', async () => {
    const { cookie } = await login(base, h.txns);
    const res = await fetch(`${base}/api/v1/agents`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ name: 'echo' }),
    });
    assert.equal(res.status, 200);
    assert.equal(h.calls.at(-1).init.method, 'POST');
  });

  test('a cross-tenant 404 passes through unchanged', async () => {
    const h2 = harness({
      upstream: async () => new Response('', { status: 404 }),
    });
    const { server: s2, base: b2 } = await listen(h2.app);
    try {
      const { cookie } = await login(b2, h2.txns);
      const res = await fetch(`${b2}/api/v1/agents/other-tenant-agent`, { headers: { cookie } });
      assert.equal(res.status, 404, 'non-disclosure invariant broken');
    } finally {
      s2.close();
    }
  });

  test('logout destroys the server session, not just the cookie', async () => {
    const { cookie } = await login(base, h.txns);
    const out = await fetch(`${base}/auth/logout`, {
      method: 'POST',
      headers: { cookie, origin: ORIGIN },
    });
    assert.equal(out.status, 200);
    assert.equal(h.sessions.size, 0, 'session survived logout');

    const after = await fetch(`${base}/api/v1/agents`, { headers: { cookie } });
    assert.equal(after.status, 401);
  });

  test('logout itself is CSRF-protected', async () => {
    const { cookie } = await login(base, h.txns);
    const res = await fetch(`${base}/auth/logout`, {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.example' },
    });
    assert.equal(res.status, 403);
    assert.equal(h.sessions.size, 1, 'a cross-site page logged the operator out');
  });

  test('a failed provider exchange does not establish a session', async () => {
    const h2 = harness({
      oidc: fakeOIDC({
        exchangeCode: async () => {
          const e = new Error('console: token request failed (401)');
          e.status = 401;
          throw e;
        },
      }),
    });
    const { server: s2, base: b2 } = await listen(h2.app);
    try {
      const start = await fetch(`${b2}/auth/login`, { redirect: 'manual' });
      const txnId = decodeURIComponent(
        start.headers.getSetCookie().find((c) => c.startsWith('__Host-zg_txn=')).split(';')[0].split('=')[1]
      );
      const state = new URL(start.headers.get('location')).searchParams.get('state');
      const res = await fetch(`${b2}/auth/callback?code=abc&state=${state}`, {
        headers: { cookie: `__Host-zg_txn=${txnId}` },
        redirect: 'manual',
      });
      assert.equal(res.status, 401);
      assert.equal(h2.sessions.size, 0);
    } finally {
      s2.close();
    }
  });
});
