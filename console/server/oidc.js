// OIDC authorization-code + PKCE client for a confidential (server-side) app.
//
// Token signature and claim validation is delegated to `jose` rather than
// hand-rolled, per AUTH_ARCHITECTURE.md ("a reviewed library"). What is
// implemented here is only the flow around it: discovery, PKCE, the code
// exchange, and refresh.

import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function randomToken() {
  return randomBytes(32).toString('base64url');
}

export class OIDCClient {
  #cfg;
  #meta = null;
  #jwks = null;

  constructor(cfg) {
    this.#cfg = cfg;
  }

  // Discovery is done once at boot and cached. Doing it lazily per request
  // would make the provider a hard dependency of every page load; doing it at
  // boot means a misconfigured issuer fails the container's start, loudly,
  // which is the same fail-closed posture the gateway takes.
  async discover(fetchImpl = fetch) {
    const url = `${this.#cfg.issuer}.well-known/openid-configuration`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`console: OIDC discovery failed (${res.status}) for ${url}`);
    const meta = await res.json();

    if (meta.issuer !== this.#cfg.issuer.replace(/\/$/, '') && meta.issuer !== this.#cfg.issuer) {
      throw new Error(
        `console: discovery issuer "${meta.issuer}" does not match configured "${this.#cfg.issuer}" ` +
          '(a missing or extra trailing slash is the usual cause)'
      );
    }

    this.#meta = meta;
    this.#jwks = createRemoteJWKSet(new URL(meta.jwks_uri));
    return meta;
  }

  get metadata() {
    if (!this.#meta) throw new Error('console: discover() has not run');
    return this.#meta;
  }

  authorizationURL({ state, nonce, challenge }) {
    const u = new URL(this.metadata.authorization_endpoint);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', this.#cfg.clientId);
    u.searchParams.set('redirect_uri', this.#cfg.redirectURI);
    // offline_access is what yields a refresh token, which is what lets the
    // BFF outlive a one-hour access token without bouncing the operator
    // through the provider mid-task.
    u.searchParams.set('scope', 'openid profile email offline_access');
    u.searchParams.set('audience', this.#cfg.audience);
    u.searchParams.set('state', state);
    u.searchParams.set('nonce', nonce);
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    return u.toString();
  }

  async exchangeCode({ code, verifier }, fetchImpl = fetch) {
    return this.#tokenRequest(
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.#cfg.redirectURI,
        code_verifier: verifier,
      },
      fetchImpl
    );
  }

  async refresh({ refreshToken }, fetchImpl = fetch) {
    return this.#tokenRequest(
      { grant_type: 'refresh_token', refresh_token: refreshToken },
      fetchImpl
    );
  }

  async #tokenRequest(params, fetchImpl) {
    const body = new URLSearchParams({
      ...params,
      client_id: this.#cfg.clientId,
      client_secret: this.#cfg.clientSecret,
    });

    const res = await fetchImpl(this.metadata.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!res.ok) {
      // The provider's response body can carry request-specific detail. It is
      // read for nothing here on purpose: AUTH_ARCHITECTURE.md forbids
      // surfacing or logging provider error bodies, so the caller gets the
      // status class and nothing else.
      const err = new Error(`console: token request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  // Validates the ID token and returns its claims. The nonce binding is what
  // ties this token to the authorization request this browser actually
  // started, so it is checked here rather than left to the caller.
  async verifyIdToken(idToken, { nonce }) {
    if (!this.#jwks) throw new Error('console: discover() has not run');

    const { payload } = await jwtVerify(idToken, this.#jwks, {
      issuer: this.metadata.issuer,
      audience: this.#cfg.clientId,
      clockTolerance: 30,
    });

    if (!payload.nonce || payload.nonce !== nonce) {
      throw new Error('console: ID token nonce mismatch');
    }
    return payload;
  }

  logoutURL() {
    const base = this.metadata.end_session_endpoint || `${this.#cfg.issuer}v2/logout`;
    const u = new URL(base);
    u.searchParams.set('client_id', this.#cfg.clientId);
    // Both spellings: Auth0's classic /v2/logout uses returnTo, the OIDC RP-
    // initiated logout endpoint uses post_logout_redirect_uri. Sending the
    // wrong one alone silently lands the user on the provider's page.
    u.searchParams.set('returnTo', this.#cfg.postLogoutURI);
    u.searchParams.set('post_logout_redirect_uri', this.#cfg.postLogoutURI);
    return u.toString();
  }
}
