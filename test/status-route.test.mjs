/**
 * Tests for the status route that feeds the browser panel.
 *
 * The route is the only way the panel can see the den's real state, and it is
 * also the only new inbound surface the plugin exposes. Two things therefore need
 * pinning down: the envelope must be validated by hand (this plugin has no
 * `node_modules`, so it cannot import the shell's schema), and the panel must
 * never be shown an invented autonomy value.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

const { readEnvelope, rpcOk, rpcFail, statusSnapshot, mountStatusRoute } = await import('../src/status-route.js')

// ------------------------------------------------------------------ envelope

test('a well-formed client-request envelope is accepted', () => {
  const message = readEnvelope({ type: 'client-request', rpcId: 'r1', method: 'dsh.den/status', payload: { a: 1 } })
  assert.deepEqual(message, { rpcId: 'r1', method: 'dsh.den/status', payload: { a: 1 } })
})

test('malformed envelopes are rejected rather than guessed at', () => {
  const cases = [
    undefined,
    null,
    'client-request',
    42,
    {},
    { type: 'server-response', rpcId: 'r1', method: 'm' },
    { type: 'client-request', rpcId: '', method: 'm' },
    { type: 'client-request', rpcId: 'r1' },
    { type: 'client-request', method: 'm' },
    { type: 'client-request', rpcId: 7, method: 'm' },
    { type: 'client-request', rpcId: 'r1', method: 7 },
  ]
  for (const body of cases) {
    assert.equal(readEnvelope(body), undefined, `should reject ${JSON.stringify(body)}`)
  }
})

test('responses use the envelope the client unwraps', () => {
  assert.deepEqual(rpcOk('r9', { v: 1 }), { type: 'server-response', rpcId: 'r9', result: { ok: true, value: { v: 1 } } })
  assert.deepEqual(rpcFail('r9', 'CODE', 'boom'), {
    type: 'server-response',
    rpcId: 'r9',
    result: { ok: false, error: { code: 'CODE', message: 'boom' } },
  })
})

// ------------------------------------------------------------------- snapshot

function stubService(overrides = {}) {
  return {
    status: () => ({
      name: 'dsh-den',
      home: 'C:/den',
      ledger: { turns: 4 },
      notices: { total: 2, deliverable: 1, expired: 0 },
      triggers: { total: 3, invalid: 0, due: 0 },
      kernel: { running: true, lastTickAt: 1000, lastError: null },
      gate: 'mounted',
      recentEvents: [],
      reapedTempFiles: 2,
    }),
    gateAudit: () => [{ tool: 'read', rule: 'secret-read', risk: 3, decision: 'deny' }],
    listTriggers: () => ({
      valid: [
        { enabled: true, lastFiredAt: 100 },
        { enabled: true, lastFiredAt: 500 },
        { enabled: false, lastFiredAt: 10 },
      ],
      invalid: [],
    }),
    listScenarios: () => [{ scenario: 'personal', entries: 1 }],
    grantFor: () => ({ mode: 'standing', grantedAt: 5 }),
    ctx: { agents: { get: (id) => (id === 'known' ? { session: { id } } : undefined) } },
    ...overrides,
  }
}

test('the snapshot carries every field the panel renders', () => {
  const snap = statusSnapshot(stubService(), { nextTriggerAt: (trigger) => trigger.lastFiredAt + 1000 })
  for (const key of ['autonomy', 'nextCheckAt', 'ledger', 'notices', 'triggers', 'kernel', 'gate', 'scenarios', 'recentEvents']) {
    assert.ok(key in snap, `snapshot is missing ${key}`)
  }
  assert.equal(snap.gate.mounted, true)
  assert.equal(snap.gate.recent.length, 1)
  assert.equal(snap.ledger.turns, 4)
  assert.equal(snap.reapedTempFiles, 2)
})

test('the earliest enabled trigger supplies the next check, not the latest', () => {
  const snap = statusSnapshot(stubService(), { nextTriggerAt: (trigger) => trigger.lastFiredAt + 1000 })
  // Anchors 100 and 500 give 1100 and 1500; the disabled one must not win with 1010.
  assert.equal(snap.nextCheckAt, 1100)
})

test('no enabled trigger at all reports no next check rather than a bogus one', () => {
  const service = stubService({ listTriggers: () => ({ valid: [{ enabled: false, lastFiredAt: 1 }], invalid: [] }) })
  const snap = statusSnapshot(service, { nextTriggerAt: () => 999 })
  assert.equal(snap.nextCheckAt, null)
})

test('autonomy is reported as unknown without a session, never invented', () => {
  // This is the single most dangerous thing the panel could get wrong: showing
  // "granted" for a conversation that holds no standing authority.
  const snap = statusSnapshot(stubService(), { nextTriggerAt: () => 1 })
  assert.equal(snap.autonomy, null)
  assert.equal(snap.autonomyKnown, false)
})

test('autonomy is resolved from a session the host actually knows', () => {
  const snap = statusSnapshot(stubService(), { sessionId: 'known', nextTriggerAt: () => 1 })
  assert.deepEqual(snap.autonomy, { mode: 'standing', grantedAt: 5 })
  assert.equal(snap.autonomyKnown, true)
})

test('an unknown session stays unknown instead of falling back to a global value', () => {
  const snap = statusSnapshot(stubService(), { sessionId: 'stranger', nextTriggerAt: () => 1 })
  assert.equal(snap.autonomy, null)
  assert.equal(snap.autonomyKnown, false)
})

// ---------------------------------------------------------------- the surface

/** Drive the registered route handler directly, as the shell's fetch would. */
function mountRoute({ service = stubService(), ctxOverride } = {}) {
  const registered = []
  const ctx = ctxOverride ?? {
    get: (name) => (name === 'connection' ? { fetch: { register: (route) => (registered.push(route), () => {}) } } : undefined),
  }
  const route = mountStatusRoute(ctx, { service, nextTriggerAt: (trigger) => trigger.lastFiredAt + 1000 })
  return { route: registered[0], result: route, dispose: route.dispose, registered }
}

