/**
 * Integration test: activate the plugin against a fake Host and verify the whole
 * assembly comes up.
 *
 * A unit test per module does not prove the plugin *loads*. The failure mode this
 * guards against is real and already observed in this project: the Host reported
 * `not-bundle`, then `failed to import`, and both were silent from the inside. So
 * this test drives `apply()` exactly as the Host would and asserts on what is
 * mounted, then drives the mounted surfaces.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { mock } from 'node:test'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-den-mount-'))
process.env.DSH_HOME = sandbox

const { apply, inject, DenService, registerTools, createDeliver } = await import('../src/index.js')

test('the plugin declares the web server its status route is mounted on', () => {
  assert.deepEqual(inject, ['agents', 'tools', 'webServer'])
})

test.after(() => rmSync(sandbox, { recursive: true, force: true }))

/**
 * A Host context that records everything the plugin mounts.
 *
 * `toolsApi` is always present: both `installGate` and `registerTools` take the
 * registry as a precondition, and testing their degradation belongs in `apply`,
 * not in a fixture that silently removes the registry they require.
 */
function fakeHost({ withSubagents = true } = {}) {
  const state = {
    provided: new Map(),
    listeners: new Map(),
    tools: [],
    guards: [],
    effects: [],
    routes: [],
  }

  state.toolsApi = {
    register(definition) {
      state.tools.push(definition)
      return () => {
        const at = state.tools.indexOf(definition)
        if (at >= 0) state.tools.splice(at, 1)
      }
    },
    guard(handler) {
      state.guards.push(handler)
      return () => {
        const at = state.guards.indexOf(handler)
        if (at >= 0) state.guards.splice(at, 1)
      }
    },
  }

  const sent = []
  const liveSubagents = {
    async sendMessage(sender, targetId, content, options) {
      sent.push({ sender, targetId, content, options })
      return 'msg-1'
    },
  }
  /**
   * Whether a delivery path exists. The option only sets the *initial* value;
   * tests move it in both directions afterwards, which is the only honest way to
   * exercise a dependency that arrives late.
   */
  state.subagents = withSubagents ? liveSubagents : null
  state.agentsApi = {
    get: () => undefined,
    resume: async () => ({ agent: { id: 'resumed' }, dispose: async () => {} }),
  }
  // `webServer.register(route)` is the interface — the same one dsh-vision-diff,
  // dsh-warden and dsh-daily declare `inject = [..., 'webServer']` for. There is no
  // `fetch` wrapper on this service.
  state.webServer = {
    register(route) {
      state.routes.push(route)
      return () => {
        const at = state.routes.indexOf(route)
        if (at >= 0) state.routes.splice(at, 1)
      }
    },
  }

  const ctx = {
    // Injected properties, as the real Cordis context exposes services it has
    // declared via `inject`. The plugin reads these, not `ctx.get(...)`.
    tools: state.toolsApi,
    agents: state.agentsApi,
    webServer: state.webServer,
    effect(fn) {
      const dispose = fn()
      state.effects.push(dispose)
      return dispose
    },
    provide(key, value) {
      state.provided.set(key, value)
      return () => state.provided.delete(key)
    },
    get(key) {
      // Dispatches through `state` only, never through the captured option. Closing
      // over the option is silently wrong: the fixture then reports the service as
      // absent forever, and a late arrival cannot be simulated at all — which made
      // a harness bug look like a product bug.
      if (key === 'subagents') return state.subagents
      if (key === 'tools') return state.toolsApi
      if (key === 'agents') return state.agentsApi
      if (key === 'webServer') return state.webServer
      return undefined
    },
    on(event, handler) {
      state.listeners.set(event, handler)
      return () => state.listeners.delete(event)
    },
  }

  state.sentMessages = sent
  state.ctx = ctx
  /** Make the delivery path arrive late, as it does when load order differs. */
  state.arriveSubagents = () => {
    state.subagents = liveSubagents
    return liveSubagents
  }
  return { ctx, state }
}

test('the plugin activates without throwing', () => {
  const { ctx, state } = fakeHost()
  assert.doesNotThrow(() => apply(ctx))
  assert.ok(state.provided.has('den'), 'the den service must be provided')
  assert.ok(state.provided.get('den') instanceof DenService)
})

test('activation mounts the gate before anything else can run', () => {
  const { ctx, state } = fakeHost()
  apply(ctx)
  assert.ok(state.listeners.has('tools/pre-execute'), 'the pre-execute listener must be mounted')
  assert.equal(state.guards.length, 1, 'exactly one monotonic guard must be mounted')
})

