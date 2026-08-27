// End-to-end: a real OIDC discovery, a real JWKS-verified ID token, a real
// PKCE exchange, and a real proxied call to a stub gateway. The unit tests use
// a fake provider; this one exercises the code paths that only run against an
// actual issuer — discovery, jose verification, and refresh.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startDevIdP } from './devidp.js';
import { OIDCClient } from './oidc.js';
import { SessionStore, TransactionStore } from './sessions.js';
import { createApp } from './index.js';

const silent = { info() {}, warn() {}, error() {}, log() {} };

describe('end to end against a real issuer', () => {
  let idp, gateway, consoleServer, base, received;

  before(async () => {
    idp = await startDevIdP();

    received = [];
    gateway = http.createServer((req, res) => {
      received.push({ method: req.method, url: req.url, auth: req.headers.authorization });
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        return req.on('end', () => {
          received.at(-1).body = body;
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'agt_new', name: JSON.parse(body).name, status: 'active' }));
        });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ agents: [{ id: 'agt_1', name: 'echo-http', status: 'active', protocol: 'http' }], page: 1, per_page: 50, total: 1 }));
    });
    await new Promise((r) => gateway.listen(0, '127.0.0.1', r));

    const consolePort = 0;
    const tmp = http.createServer();
    await new Promise((r) => tmp.listen(0, '127.0.0.1', r));
    const port = tmp.address().port;
    await new Promise((r) => tmp.close(r));

    const config = {
      port,
      origin: `http://127.0.0.1:${port}`,
      issuer: `${idp.issuer}/`,
      clientId: 'console-dev',
      clientSecret: 'dev-secret',
      audience: 'https://gateway.demo.zerker.ai',
      gatewayBaseURL: `http://127.0.0.1:${gateway.address().port}`,
      redirectURI: `http://127.0.0.1:${port}/auth/callback`,
      postLogoutURI: `http://127.0.0.1:${port}/`,
      cookieSecure: false,
      sessionIdleMs: 60_000,
      sessionAbsoluteMs: 600_000,
      txnTtlMs: 60_000,
      staticDir: '../dist',
    };

    const oidc = new OIDCClient(config);
    await oidc.discover();

    const app = createApp({
      config,
      oidc,
      sessions: new SessionStore({ idleMs: config.sessionIdleMs, absoluteMs: config.sessionAbsoluteMs }),
      txns: new TransactionStore({ ttlMs: config.txnTtlMs }),
      logger: silent,
    });
    consoleServer = app.listen(port, '127.0.0.1');
    await new Promise((r) => consoleServer.once('listening', r));
    base = config.origin;
  });

  after(async () => {
    consoleServer?.close();
    gateway?.close();
    idp?.server.close();
  });

  test('a full browser login yields a working session and never exposes a token', async () => {
    // 1. the console sends the browser to the provider
    const start = await fetch(`${base}/auth/login`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const txn = start.headers.getSetCookie().find((c) => c.startsWith('zg_txn='));
    const authorizeURL = start.headers.get('location');
    assert.match(authorizeURL, /code_challenge_method=S256/);
    assert.match(authorizeURL, /audience=https/);

    // 2. the provider bounces back with a code
    const bounced = await fetch(authorizeURL, { redirect: 'manual' });
    const callbackURL = bounced.headers.get('location');

    // 3. the console exchanges it, verifies the ID token against live JWKS
    const cb = await fetch(callbackURL, {
      headers: { cookie: txn.split(';')[0] },
      redirect: 'manual',
    });
    assert.equal(cb.status, 302, 'callback did not establish a session');
    assert.equal(cb.headers.get('location'), '/');

    const session = cb.headers.getSetCookie().find((c) => c.startsWith('zg_session='));
    assert.ok(session, 'no session cookie issued');
    assert.match(session, /HttpOnly/);
    const cookie = session.split(';')[0];

    // 4. the session identifies the operator, without handing over a token
    const me = await fetch(`${base}/auth/session`, { headers: { cookie } }).then((r) => r.json());
    assert.equal(me.authenticated, true);
    assert.equal(me.user.email, 'dev@zerker.ai');
    assert.equal(me.user.accessToken, undefined, 'a token reached the browser');

    // 5. reads reach the gateway with a bearer the browser never saw
    const list = await fetch(`${base}/api/v1/agents?per_page=100`, { headers: { cookie } });
    assert.equal(list.status, 200);
    assert.equal((await list.json()).agents[0].name, 'echo-http');
    assert.match(received.at(-1).auth, /^Bearer eyJ/);
    assert.equal(received.at(-1).url, '/v1/agents?per_page=100');

    // 6. registering an agent — the thing the console exists to do
    const created = await fetch(`${base}/api/v1/agents`, {
      method: 'POST',
      headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'docs-fetch', upstream_url: 'https://example.com' }),
    });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).name, 'docs-fetch');
    assert.equal(JSON.parse(received.at(-1).body).upstream_url, 'https://example.com');
  });

  test('the console is served for an unknown path so the SPA can route', async () => {
    const res = await fetch(`${base}/some/deep/link`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /html/);
    assert.match(await res.text(), /ZERKER/);
  });

  test('security headers are set on every response', async () => {
    const res = await fetch(`${base}/healthz`);
    assert.match(res.headers.get('content-security-policy'), /connect-src 'self'/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });
});
