import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  filterCredentials,
  liveCredentialsState,
  liveCredentialsView,
  normalizeCredential,
  referencingAgents,
} from './credentials-view.js';
import { liveAgentsState } from './agents-view.js';
import { normalizeAgent } from './api.js';

function credential(over = {}) {
  return normalizeCredential({
    id: 'cred_1',
    name: 'Support upstream key',
    auth_type: 'bearer',
    source: 'managed',
    masked_hint: 'sk-***9f21',
    version: 3,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-20T00:00:00Z',
    ...over,
  });
}

function agent(over = {}) {
  return normalizeAgent({
    id: 'agt_1',
    name: 'Support agent',
    status: 'active',
    protocol: 'http',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    ...over,
  });
}

// --- normalizeCredential -------------------------------------------------

test('normalizeCredential keeps the live field names, not the fixture ones', () => {
  const c = credential({ source: 'vault', vault_ref: 'kv/prod/support-key', masked_hint: undefined });
  assert.equal(c.source, 'vault');
  assert.equal(c.vaultRef, 'kv/prod/support-key');
  // Renamed from the fixture's maskedLastFour.
  assert.equal(c.maskedHint, null);
});

test('a managed credential carries masked_hint, not vault_ref', () => {
  const c = credential({ source: 'managed', masked_hint: 'sk-***9f21' });
  assert.equal(c.maskedHint, 'sk-***9f21');
  assert.equal(c.vaultRef, null);
});

// --- referencingAgents -----------------------------------------------------

test('referencingAgents joins on credential_ref by id', () => {
  const agents = [
    agent({ id: 'agt_a', credential_ref: 'cred_1' }),
    agent({ id: 'agt_b', credential_ref: 'cred_2' }),
    agent({ id: 'agt_c', credential_ref: 'cred_1' }),
  ];
  const refs = referencingAgents('cred_1', agents).map((a) => a.id);
  assert.deepEqual(refs, ['agt_a', 'agt_c']);
});

test('an unreferenced credential has no referencing agents', () => {
  const agents = [agent({ id: 'agt_a', credential_ref: 'cred_9' })];
  assert.deepEqual(referencingAgents('cred_1', agents), []);
});

// --- filterCredentials -------------------------------------------------------

function withAgents(agents, fn, { total = agents.length } = {}) {
  const saved = [...liveAgentsState.agents];
  const savedError = liveAgentsState.error;
  const savedTotal = liveAgentsState.agentsTotal;
  liveAgentsState.agents = agents;
  liveAgentsState.error = null;
  liveAgentsState.agentsTotal = total;
  try {
    return fn();
  } finally {
    liveAgentsState.agents = saved;
    liveAgentsState.error = savedError;
    liveAgentsState.agentsTotal = savedTotal;
  }
}

test('filterCredentials narrows by source, auth type and reference independently', () => {
  withAgents([agent({ id: 'agt_a', credential_ref: 'cred_1' })], () => {
    const creds = [
      credential({ id: 'cred_1', source: 'managed', auth_type: 'bearer' }),
      credential({ id: 'cred_2', source: 'vault', auth_type: 'api_key' }),
    ];
    const ids = (f) => filterCredentials(creds, { query: '', source: 'all', authType: 'all', reference: 'all', ...f }).map((c) => c.id);

    assert.deepEqual(ids({ source: 'vault' }), ['cred_2']);
    assert.deepEqual(ids({ authType: 'bearer' }), ['cred_1']);
    assert.deepEqual(ids({ reference: 'referenced' }), ['cred_1']);
    assert.deepEqual(ids({ reference: 'unreferenced' }), ['cred_2']);
  });
});

test('filterCredentials searches id, name, auth type and source', () => {
  withAgents([], () => {
    const creds = [credential({ id: 'cred_1', name: 'Support key' }), credential({ id: 'cred_2', name: 'Docs key' })];
    const ids = (q) => filterCredentials(creds, { query: q, source: 'all', authType: 'all', reference: 'all' }).map((c) => c.id);
    assert.deepEqual(ids('docs'), ['cred_2']);
    assert.deepEqual(ids('CRED_1'), ['cred_1']);
  });
});

// --- rendering ---------------------------------------------------------------

function withState(over, fn) {
  const saved = { ...liveCredentialsState };
  Object.assign(liveCredentialsState, {
    status: 'ready',
    error: null,
    credentials: [],
    filters: { query: '', source: 'all', authType: 'all', reference: 'all' },
    ...over,
  });
  try {
    return fn(liveCredentialsView());
  } finally {
    Object.assign(liveCredentialsState, saved);
  }
}

