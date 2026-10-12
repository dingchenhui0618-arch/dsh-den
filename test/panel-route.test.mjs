/**
 * Tests for the panel's host-side surface.
 *
 * Two halves now live in two modules, and the split is the point: `panel-api.js`
 * holds the actions and the snapshot with no transport in them, and
 * `panel-route.js` holds the one route that exposes them. The transport tests here
 * pin the route to the shape the running profile actually uses — a prefix route on
 * the host web server, reached with a plain `fetch` — because an earlier version
 * mounted an exact route under `/api` on `connection.fetch`, which the host half
 * reported as mounted while no plugin in this profile demonstrated a browser could
 * reach it.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

const { statusSnapshot } = await import('../src/panel-api.js')
const { mountPanelRoute, ROUTE } = await import('../src/panel-route.js')

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

/** Drive the registered route handler directly, as the host web server would. */
function mountRoute({ service = stubService(), ctxOverride } = {}) {
  const registered = []
  const ctx = ctxOverride ?? {
    webServer: { register: (route) => (registered.push(route), () => {}) },
  }
  const route = mountPanelRoute(ctx, { service, nextTriggerAt: (trigger) => trigger.lastFiredAt + 1000 })
  return { route: registered[0], result: route, dispose: route.dispose, registered }
}

/**
 * A request stand-in shaped like the one the host web server hands a route: the
 * route reads the payload through `text()`, so a bare `body` property would make
 * every POST look like a malformed body.
 */
function makeReq({ method = 'POST', url = ROUTE, rawBody = '' } = {}) {
  return {
    method,
    url,
    async text() {
      return rawBody
    },
  }
}

/** A response stand-in: the handler writes through writeHead/end. */
function makeRes() {
  const captured = { status: null, headers: null, body: '' }
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers
    },
    end(text) {
      captured.body = String(text)
    },
  }
}

/** POST one action the way the browser panel does. */
async function post(route, body) {
  const res = makeRes()
  await route.handler(makeReq({ rawBody: JSON.stringify(body) }), res)
  return { status: res.captured.status, json: JSON.parse(res.captured.body) }
}

test('a profile with no web server reports why, instead of failing silently', () => {
  // The first version returned a bare no-op here. The panel then rendered, polled
  // forever, and showed an opaque HTTP 404, with nothing anywhere recording that
  // the route had never been registered. The reason must be readable.
  const result = mountPanelRoute({}, { service: stubService() })
  assert.equal(result.mounted, false)
  assert.equal(result.reason, 'no-webserver-service')
  assert.equal(typeof result.dispose, 'function')
  assert.doesNotThrow(() => result.dispose())
})

test('every way the mount can fail names the failure', () => {
  const cases = [
    ['no-context', undefined],
    ['no-webserver-service', {}],
    ['webserver-has-no-register', { webServer: {} }],
    ['register-threw', { webServer: { register: () => { throw new Error('route already registered') } } }],
    ['register-returned-no-disposer', { webServer: { register: () => undefined } }],
  ]
  for (const [expected, ctx] of cases) {
    const result = mountPanelRoute(ctx, { service: stubService() })
    assert.equal(result.mounted, false, `${expected} should not mount`)
    assert.equal(result.reason, expected)
  }
})

test('a successful mount says so and hands back a working disposer', () => {
  const { result } = mountRoute()
  assert.equal(result.mounted, true)
  assert.equal(result.reason, null)
  assert.equal(result.path, ROUTE)
  assert.equal(typeof result.dispose, 'function')
})

test('the route is a prefix route at the package path, like every other client plugin here', () => {
  const { registered } = mountRoute()
  assert.equal(registered.length, 1)
  assert.equal(registered[0].kind, 'prefix')
  assert.equal(registered[0].path, ROUTE)
  assert.equal(ROUTE, '/dsh-den')
  assert.equal(typeof registered[0].handler, 'function')
})