function post(route, body) {
  return route.fetch(
    new Request('http://localhost/api/dsh.den/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

test('a profile with no connection service reports why, instead of failing silently', () => {
  // The first version returned a bare no-op here. The panel then rendered, polled
  // forever, and showed an opaque HTTP 404, with nothing anywhere recording that
  // the route had never been registered. The reason must be readable.
  const result = mountStatusRoute({ get: () => undefined }, { service: stubService() })
  assert.equal(result.mounted, false)
  assert.equal(result.reason, 'no-connection-service')
  assert.equal(typeof result.dispose, 'function')
  assert.doesNotThrow(() => result.dispose())
})

test('every way the mount can fail names the failure', () => {
  const cases = [
    ['no-connection-service', { get: () => undefined }],
    ['no-connection-fetch', { get: () => ({}) }],
    ['no-connection-register', { get: () => ({ fetch: {} }) }],
    ['register-threw', { get: () => ({ fetch: { register: () => { throw new Error('route already registered') } } }) }],
    ['register-returned-no-disposer', { get: () => ({ fetch: { register: () => undefined } }) }],
    ['connection-lookup-threw', { get: () => { throw new Error('cannot get property "connection" without inject') } }],
  ]
  for (const [expected, ctx] of cases) {
    const result = mountStatusRoute(ctx, { service: stubService() })
    assert.equal(result.mounted, false, `${expected} should not mount`)
    assert.equal(result.reason, expected)
  }
})

test('a successful mount says so and hands back a working disposer', () => {
  const { result } = mountRoute()
  assert.equal(result.mounted, true)
  assert.equal(result.reason, null)
  assert.equal(typeof result.dispose, 'function')
})

test('the route registers one exact POST path on the shared channel', () => {
  const { route } = mountRoute()
  assert.ok(route, 'a route was registered')
  assert.equal(route.path, '/api/dsh.den/status')
  assert.deepEqual(route.methods, ['POST'])
  assert.equal(route.requestBody, 'buffered')
})

test('a valid request answers with a server-response carrying the snapshot', async () => {
  const { route } = mountRoute()
  const response = await post(route, { type: 'client-request', rpcId: 'r1', method: 'dsh.den/status', payload: {} })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.type, 'server-response')
  assert.equal(body.rpcId, 'r1')
  assert.equal(body.result.ok, true)
  assert.equal(body.result.value.name, 'dsh-den')
})

test('a payload session id is threaded through to the autonomy lookup', async () => {
  const { route } = mountRoute()
  const response = await post(route, {
    type: 'client-request',
    rpcId: 'r2',
    method: 'dsh.den/status',
    payload: { sessionId: 'known' },
  })
  const body = await response.json()
  assert.equal(body.result.value.autonomyKnown, true)
})

test('a malformed envelope is a 400 and never reaches the service', async () => {
  const { route } = mountRoute()
  const response = await post(route, { type: 'client-request', rpcId: 'r1' })
  assert.equal(response.status, 400)
})

test('a different method on the same route is not found', async () => {
  const { route } = mountRoute()
  const response = await post(route, { type: 'client-request', rpcId: 'r1', method: 'dsh.den/other' })
  assert.equal(response.status, 404)
})

test('a non-JSON content type is refused with 415', async () => {
  const { route } = mountRoute()
  const response = await route.fetch(
    new Request('http://localhost/api/dsh.den/status', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' }),
  )
  assert.equal(response.status, 415)
})

test('a failing service is reported in-band so the panel survives', async () => {
  // The panel polling this route must not be able to take the host process down.
  const service = stubService({
    status: () => {
      throw new Error('disk on fire')
    },
  })
  const { route } = mountRoute({ service })
  const response = await post(route, { type: 'client-request', rpcId: 'r1', method: 'dsh.den/status', payload: {} })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.result.ok, false)
  assert.equal(body.result.error.code, 'DEN_STATUS_FAILED')
  assert.match(body.result.error.message, /disk on fire/)
})

test('the mount hands back a disposer that unhooks the route', () => {
  const disposed = []
  const ctx = {
    get: () => ({ fetch: { register: () => () => disposed.push('route') } }),
  }
  const result = mountStatusRoute(ctx, { service: stubService() })
  assert.equal(disposed.length, 0, 'nothing disposed before the disposer runs')
  result.dispose()
  assert.deepEqual(disposed, ['route'])
})

test('disposal does not throw when the shell already dropped the route', () => {
  const ctx = { get: () => ({ fetch: { register: () => () => { throw new Error('already gone') } } }) }
  const result = mountStatusRoute(ctx, { service: stubService() })
  assert.doesNotThrow(() => result.dispose())
})