test('the field names on screen are masked_hint and vault, not fixture names', () => {
  withAgents([], () => {
    withState({ credentials: [credential({ source: 'vault', vault_ref: 'kv/prod/x', masked_hint: undefined })] }, (html) => {
      assert.match(html, /Vault reference/);
      assert.match(html, /kv\/prod\/x/);
      assert.doesNotMatch(html, /external_vault/);
    });
  });
});

test('a managed credential shows its masked hint verbatim', () => {
  withAgents([], () => {
    withState({ credentials: [credential({ masked_hint: 'weird-hint-not-4-chars' })] }, (html) => {
      assert.match(html, /weird-hint-not-4-chars/);
    });
  });
});

test('references resolve to agent names, not the raw credential_ref id alone', () => {
  withAgents([agent({ id: 'agt_a', name: 'Support agent', credential_ref: 'cred_1' })], () => {
    withState({ credentials: [credential({ id: 'cred_1' })] }, (html) => {
      assert.match(html, /Support agent/);
      assert.match(html, /Referenced/);
    });
  });
});

test('an unreferenced credential is distinguished from a referenced one', () => {
  withAgents([], () => {
    withState({ credentials: [credential({ id: 'cred_1' })] }, (html) => {
      assert.match(html, /Not referenced/);
    });
  });
});

test('a failed agent catalog read makes references unknown, not falsely unreferenced', () => {
  withAgents([], () => {
    liveAgentsState.error = 'boom';
    try {
      withState({ credentials: [credential({ id: 'cred_1' })] }, (html) => {
        assert.match(html, /Agent catalog unavailable/);
        assert.doesNotMatch(html, /Not referenced/);
      });
    } finally {
      liveAgentsState.error = null;
    }
  });
});

test('an incomplete agent catalog makes references unknown, not falsely unreferenced', () => {
  // agents-view.js only fetches one page (per_page=100). If the tenant has
  // more agents than were loaded, a credential referenced only by an agent
  // past that page must not read as "Not referenced".
  withAgents([agent({ id: 'agt_a', credential_ref: 'cred_9' })], () => {
    withState({ credentials: [credential({ id: 'cred_1' })] }, (html) => {
      assert.match(html, /Agent catalog unavailable or incomplete/);
      assert.doesNotMatch(html, /Not referenced/);
    });
  }, { total: 150 });
});

test('no write control exists anywhere on the page', () => {
  withAgents([], () => {
    withState({ credentials: [credential()] }, (html) => {
      // The delete-conflict posture is described in running copy (see the next
      // test) but never offered as an action — no button triggers a mutation.
      assert.doesNotMatch(html, /<button[^>]*>\s*(Rotate|Delete|Reveal|Copy)/i);
      assert.doesNotMatch(html, /data-live-credential-action="(rotate|delete|reveal|copy|create|add)"/);
      assert.doesNotMatch(html, /<form/i);
      assert.doesNotMatch(html, /type="password"/i);
    });
  });
});

test('the delete-conflict posture is described without offering delete', () => {
  withAgents([], () => {
    withState({ credentials: [credential()] }, (html) => {
      assert.match(html, /409/);
      assert.match(html, /still referenced/i);
      assert.doesNotMatch(html, /data-live-credential-action="delete"/);
    });
  });
});

test('an empty tenant credential list says empty, not unavailable', () => {
  withAgents([], () => {
    withState({ credentials: [] }, (html) => {
      assert.match(html, /empty — not unavailable/);
    });
  });
});

test('an error state offers a retry', () => {
  withState({ status: 'error', error: 'Gateway is unreachable from the console.' }, (html) => {
    assert.match(html, /unreachable/);
    assert.match(html, /data-live-credential-action="retry"/);
  });
});

test('credential-supplied text is escaped, not injected', () => {
  withAgents([], () => {
    withState({ credentials: [credential({ name: '<img src=x onerror=alert(1)>' })] }, (html) => {
      assert.doesNotMatch(html, /<img src=x/);
      assert.match(html, /&lt;img src=x/);
    });
  });
});

test('the filter comment explains why filtering is complete client-side', () => {
  withAgents([], () => {
    withState({ credentials: [credential()] }, (html) => {
      assert.match(html, /returns every credential/i);
    });
  });
});
