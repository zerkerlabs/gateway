// The console backend-for-frontend.
//
// It does three things: run the login flow, hold the resulting tokens
// server-side, and proxy same-origin /api requests to the gateway with a
// bearer the browser never sees. Everything else is a static file.
//
// The security posture is the one recorded in AUTH_ARCHITECTURE.md. The
// comments below say which control each block implements, because most of
// them look like ceremony until you know what they are for.

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { OIDCClient, pkcePair, randomToken } from './oidc.js';
import { SessionStore, TransactionStore, safeEqual } from './sessions.js';

// The __Host- prefix makes the browser itself enforce that the cookie is
// origin-locked: no Domain, Path=/, and Secure. A subdomain then cannot set or
// overwrite it. The prefix is only legal on a Secure cookie though, so plain
// names are used for the localhost-over-HTTP development mode — browsers
// reject a non-Secure __Host- cookie outright, which would look like login
// silently not working.
function cookieNames(secure) {
  return secure
    ? { session: '__Host-zg_session', txn: '__Host-zg_txn' }
    : { session: 'zg_session', txn: 'zg_txn' };
}

// Request headers the browser may influence that must never reach the
// gateway. Authorization and cookie are constructed or dropped here so a page
// cannot smuggle its own credentials; the forwarding and tenant families are
// dropped because the gateway derives tenant from the token and must not be
// able to read it from anything a caller can set.
const STRIPPED = new Set([
  'authorization', 'cookie', 'host', 'connection', 'keep-alive',
  'proxy-authorization', 'proxy-authenticate', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'content-length',
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded',
  'x-real-ip', 'x-tenant', 'x-tenant-id', 'x-user', 'x-user-id',
]);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res, name, value, { maxAgeMs, secure }) {
  const bits = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure) bits.push('Secure');
  res.append('Set-Cookie', bits.join('; '));
}

function clearCookie(res, name, { secure }) {
  const bits = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) bits.push('Secure');
  res.append('Set-Cookie', bits.join('; '));
}

export function createApp({ config, oidc, sessions, txns, fetchImpl = fetch, logger = console }) {
  const app = express();
  app.disable('x-powered-by');

  const { session: SESSION_COOKIE, txn: TXN_COOKIE } = cookieNames(config.cookieSecure);

  // We never read the client address or protocol from a forwarded header —
  // redirects come from config — so there is no proxy to trust. Leaving this
  // off means a spoofed X-Forwarded-* header cannot influence anything.
  app.set('trust proxy', false);

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; " +
        "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; " +
        "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY',
      'X-Robots-Tag': 'noindex, nofollow',
      'Cache-Control': 'no-store',
    });
    req.cookies = parseCookies(req.headers.cookie);
    next();
  });

  app.get('/healthz', (_req, res) => res.status(200).json({ status: 'ok' }));

  // ---- login -------------------------------------------------------------

  app.get('/auth/login', (req, res) => {
    const state = randomToken();
    const nonce = randomToken();
    const { verifier, challenge } = pkcePair();

    const txnId = txns.create({ state, nonce, verifier });
    setCookie(res, TXN_COOKIE, txnId, { maxAgeMs: config.txnTtlMs, secure: config.cookieSecure });

    res.redirect(302, oidc.authorizationURL({ state, nonce, challenge }));
  });

  app.get('/auth/callback', async (req, res) => {
    const txn = txns.consume(req.cookies[TXN_COOKIE]);
    clearCookie(res, TXN_COOKIE, { secure: config.cookieSecure });

    // A callback with no live transaction is either a replay, an expired
    // login, or a cross-site forgery of the login step itself. All three get
    // the same answer.
    if (!txn) return fail(res, 400, 'login_expired');
    if (!safeEqual(String(req.query.state || ''), txn.state)) return fail(res, 400, 'invalid_state');

    if (req.query.error) {
      logger.warn('console: provider returned an authorization error', { code: String(req.query.error) });
      return fail(res, 401, 'login_failed');
    }

    const code = String(req.query.code || '');
    if (!code) return fail(res, 400, 'missing_code');

    try {
      const tokens = await oidc.exchangeCode({ code, verifier: txn.verifier }, fetchImpl);
      const claims = await oidc.verifyIdToken(tokens.id_token, { nonce: txn.nonce });

      // A pre-authentication identifier must not carry over into the
      // authenticated session. Create fresh, then rotate.
      const tmpId = sessions.create({
        sub: claims.sub,
        email: claims.email ?? null,
        name: claims.name ?? null,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        accessExpiresAt: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
      });
      const id = sessions.rotate(tmpId);

      setCookie(res, SESSION_COOKIE, id, {
        maxAgeMs: config.sessionAbsoluteMs,
        secure: config.cookieSecure,
      });
      logger.info('console: session established', { sub: claims.sub });
      return res.redirect(302, '/');
    } catch (err) {
      // err.message can name the failing claim. It is logged as a category
      // only; claim values are credentials-adjacent (AGENTS.md invariant #4).
      logger.warn('console: login failed', { reason: classify(err) });
      return fail(res, 401, 'login_failed');
    }
  });

  app.get('/auth/session', (req, res) => {
    const s = sessions.get(req.cookies[SESSION_COOKIE]);
    if (!s) return res.status(200).json({ authenticated: false });
    // Tokens and claims stay server-side. The browser learns who it is and
    // nothing it could replay.
    return res.status(200).json({
      authenticated: true,
      user: { sub: s.sub, email: s.email, name: s.name },
    });
  });

  app.post('/auth/logout', (req, res) => {
    if (!originAllowed(req, config)) return fail(res, 403, 'bad_origin');
    // Server state first, then the cookie. A cleared cookie alone is not
    // logout — it just hides a session that still exists.
    sessions.destroy(req.cookies[SESSION_COOKIE]);
    clearCookie(res, SESSION_COOKIE, { secure: config.cookieSecure });
    return res.status(200).json({ ok: true, providerLogoutURL: oidc.logoutURL() });
  });

  // ---- the gateway proxy -------------------------------------------------

  app.use('/api', async (req, res) => {
    const s = sessions.get(req.cookies[SESSION_COOKIE]);
    if (!s) return fail(res, 401, 'no_session');

    // Cookie authentication means CSRF is in scope for every state-changing
    // request. SameSite=Lax is the first line and this is the second, because
    // SameSite alone is not the complete control.
    if (!SAFE_METHODS.has(req.method) && !originAllowed(req, config)) {
      return fail(res, 403, 'bad_origin');
    }

    let token;
    try {
      token = await accessTokenFor(s, { oidc, fetchImpl });
    } catch (err) {
      logger.warn('console: token refresh failed', { reason: classify(err) });
      sessions.destroy(req.cookies[SESSION_COOKIE]);
      clearCookie(res, SESSION_COOKIE, { secure: config.cookieSecure });
      return fail(res, 401, 'session_expired');
    }

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (STRIPPED.has(k.toLowerCase())) continue;
      if (typeof v === 'string') headers.set(k, v);
    }
    headers.set('authorization', `Bearer ${token}`);

    const url = `${config.gatewayBaseURL}${req.originalUrl.replace(/^\/api/, '')}`;

    try {
      const upstream = await fetchImpl(url, {
        method: req.method,
        headers,
        // `req` itself, not a parsed body: no body parser runs in this
        // process, so agent payloads stream through without the console ever
        // holding, parsing, or logging them.
        body: SAFE_METHODS.has(req.method) ? undefined : req,
        duplex: 'half',
        redirect: 'manual',
      });

      // Status is passed through untouched. That matters most for 404: the
      // gateway answers cross-tenant resources with a bare 404 and the console
      // must not turn that into anything that confirms the resource exists.
      res.status(upstream.status);
      const ct = upstream.headers.get('content-type');
      if (ct) res.set('content-type', ct);

      const buf = Buffer.from(await upstream.arrayBuffer());
      return res.send(buf);
    } catch (err) {
      logger.error('console: gateway request failed', {
        method: req.method,
        path: req.path,
        reason: classify(err),
      });
      return fail(res, 502, 'gateway_unreachable');
    }
  });

  // ---- static console ----------------------------------------------------

  const here = path.dirname(fileURLToPath(import.meta.url));
  const dist = path.resolve(here, config.staticDir);
  app.use(express.static(dist, { index: false, maxAge: '5m' }));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));

  return app;
}

