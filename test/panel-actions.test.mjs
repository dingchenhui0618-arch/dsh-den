/**
 * End-to-end test of the panel's action surface, driven through the *real*
 * registered route.
 *
 * The offline UI harness proves the browser sends the right actions. This proves
 * the host does the right thing with them: that a schedule created from the panel
 * is a real schedule the tool layer also sees, that autonomy cannot be granted by
 * a click, and that an unknown action is refused rather than ignored.
 *
 * Two things about how this is set up are deliberate, and both were learned the
 * hard way:
 *
 *  - **Each test gets its own `DSH_HOME`.** Schedules and grants are persisted, so
 *    a shared home leaks state between tests: the first version of this file saw a
 *    previous test's schedule inside a "the list should be empty" assertion.
 *  - **The modules are re-imported per sandbox** (with a unique query so the ESM
 *    cache does not hand back the first instance). `denHome()` is evaluated once per
 *    module instance, so a cached import would keep writing to the first sandbox.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const sandboxes = []
test.after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true })
})

let moduleSerial = 0

/** Load the plugin against a throwaway home and bring it up on a fake Host. */
async function live({ sessionId = 'session-1' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-den-actions-'))
  sandboxes.push(home)
  process.env.DSH_HOME = home
  moduleSerial += 1
  const suffix = `?sandbox=${moduleSerial}`
  const index = await import(`../src/index.js${suffix}`)
  const routes = await import(`../src/panel-api.js${suffix}`)

  const state = { provided: new Map(), routes: [], tools: [], guards: [], listeners: new Map() }
  const toolsApi = {
    register: (definition) => (state.tools.push(definition), () => {}),
    guard: (handler) => (state.guards.push(handler), () => {}),
  }
  const agent = { id: sessionId, status: 'running', session: { id: sessionId, events: [] } }
  const sent = []
  const ctx = {
    tools: toolsApi,
    agents: {
      get: (id) => (id === sessionId ? agent : undefined),
      currentInitiator: () => agent,
      roots: () => [agent],
      resume: async () => ({ agent, dispose: async () => {} }),
    },
    webServer: {
      register(route) {
        state.routes.push(route)
        return () => {}
      },
    },
    effect: (fn) => fn(),
    provide: (key, value) => (state.provided.set(key, value), () => state.provided.delete(key)),
    get(key) {
      if (key === 'subagents') return { async sendMessage(...args) { sent.push(args); return 'msg-1' } }
      if (key === 'tools') return toolsApi
      if (key === 'agents') return ctx.agents
      if (key === 'webServer') return ctx.webServer
      return undefined
    },
    on: (event, handler) => (state.listeners.set(event, handler), () => state.listeners.delete(event)),
  }

  index.apply(ctx)
  const service = state.provided.get('den')
  const route = state.routes[0]
  assert.ok(route, 'the route must be mounted for any of this to mean anything')
  return { home, state, service, route, modules: { ...index, ...routes } }
}

/**
 * A request stand-in shaped like the one the host web server hands a route.
 *
 * A Node `IncomingMessage`, because that is what `dsh-vision-diff` and the other
 * installed plugins read their bodies from (`req.on('data')` / `req.on('end')`).
 * A fake offering only `.text()` would let a handler that cannot work in the real
 * host pass every test.
 */
function makeReq({ method = 'POST', url = '/dsh-den', rawBody = '' } = {}) {
  const handlers = new Map()
  const chunks = rawBody === '' ? [] : [Buffer.from(rawBody, 'utf8')]
  return {
    method,
    url,
    on(event, handler) {
      handlers.set(event, handler)
      return this
    },
    destroy() {},
    async deliver() {
      for (const chunk of chunks) handlers.get('data')?.(chunk)
      handlers.get('end')?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
  }
}

/** A response stand-in: Node's `ServerResponse`. */
function makeRes() {
  const captured = { status: null, headers: null, body: '' }
  return {
    captured,
    statusCode: null,
    setHeader(name, value) {
      captured.headers = { ...(captured.headers || {}), [name]: value }
    },
    end(text) {
      captured.status = this.statusCode
      captured.body = String(text)
    },
  }
}

/** Drive the registered handler the way the host web server would. */
async function request(route, { method = 'POST', url = '/dsh-den', body } = {}) {
  const req = makeReq({ method, url, rawBody: body })
  const res = makeRes()
  const pending = route.handler(req, res)
  await req.deliver()
  await pending
  return { status: res.captured.status, body: JSON.parse(res.captured.body) }
}

/**
 * Call one action through the mounted route, exactly as the panel's fetch would.
 *
 * A `sessionId` is included by default because the route deliberately does not know
 * the active conversation — that is the panel's job, and a host that guessed would
 * be the bug. The browser half is verified to send it by
 * `tools/check-client-interaction.mjs`.
 *
 * The returned `result` mirrors the old envelope's field name so the assertions
 * below read as they did before the transport moved; `body` is the real shape.
 */
async function viaRoute(route, action, payload = {}) {
  const response = await request(route, {
    body: JSON.stringify({ sessionId: 'session-1', action, ...payload }),
  })
  return {
    status: response.status,
    body: response.body,
    result: response.body,
    value: response.body?.ok ? response.body.value : undefined,
  }
}

/* ------------------------------------------------------------ transport shape */

test('the route refuses a method it does not serve', async () => {
  const { route } = await live()
  const response = await request(route, { method: 'DELETE' })
  assert.equal(response.status, 405)
  assert.equal(response.body.error.code, 'METHOD_NOT_ALLOWED')
})

test('the route rejects a body that is not JSON', async () => {
  const { route } = await live()
  const response = await request(route, { body: 'not json at all' })
  assert.equal(response.status, 400)
  assert.equal(response.body.error.code, 'BAD_JSON')
})

test('an unknown action is refused by name, not silently ignored', async () => {
  const { route } = await live()
  const { result } = await viaRoute(route, 'schedules/destroy-everything')
  assert.equal(result.ok, false)
  assert.match(result.error.message, /unknown action/)
  assert.match(result.error.message, /schedules\/delete/, 'the refusal lists the actions that do exist')
})

test('status through the route reports real state, and the heartbeat as running', async () => {
  const { route } = await live()
  const { result } = await viaRoute(route, 'status')
  assert.equal(result.ok, true)
  assert.equal(result.value.name, 'Den')
  assert.equal(result.value.gate.mounted, true)
  assert.equal(result.value.kernel.running, true)
  assert.equal(result.value.kernelDeferred, null)
  assert.equal(result.value.route.mounted, true)
})

/* ---------------------------------------------------------------- schedules */

test('a schedule created from the panel is a real schedule the tool layer also sees', async () => {
  const { route, state, home } = await live()
  const created = await viaRoute(route, 'schedules/create', {
    kind: 'interval',
    title: 'CI watch',
    prompt: 'Report only failures.',
    everySeconds: 900,
  })
  assert.equal(created.result.ok, true, JSON.stringify(created.result))

  // Visible through the model-facing tool, which is the point: a schedule the
  // assistant cannot see is a schedule it will not act on.
  const listed = await state.tools.find((tool) => tool.name === 'den_schedule_list').execute({ sessionId: 'session-1' })
  assert.equal(listed.schedules.length, 1)
  assert.equal(listed.schedules[0].title, 'CI watch')

  const files = readdirSync(join(home, 'den'))
  assert.ok(files.length > 0, 'creating a schedule must leave something on disk')
})

test('a panel-created schedule is still not a permission grant', async () => {
  const { route, service } = await live()
  await viaRoute(route, 'schedules/create', { kind: 'interval', title: 'x', prompt: 'y', everySeconds: 600 })
  assert.equal(service.status().grants, 0, 'creating a schedule must not create an autonomy grant')
})

test('a schedule with no conversation is refused, and the route does not guess one', async () => {
  const { service, modules } = await live()
  const outcome = await modules.invokeAction(
    service,
    'schedules/create',
    { kind: 'interval', title: 'x', prompt: 'y', everySeconds: 600 },
    {},
  )
  assert.equal(outcome.ok, false)
  assert.match(outcome.error, /must belong to a conversation/)
})

test('an invalid schedule from the panel reports why instead of crashing', async () => {
  const { route } = await live()
  const { result } = await viaRoute(route, 'schedules/create', {
    kind: 'interval',
    title: 'too often',
    prompt: 'x',
    everySeconds: 5,
  })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /at least 300/)
})

test('deleting a schedule from the panel really removes it', async () => {
  const { route, state } = await live()
  const created = await viaRoute(route, 'schedules/create', { kind: 'interval', title: 'CI watch', prompt: 'x', everySeconds: 900 })
  const removed = await viaRoute(route, 'schedules/delete', { id: created.value.id })
  assert.equal(removed.value.removed, true)
  const listed = await state.tools.find((tool) => tool.name === 'den_schedule_list').execute({ sessionId: 'session-1' })
  assert.equal(listed.schedules.length, 0)
})

test('listing through the panel is scoped to the conversation it was asked about', async () => {
  const { route } = await live()
  await viaRoute(route, 'schedules/create', { kind: 'interval', title: 'mine', prompt: 'x', everySeconds: 900 })
  const sameSession = await viaRoute(route, 'schedules/list')
  assert.equal(sameSession.value.schedules.length, 1)
  const otherSession = await viaRoute(route, 'schedules/list', { sessionId: 'some-other-session' })
  assert.equal(otherSession.value.schedules.length, 0, 'a schedule must not leak into another conversation')
})

/* ------------------------------------------------------------- the authority line */

test('requesting autonomy from the panel mints a token and grants nothing', async () => {
  const { route, service } = await live()
  const { result } = await viaRoute(route, 'autonomy/request', { autonomy: true })
  assert.equal(result.ok, true)
  assert.match(result.value.token, /^[0-9a-f]{32}$/, 'the token must be unguessable, not a counter or a timestamp')
  assert.ok(result.value.instruction.includes(result.value.token), 'the panel is told exactly what to paste')

  assert.equal(service.status().grants, 0, 'a panel request must not create a grant')
  const snapshot = await viaRoute(route, 'status')
  assert.equal(snapshot.value.autonomy, null, 'the panel must not report authority it does not have')
  assert.equal(snapshot.value.autonomyKnown, false, 'and it must say the value is unknown rather than off')
})

test('a guessed token cannot confirm anything', async () => {
  const { route } = await live()
  await viaRoute(route, 'autonomy/request', { autonomy: true })
  const wrong = await viaRoute(route, 'autonomy/confirm', {
    token: 'deadbeef'.repeat(4),
    autonomy: true,
    humanMessageId: 'm1',
  })
  assert.equal(wrong.result.ok, false)
  assert.match(wrong.result.error.message, /no matching autonomy request/)
})

test('the right token without human evidence still grants nothing, and is not spent', async () => {
  const { route } = await live()
  const requested = await viaRoute(route, 'autonomy/request', { autonomy: true })
  const token = requested.value.token

  const noEvidence = await viaRoute(route, 'autonomy/confirm', { token, autonomy: true, humanMessageId: 'never-happened' })
  assert.equal(noEvidence.result.ok, false)
  assert.match(noEvidence.result.error.message, /direct human request/)

  // A failed confirm must leave the token usable, so one bad attempt does not
  // force the human to start over.
  const stillUsable = await viaRoute(route, 'autonomy/confirm', { token, autonomy: true, humanMessageId: 'still-not-real' })
  assert.match(stillUsable.result.error.message, /direct human request/)
})

test('a valid token plus real human evidence grants exactly that, and the token is spent', async () => {
  const { route, state } = await live()
  // A real grant needs a human message in the session log: that is the evidence
  // model, so the fixture has to produce one rather than assert around it.
  state.provided.get('den').ctx.agents.get('session-1').session.events.push(
    { type: 'turn/start', seq: 1 },
    { type: 'user/message', seq: 2, data: { id: 'human-1', source: { kind: 'user' } } },
  )

  const requested = await viaRoute(route, 'autonomy/request', { autonomy: true })
  const token = requested.value.token
  const confirmed = await viaRoute(route, 'autonomy/confirm', { token, autonomy: true, humanMessageId: 'human-1' })
  assert.equal(confirmed.result.ok, true, JSON.stringify(confirmed.result))
  assert.equal(confirmed.value.autonomy, true)
  assert.equal(confirmed.value.boundToMessage, 'human-1')

  // The status surface now agrees — which is the whole reason the panel routes the
  // write through the conversation instead of doing it itself.
  const snapshot = await viaRoute(route, 'status')
  assert.equal(snapshot.value.autonomy, true, 'a real grant must be visible as granted')
  assert.equal(snapshot.value.autonomyKnown, true)

  const again = await viaRoute(route, 'autonomy/confirm', { token, autonomy: true, humanMessageId: 'human-1' })
  assert.equal(again.result.ok, false)
  assert.match(again.result.error.message, /no matching autonomy request/)
})

test('an expired token is refused and cleared', async () => {
  const { route, service } = await live()
  const requested = await viaRoute(route, 'autonomy/request', { autonomy: true })
  service.panelAutonomyRequest.expiresAt = Date.now() - 1
  const expired = await viaRoute(route, 'autonomy/confirm', {
    token: requested.value.token,
    autonomy: true,
    humanMessageId: 'h',
  })
  assert.equal(expired.result.ok, false)
  assert.match(expired.result.error.message, /expired/)
  assert.equal(service.panelAutonomyRequest, null)
  assert.ok(service.recentEvents.some((event) => event.type === 'panel-autonomy-expired'))
})

test('a revoke request mints a token and grants nothing', async () => {
  const { route, service } = await live()
  const { result } = await viaRoute(route, 'autonomy/request', { autonomy: false })
  assert.equal(result.ok, true)
  assert.equal(service.status().grants, 0)
  const event = service.recentEvents.filter((entry) => entry.type === 'panel-autonomy-requested').pop()
  assert.equal(event.autonomy, false)
})

test('a confirm bound to another conversation is refused', async () => {
  const { route } = await live()
  const requested = await viaRoute(route, 'autonomy/request', { autonomy: true, sessionId: 'session-1' })
  const elsewhere = await viaRoute(route, 'autonomy/confirm', {
    token: requested.value.token,
    autonomy: true,
    humanMessageId: 'human-1',
    sessionId: 'session-does-not-exist',
  })
  assert.equal(elsewhere.result.ok, false)
  assert.match(elsewhere.result.error.message, /no live conversation/)
})

/* --------------------------------------------------------------- whole surface */

test('every advertised action is dispatchable, and the advertised list is complete', async () => {
  const { service, modules } = await live()
  const emptyService = {
    status: () => ({
      name: 'Den',
      home: '/tmp',
      ledger: {},
      notices: {},
      triggers: {},
      recentEvents: [],
      gate: 'mounted',
      statusRoute: null,
      kernelDeferred: null,
      reapedTempFiles: 0,
    }),
    listTriggers: () => ({ valid: [], invalid: [] }),
    dueTriggers: () => [],
    listScenarios: () => [],
    gateAudit: () => [],
    noteEvent: (event) => service.noteEvent(event),
    ctx: {},
  }
  for (const action of modules.PANEL_ACTIONS) {
    const outcome = await modules.invokeAction(emptyService, action, { token: 'nope' }, {})
    assert.notEqual(
      String(outcome.error ?? '').includes('unknown action'),
      true,
      `${action} is advertised but not implemented`,
    )
  }
  assert.ok(modules.PANEL_ACTIONS.includes('status'))
  assert.ok(modules.PANEL_ACTIONS.includes('autonomy/request'))
})

test('the plugin still declares every service it reads', async () => {
  const { modules } = await live()
  assert.deepEqual(modules.inject, ['agents', 'tools', 'webServer'])
})