test('activation mounts the status route when the desktop web server is present', () => {
  const { ctx, state } = fakeHost()
  const dispose = apply(ctx)
  const service = state.provided.get('den')
  assert.equal(state.routes.length, 1)
  assert.equal(state.routes[0].path, '/dsh-den')
  assert.equal(state.routes[0].kind, 'prefix')
  assert.deepEqual(service.status().statusRoute, { mounted: true, reason: null, message: null, path: '/dsh-den' })
  dispose()
  assert.equal(state.routes.length, 0)
})

test('activation registers every model-facing tool with an explicit schema', () => {
  const { ctx, state } = fakeHost()
  apply(ctx)
  const names = state.tools.map((tool) => tool.name).sort()
  assert.deepEqual(names, [
    'den_configure',
    'den_explain_gate',
    'den_forget',
    'den_recall',
    'den_remember',
    'den_scenarios',
    'den_schedule_check',
    'den_schedule_delete',
    'den_schedule_list',
    'den_set_autonomy',
    'den_status',
  ])
  for (const tool of state.tools) {
    assert.equal(typeof tool.description, 'string', `${tool.name} needs a description`)
    assert.ok(tool.description.length > 20, `${tool.name} needs a real description`)
    assert.equal(typeof tool.parameters, 'object', `${tool.name} needs a parameter schema`)
    assert.ok(tool.output?.schema, `${tool.name} needs an output schema`)
    assert.equal(typeof tool.execute, 'function', `${tool.name} needs an execute body`)
  }
})

test('the heartbeat starts when a delivery path exists and stops on disposal', () => {
  const { ctx, state } = fakeHost()
  const dispose = apply(ctx)
  const service = state.provided.get('den')
  assert.ok(service.kernel, 'a delivery path exists, so the kernel must start')
  assert.ok(service.kernel.timer, 'the kernel timer must be running')

  dispose()
  assert.equal(service.kernel.timer, null, 'disposal must stop the heartbeat')
})

test('activation is fully reversible', () => {
  const { ctx, state } = fakeHost()
  const dispose = apply(ctx)
  assert.equal(state.tools.length, 11)
  dispose()
  assert.equal(state.tools.length, 0, 'disposal must unregister every tool')
  assert.equal(state.guards.length, 0, 'disposal must remove the guard')
  assert.equal(state.listeners.size, 0, 'disposal must remove the listener')
  assert.equal(state.provided.size, 0, 'disposal must unprovide the service')
})

test('the kernel defers instead of running blind when no delivery path exists', () => {
  const { ctx, state } = fakeHost({ withSubagents: false })
  apply(ctx)
  const service = state.provided.get('den')
  assert.equal(service.kernel, null, 'without a delivery path the kernel must not run')
  assert.ok(
    service.recentEvents.some((event) => event.type === 'kernel-deferred'),
    'the deferral must be recorded, not silent',
  )
  // The deferral must also be *visible* in a status query, not only in the event
  // log: a resident assistant whose heartbeat is absent has to say so.
  assert.ok(service.status().kernelDeferred, 'a deferred heartbeat must be reported by status()')
  assert.equal(service.status().kernelDeferred.retrying, true)
})

test('a deferred heartbeat starts by itself once a delivery path appears', () => {
  // The whole point of "7x24 resident". Measured live, the first version treated
  // an absent `subagents` as a permanent verdict, so the heartbeat never started
  // and the only trace was one event. "Not yet" must not be read as "never".
  mock.timers.enable({ apis: ['setInterval'] })
  try {
    const { ctx, state } = fakeHost({ withSubagents: false })
    apply(ctx)
    const service = state.provided.get('den')
    assert.equal(service.kernel, null, 'nothing to deliver to yet')

    // The service arrives late, as it does when profile load order differs.
    state.arriveSubagents()
    mock.timers.tick(5000)

    assert.ok(service.kernel, 'the kernel must start on its own once delivery is possible')
    assert.ok(service.kernel.timer, 'the heartbeat timer must be running')
    assert.equal(service.kernelDeferred, null, 'the deferred marker must be cleared')
    assert.ok(
      service.recentEvents.some((event) => event.type === 'kernel-recovered'),
      'recovery must be recorded so the gap is visible after the fact',
    )
    assert.equal(service.status().kernel.running, true)
  } finally {
    mock.timers.reset()
  }
})

