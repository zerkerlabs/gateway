// The sign-in gate.
//
// The console renders nothing until the BFF confirms a session. This is a
// usability boundary, not a security one — every /api route is closed
// server-side regardless of what this file does, and the gate exists so an
// unauthenticated operator sees a sign-in screen instead of a wall of empty
// panels and 401s.

import { api } from './api.js';

export async function currentSession() {
  try {
    const s = await api.session();
    return s?.authenticated ? s.user : null;
  } catch {
    return null;
  }
}

export function renderSignIn(root, { reason } = {}) {
  const message =
    reason === 'expired'
      ? 'Your session ended. Sign in again to continue.'
      : 'This console administers a live Gateway tenant.';

  root.innerHTML = `
    <div class="signin">
      <div class="card">
        <div class="brand"><i></i>Zerker</div>
        <h1>Operator sign-in</h1>
        <p>${message}</p>
        <a class="btn" href="/auth/login" data-signin>Sign in</a>
        <p class="src">
          You will be redirected to your identity provider. The console's server holds the
          Gateway token; this browser never receives one.
        </p>
      </div>
    </div>`;
}

// Sign-out is a POST so it cannot be triggered by a link, an image, or a
// prefetch — and the BFF checks Origin on it for the same reason.
export async function signOut() {
  const res = await api.logout();
  // Ending the console session and ending the provider session are separate
  // events. Clearing ours and stopping would leave the operator silently
  // re-authenticated on the next sign-in.
  window.location.href = res?.providerLogoutURL || '/';
}