test('a GET answers with the snapshot, so the route is inspectable in a browser', async () => {
  const { route } = mountRoute()
  const res = makeRes()
  await route.handler(makeReq({ method: 'GET' }), res)
  assert.equal(res.captured.status, 200)
  const body = JSON.parse(res.captured.body)
  assert.equal(body.ok, true)
  assert.equal(body.value.name, 'dsh-den')
})

test('a POST action answers with the snapshot in the panel response shape', async () => {
  const { route } = mountRoute()
  const response = await post(route, { action: 'status' })
  assert.equal(response.status, 200)
  assert.equal(response.json.ok, true)
  assert.equal(response.json.value.name, 'dsh-den')
  assert.equal(response.json.value.ledger.turns, 4)
})

test('a payload session id is threaded through to the autonomy lookup', async () => {
  const { route } = mountRoute()
  const response = await post(route, { action: 'status', sessionId: 'known' })
  assert.equal(response.json.value.autonomyKnown, true)
})

test('a body that is not JSON is refused, and never reaches the service', async () => {
  const { route } = mountRoute()
  const res = makeRes()
  await route.handler(makeReq({ rawBody: '{not json' }), res)
  assert.equal(res.captured.status, 400)
  assert.equal(JSON.parse(res.captured.body).error.code, 'BAD_JSON')
})

test('an empty body is treated as a plain status read', async () => {
  const { route } = mountRoute()
  const res = makeRes()
  await route.handler(makeReq({ rawBody: '' }), res)
  assert.equal(JSON.parse(res.captured.body).value.name, 'dsh-den')
})

test('a method the route does not serve is refused rather than ignored', async () => {
  const { route } = mountRoute()
  const res = makeRes()
  await route.handler(makeReq({ method: 'DELETE' }), res)
  assert.equal(res.captured.status, 405)
})

test('the path suffix can name the action, and an unserved method is still refused', async () => {
  // The reference plugins accept `/<route>/<segment>` as well as a JSON body. The
  // point of the assertion is the dispatch, not the service's answer: `listTriggers`
  // is absent from the stub, so the action is refused in-band rather than the route
  // 404-ing on a path it does serve.
  const { route } = mountRoute()
  const res = makeRes()
  await route.handler(makeReq({ url: `${ROUTE}/schedules/list`, rawBody: '{}' }), res)
  assert.equal(res.captured.status, 200, 'the path is served, whatever the action then decides')
  const body = JSON.parse(res.captured.body)
  assert.equal(typeof body.ok, 'boolean')

  // And a route the plugin does not own is a 405, not a silent success.
  const other = makeRes()
  await route.handler(makeReq({ method: 'DELETE' }), other)
  assert.equal(other.captured.status, 405)
})

test('a failing service is reported in-band so the panel survives', async () => {
  // The panel polling this route must not be able to take the host process down.
  const service = stubService({
    status: () => {
      throw new Error('disk on fire')
    },
  })
  const { route } = mountRoute({ service })
  const response = await post(route, { action: 'status' })
  assert.equal(response.status, 200)
  assert.equal(response.json.ok, false)
  assert.equal(response.json.error.code, 'DEN_ACTION_FAILED')
  assert.match(response.json.error.message, /disk on fire/)
})

test('the mount hands back a disposer that unhooks the route', () => {
  const disposed = []
  const ctx = {
    webServer: { register: () => () => disposed.push('route') },
  }
  const result = mountPanelRoute(ctx, { service: stubService() })
  assert.equal(disposed.length, 0, 'nothing disposed before the disposer runs')
  result.dispose()
  assert.deepEqual(disposed, ['route'])
})

test('disposal does not throw when the shell already dropped the route', () => {
  const ctx = { webServer: { register: () => () => { throw new Error('already gone') } } }
  const result = mountPanelRoute(ctx, { service: stubService() })
  assert.doesNotThrow(() => result.dispose())
})