test('a heartbeat that never finds a delivery path gives up loudly, not silently', () => {
  mock.timers.enable({ apis: ['setInterval'] })
  try {
    const { ctx, state } = fakeHost({ withSubagents: false })
    apply(ctx)
    const service = state.provided.get('den')

    // Past the retry cap: the kernel must stop retrying and leave a record.
    mock.timers.tick(5000 * 30)

    assert.equal(service.kernel, null)
    assert.equal(service.kernelDeferred.retrying, false, 'it must stop claiming to retry')
    assert.ok(
      service.recentEvents.some((event) => event.type === 'kernel-unavailable'),
      'giving up must be an event, not an absence',
    )
  } finally {
    mock.timers.reset()
  }
})

test('disposal cancels a pending heartbeat retry', () => {
  mock.timers.enable({ apis: ['setInterval'] })
  try {
    const { ctx, state } = fakeHost({ withSubagents: false })
    const dispose = apply(ctx)
    const service = state.provided.get('den')
    dispose()

    // If the retry timer survived disposal it would start a kernel on a disposed
    // fiber, which is exactly the kind of leak a resident plugin cannot afford.
    state.arriveSubagents()
    mock.timers.tick(5000 * 30)
    assert.equal(service.kernel, null, 'a disposed plugin must not start a heartbeat later')
  } finally {
    mock.timers.reset()
  }
})

test('the mounted gate refuses a credential read through the real waterfall signature', async () => {
  const { ctx, state } = fakeHost()
  apply(ctx)
  const preExecute = state.listeners.get('tools/pre-execute')

  const decision = await preExecute({ name: 'read', arguments: { path: '~/.dsh/.credentials.yaml' } }, () => {
    throw new Error('a credential read must never delegate')
  })
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /credential/)
})

test('the mounted gate questions an outbound action and allows a read-only one', async () => {
  const { ctx, state } = fakeHost()
  apply(ctx)
  const preExecute = state.listeners.get('tools/pre-execute')

  const ask = await preExecute({ name: 'bash', arguments: { command: 'git push origin main' } }, () => ({ kind: 'allow' }))
  assert.equal(ask.kind, 'ask')

  let delegated = false
  const allow = await preExecute({ name: 'web_search', arguments: { query: 'weather' } }, () => {
    delegated = true
    return { kind: 'allow' }
  })
  assert.equal(delegated, true)
  assert.equal(allow.kind, 'allow')
})

test('the status tool reports filesystem truth, not intentions', async () => {
  const { ctx, state } = fakeHost()
  apply(ctx)
  const statusTool = state.tools.find((tool) => tool.name === 'den_status')
  const status = await statusTool.execute({})

  assert.equal(status.name, 'Den')
  // Booting claims the tree on disk, so the configuration on show is stored state
  // rather than a default that has never been written.
  assert.equal(status.stateSurvivesRestart, true, 'boot must persist state, not leave the home empty')
  assert.equal(status.gate, 'mounted')
  assert.ok(status.kernel.running)
  assert.equal(status.triggers.total, 0)
  assert.equal(status.ledger.turns, 0)
})

test('booting persists state without clobbering an existing configuration', async () => {
  const { ctx, state } = fakeHost()
  apply(ctx)
  const configure = state.tools.find((tool) => tool.name === 'den_configure')
  await configure.execute({ dailyTurnBudget: 7, tickSeconds: 120 })

  // A second activation over the same home, as a restart would do.
  const second = fakeHost()
  apply(second.ctx)
  const status = await second.state.tools.find((tool) => tool.name === 'den_status').execute({})
  assert.equal(status.dailyTurnBudget, 7, 'a restart must not reset the stored budget')
  assert.equal(status.tickSeconds, 120, 'a restart must not reset the stored cadence')
})

test('the configure tool rejects out-of-range input instead of clamping silently', async () => {
  const { ctx, state } = fakeHost()
  apply(ctx)
  const configure = state.tools.find((tool) => tool.name === 'den_configure')

  const badBudget = await configure.execute({ dailyTurnBudget: 9999 })
  assert.equal(badBudget.ok, false)
  assert.match(badBudget.error, /0\.\.500/)

  const badTick = await configure.execute({ tickSeconds: 1 })
  assert.equal(badTick.ok, false)

  const badQuiet = await configure.execute({ quietHours: { from: '25:00', to: '07:00' } })
  assert.equal(badQuiet.ok, false)
  assert.match(badQuiet.error, /HH:MM/)
})

