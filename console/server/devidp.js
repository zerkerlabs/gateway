// DEV ONLY. A throwaway OIDC provider that supports the authorization-code
// flow, so the console can be run and tested locally without an account at a
// real IdP. It is the browser-flow counterpart to gateway/scripts/mock-oidc,
// which only mints machine tokens.
//
// It authenticates nobody: /authorize redirects straight back with a code. It
// must never be pointed at anything real, and it is not part of the published
// console image.

import http from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

// `issuer` overrides the advertised issuer URL. Containers cannot reach a
// 127.0.0.1 issuer on the host, and the value must be byte-identical
// everywhere — the discovery document, the token's `iss`, and what each client
// was configured with — so it is one setting rather than something derived per
// caller.
export async function startDevIdP({ port = 0, clientId = 'console-dev', tenant = 'demo', subject = 'dev|1', issuer: issuerOverride } = {}) {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'dev', use: 'sig', alg: 'RS256' };
  const codes = new Map();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const issuer = issuerOverride || `http://127.0.0.1:${server.address().port}`;
    const json = (body, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/.well-known/openid-configuration') {
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks.json`,
        end_session_endpoint: `${issuer}/logout`,
      });
    }

    if (url.pathname === '/jwks.json') return json({ keys: [jwk] });

    if (url.pathname === '/authorize') {
      const code = Math.random().toString(36).slice(2);
      codes.set(code, {
        nonce: url.searchParams.get('nonce'),
        challenge: url.searchParams.get('code_challenge'),
      });
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }

    if (url.pathname === '/token') {
      const body = await new Promise((resolve) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => resolve(new URLSearchParams(raw)));
      });

      if (body.get('grant_type') === 'refresh_token') {
        return json({ access_token: await accessToken(), expires_in: 3600 });
      }

      const entry = codes.get(body.get('code'));
      if (!entry) return json({ error: 'invalid_grant' }, 400);
      codes.delete(body.get('code'));

      // PKCE is actually verified here — a stub that skipped it would let the
      // console's verifier handling regress without any test noticing.
      const { createHash } = await import('node:crypto');
      const expect = createHash('sha256').update(body.get('code_verifier') || '').digest('base64url');
      if (expect !== entry.challenge) return json({ error: 'invalid_grant' }, 400);

      const idToken = await new SignJWT({ nonce: entry.nonce, email: 'dev@zerker.ai', name: 'Dev Operator' })
        .setProtectedHeader({ alg: 'RS256', kid: 'dev' })
        .setIssuer(issuer)
        .setAudience(clientId)
        .setSubject(subject)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

      return json({
        access_token: await accessToken(),
        id_token: idToken,
        refresh_token: 'dev-refresh',
        expires_in: 3600,
      });
    }

    if (url.pathname === '/logout') {
      res.writeHead(302, { location: url.searchParams.get('returnTo') || '/' });
      return res.end();
    }

    res.writeHead(404);
    res.end();

    async function accessToken() {
      return new SignJWT({ 'https://zerker.ai/tenant': tenant, scope: 'openid profile email' })
        .setProtectedHeader({ alg: 'RS256', kid: 'dev' })
        .setIssuer(issuer)
        .setAudience('https://gateway.demo.zerker.ai')
        .setSubject(subject)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);
    }
  });

  // 0.0.0.0 so containers on a bridge network can reach it; this is a dev
  // fixture and binds wide on purpose.
  await new Promise((r) => server.listen(port, issuerOverride ? '0.0.0.0' : '127.0.0.1', r));
  return { server, issuer: `http://127.0.0.1:${server.address().port}` };
}

if (process.argv[1]?.endsWith('devidp.js')) {
  const { issuer } = await startDevIdP({
    port: Number(process.env.DEV_IDP_PORT) || 9099,
    issuer: process.env.DEV_IDP_ISSUER,
    tenant: process.env.DEV_IDP_TENANT || 'demo',
  });
  console.log(`dev-idp: ${issuer} — DEV ONLY, authenticates nobody`);
}