// Origin must match the one configured origin exactly. Referer is checked only
// as a fallback for the rare client that omits Origin; neither is trusted for
// anything except this comparison.
function originAllowed(req, config) {
  const origin = req.headers.origin;
  if (origin) return origin === config.origin;
  const referer = req.headers.referer;
  if (!referer) return false;
  try {
    return new URL(referer).origin === config.origin;
  } catch {
    return false;
  }
}

// Refresh slightly early so a request is never sent with a token that expires
// in flight.
async function accessTokenFor(session, { oidc, fetchImpl }) {
  if (Date.now() < session.accessExpiresAt - 60_000) return session.accessToken;
  if (!session.refreshToken) throw new Error('console: access token expired and no refresh token');

  const tokens = await oidc.refresh({ refreshToken: session.refreshToken }, fetchImpl);
  session.accessToken = tokens.access_token;
  session.accessExpiresAt = Date.now() + (Number(tokens.expires_in) || 3600) * 1000;
  // Auth0 rotates refresh tokens when rotation is enabled; keep the new one or
  // the next refresh uses a token the provider has already retired.
  if (tokens.refresh_token) session.refreshToken = tokens.refresh_token;
  return session.accessToken;
}

// A stable, caller-safe category. Never the provider's message, which can
// embed claim values.
function classify(err) {
  const m = String(err?.message || '');
  if (m.includes('nonce')) return 'nonce_mismatch';
  if (m.includes('signature')) return 'signature_invalid';
  if (m.includes('exp') || m.includes('expired')) return 'expired';
  if (m.includes('aud')) return 'audience_mismatch';
  if (m.includes('iss')) return 'issuer_mismatch';
  if (err?.status) return `provider_${err.status}`;
  if (err?.cause?.code) return String(err.cause.code);
  return 'unknown';
}

// One error shape, no detail. Anything a caller could use to distinguish "does
// not exist" from "not yours" belongs to the gateway, not to this layer.
function fail(res, status, code) {
  return res.status(status).json({ error: code });
}

export async function main() {
  const config = loadConfig();
  const oidc = new OIDCClient(config);
  await oidc.discover();

  const sessions = new SessionStore({
    idleMs: config.sessionIdleMs,
    absoluteMs: config.sessionAbsoluteMs,
  });
  const txns = new TransactionStore({ ttlMs: config.txnTtlMs });

  const sweep = setInterval(() => {
    sessions.sweep();
    txns.sweep();
  }, 60_000);
  sweep.unref();

  const app = createApp({ config, oidc, sessions, txns });
  app.listen(config.port, () => {
    console.log(`console: listening on :${config.port} for ${config.origin}`);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`console: failed to start — ${err.message}`);
    process.exit(1);
  });
}