test('the configure tool applies a real change and persists it', async () => {
  const { ctx, state } = fakeHost()
  apply(ctx)
  const configure = state.tools.find((tool) => tool.name === 'den_configure')

  const result = await configure.execute({ quietHours: { from: '23:00', to: '07:00' }, dailyTurnBudget: 8 })
  assert.equal(result.ok, true)
  assert.deepEqual(result.effective.quietHours, { from: 23 * 60, to: 7 * 60 })
  assert.equal(result.effective.dailyTurnBudget, 8)

  // A second call reads the persisted value, proving it survived.
  const status = await state.tools.find((tool) => tool.name === 'den_status').execute({})
  assert.equal(status.dailyTurnBudget, 8)
  assert.deepEqual(status.quietHours, { from: 23 * 60, to: 7 * 60 })
})

test('the schedule tool creates a real schedule the list tool can see', async () => {
  const { ctx, state } = fakeHost()
  apply(ctx)
  const create = state.tools.find((tool) => tool.name === 'den_schedule_check')
  const list = state.tools.find((tool) => tool.name === 'den_schedule_list')
  const remove = state.tools.find((tool) => tool.name === 'den_schedule_delete')

  const created = await create.execute({
    kind: 'interval',
    title: 'CI watch',
    prompt: 'Check continuous integration and report only failures.',
    sessionId: 'session-mount',
    everySeconds: 900,
  })
  assert.equal(created.ok, true)

  const listed = await list.execute({ sessionId: 'session-mount' })
  assert.equal(listed.schedules.length, 1)
  assert.equal(listed.schedules[0].title, 'CI watch')
  assert.equal(listed.schedules[0].fireCount, 0)

  const removed = await remove.execute({ id: created.id })
  assert.equal(removed.ok, true)
  const after = await list.execute({ sessionId: 'session-mount' })
  assert.equal(after.schedules.length, 0)
})

test('an invalid schedule reports why rather than crashing the tool', async () => {
  const { ctx, state } = fakeHost()
  apply(ctx)
  const create = state.tools.find((tool) => tool.name === 'den_schedule_check')
  const result = await create.execute({
    kind: 'interval',
    title: 'too often',
    prompt: 'x',
    sessionId: 's',
    everySeconds: 5,
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /at least 300/)
})

test('autonomy cannot be self-granted and says so instead of throwing', async () => {
  const { ctx, state } = fakeHost()
  apply(ctx)
  const grant = state.tools.find((tool) => tool.name === 'den_set_autonomy')

  // No agent in scope.
  const noAgent = await grant.execute({ autonomy: true, humanMessageId: 'msg-1' }, {})
  assert.equal(noAgent.ok, false)
  assert.match(noAgent.error, /per conversation/)

  // An agent present, but the message id is not a human message in its log.
  const agent = { id: 'a1', status: 'running', session: { id: 's1', events: [] } }
  const forged = await grant.execute({ autonomy: true, humanMessageId: 'never-happened' }, { agent })
  assert.equal(forged.ok, false)
  assert.match(forged.error, /direct human request/)
})

test('the gate explanation tool answers without executing anything', async () => {
  const { ctx, state } = fakeHost()
  apply(ctx)
  const explain = state.tools.find((tool) => tool.name === 'den_explain_gate')

  const denied = await explain.execute({ tool: 'bash', args: { command: 'cat .env' } })
  assert.equal(denied.verdict, 'deny')
  assert.match(denied.rule, /^secret:/)

  const asked = await explain.execute({ tool: 'bash', args: { command: 'git push' } })
  assert.equal(asked.verdict, 'ask')

  const allowed = await explain.execute({ tool: 'web_search', args: { query: 'x' } })
  assert.equal(allowed.verdict, 'allow')
})

test('the deliver path refuses to fabricate a result when it cannot wake', async () => {
  const { ctx, state } = fakeHost({ withSubagents: false })
  const service = new DenService(ctx)
  const deliver = createDeliver(ctx, service)

  const text = await deliver({ trigger: { id: 't1', sessionId: 's1', title: 'x', prompt: 'y' }, instruction: 'go' })
  assert.equal(text, '', 'a wake that could not run must report nothing, not invent output')
  assert.ok(service.recentEvents.some((event) => event.type === 'wake-unavailable'))
})

test('registering tools twice does not duplicate them', () => {
  const { ctx, state } = fakeHost()
  const service = new DenService(ctx)
  const disposeA = registerTools(state.toolsApi, service)
  const disposeB = registerTools(state.toolsApi, service)
  assert.equal(state.tools.length, 22, 'the registry itself allows two sets; disposal must be exact')

  disposeA()
  assert.equal(state.tools.length, 11)
  disposeB()
  assert.equal(state.tools.length, 0)
})
