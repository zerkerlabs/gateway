# Zerker Gateway console preview

A static, fixture-backed product prototype for the future Zerker Gateway operator console.

It is intentionally separate from:

- the Gateway API;
- the Gateway documentation website in `www/`;
- the Treeship product preview;
- any live agent or customer environment.

## Run locally

```bash
npm install
npm run dev
```

Vite serves the preview at `http://127.0.0.1:5173` by default.

## Quality gate

```bash
npm run check
```

The console has `noindex,nofollow` metadata. Every remote mission and pairing interaction is explicitly labeled as a non-operational preview.
