// Shell state and the DOM affordances pages reach for.
//
// Separate from app.js so a page can be imported — and tested — without
// pulling in the stylesheet, the router, or a document. Everything here is
// either plain data or guarded against running headless.

export const state = {
  win: '24h',
  route: 'overview',
  sel: null,
  filters: {},
  identity: null,
  capabilities: null,
  fetchedAt: null,
  attention: 0,
};

const el = (id) => (typeof document === 'undefined' ? null : document.getElementById(id));

export function toast(message) {
  if (typeof document === 'undefined') return;
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = message;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 1800);
}

export function copyText(text) {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return toast(`Copy: ${text}`);
  return navigator.clipboard.writeText(text).then(
    () => toast('Copied'),
    () => toast(`Copy: ${text}`)
  );
}

export function openPanel(html) {
  const p = el('panel');
  if (!p) return;
  p.innerHTML = `<button class="close" aria-label="Close details" data-action="close-panel">×</button>${html}`;
  p.classList.add('open');
  p.setAttribute('aria-hidden', 'false');
}

// Panels load in two steps — a placeholder, then the record — and the second
// step must not reopen a panel the operator has already closed.
export function updatePanel(html) {
  const p = el('panel');
  if (p?.classList.contains('open')) openPanel(html);
}

export function closePanel() {
  const p = el('panel');
  if (!p) return;
  p.classList.remove('open');
  p.setAttribute('aria-hidden', 'true');
}
