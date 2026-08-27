// Configuration for the console BFF.
//
// Every value is operator configuration read once at boot. Nothing here is
// derived from a request: AUTH_ARCHITECTURE.md requires redirects and origins
// be built from approved configuration and never from untrusted request
// headers, which is what closes the open-redirect and host-header classes.

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`console: ${name} is required`);
  return v;
}

function optionalInt(name, def) {
  const v = process.env[name];
  if (!v) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`console: ${name} must be a positive integer`);
  return n;
}

export function loadConfig(env = process.env) {
  // Trailing slash matters: Auth0's discovery document issues `iss` with one,
  // and a mismatch fails every token with an error that does not say why.
  const issuer = required('CONSOLE_OIDC_ISSUER');

  // The public origin of this console, e.g. https://console.demo.zerker.ai.
  // Callback and logout URLs are built from it, so it must match exactly what
  // is registered at the provider.
  const origin = required('CONSOLE_ORIGIN').replace(/\/$/, '');

  return {
    port: optionalInt('CONSOLE_PORT', 8095),
    origin,
    issuer: issuer.endsWith('/') ? issuer : `${issuer}/`,
    clientId: required('CONSOLE_OIDC_CLIENT_ID'),
    clientSecret: required('CONSOLE_OIDC_CLIENT_SECRET'),

    // Must equal the gateway's ZERKER_OIDC_AUDIENCE. The gateway builds one
    // verifier for one audience, so console tokens and machine tokens share it.
    audience: required('CONSOLE_OIDC_AUDIENCE'),

    gatewayBaseURL: (env.CONSOLE_GATEWAY_BASE_URL || 'http://gateway:8080').replace(/\/$/, ''),

    redirectURI: `${origin}/auth/callback`,
    postLogoutURI: `${origin}/`,

    // Secure cookies are the production posture. The only reason this is a
    // switch is plain-HTTP localhost; it must never be turned off in front of
    // real traffic, so it defaults to on.
    cookieSecure: env.CONSOLE_COOKIE_INSECURE !== 'true',

    // Both bounds exist on purpose. Idle expiry logs out an abandoned tab;
    // absolute expiry caps how long any one session can live regardless of
    // activity, so a stolen session identifier is not indefinitely useful.
    sessionIdleMs: optionalInt('CONSOLE_SESSION_IDLE_MINUTES', 60) * 60_000,
    sessionAbsoluteMs: optionalInt('CONSOLE_SESSION_ABSOLUTE_HOURS', 12) * 3_600_000,

    // How long a login may sit half-finished between /auth/login and the
    // provider redirecting back.
    txnTtlMs: optionalInt('CONSOLE_LOGIN_TXN_MINUTES', 10) * 60_000,

    staticDir: env.CONSOLE_STATIC_DIR || '../dist',
  };
}
