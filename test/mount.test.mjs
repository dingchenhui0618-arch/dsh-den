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
// One host fixture, shared with `roundtrip.test.mjs`. Two harnesses inventing their
// own idea of the host is how a wrong shape gets agreed with instead of caught.
const { fakeHost } = await import('./support/host.mjs')
const { invokeAction, statusSnapshot } = await import('../src/panel-api.js')

test('the plugin declares the web server its status route is mounted on', () => {
  assert.deepEqual(inject, ['agents', 'tools', 'webServer'])
})

test.after(() => rmSync(sandbox, { recursive: true, force: true }))


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

test('the route counts every caller and keeps the newest one, while first contact stays put', () => {
  // The whole reason the counter exists: `firstReachedAt` is one timestamp, and a deployment
  // probe and a panel polling every fifteen seconds produce the same one. A count that keeps
  // climbing says someone is still asking; the user-agent says who. Collapsing the first
  // arrival into the latest would destroy the only field that distinguishes the two.
  const { ctx, state } = fakeHost()
  const dispose = apply(ctx)
  const service = state.provided.get('den')

  assert.equal(service.status().statusRoute.requestCount, 0, 'a mount is not traffic')

  service.markRouteReached({ method: 'GET', userAgent: 'curl/8.9.1' })
  const first = service.status().statusRoute.firstReachedAt
  assert.ok(Number.isFinite(first), 'the first request stamps the first contact')

  service.markRouteReached({ method: 'GET', userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/141' })
  const route = service.status().statusRoute

  assert.equal(route.requestCount, 2, 'the count is requests seen, not requests that mattered')
  assert.equal(route.firstReachedAt, first, 'first contact must not move')
  assert.equal(route.lastRequest.userAgent, 'Mozilla/5.0 (Windows NT 10.0) Chrome/141', 'the newest caller is the one kept')
  assert.equal(route.lastRequest.method, 'GET')
  assert.ok(Number.isFinite(route.lastRequest.at), 'and it is stamped when it arrived')

  dispose()
})

test('activation mounts the status route when the desktop web server is present', () => {
  const { ctx, state } = fakeHost()
  const dispose = apply(ctx)
  const service = state.provided.get('den')
  assert.equal(state.routes.length, 1)
  assert.equal(state.routes[0].path, '/dsh-den')
  assert.equal(state.routes[0].kind, 'prefix')
  assert.deepEqual(service.status().statusRoute, {
    mounted: true,
    reason: null,
    message: null,
    path: '/dsh-den',
    // Registering a route is the plugin reporting on itself. Reachability is
    // recorded only when a request arrives, so it must be null here — a mount must
    // never be allowed to imply a reach.
    firstReachedAt: null,
    // Nothing has arrived, so there is no last request and the counter is zero. Both are
    // recorded by the request, never by the mount.
    lastRequest: null,
    requestCount: 0,
  })
  dispose()
  assert.equal(state.routes.length, 0)
})

test('browser reachability is recorded by the request, never inferred from the mount', async () => {
  // The distinction this pins is the one that cost this plugin two rounds: an
  // earlier transport reported `mounted: true` while every browser request to it
  // answered 401. A snapshot taken at mount time must not be able to say "reached".
  const { ctx, state } = fakeHost()
  const dispose = apply(ctx)
  const service = state.provided.get('den')
  const route = state.routes[0]
  // `transport` is assembled by statusSnapshot, not by the service's raw status().
  const { statusSnapshot } = await import('../src/panel-api.js')
  const snapshotNow = () => statusSnapshot(service, {})

  assert.equal(service.status().statusRoute.firstReachedAt, null, 'mounting is not reaching')
  assert.equal(snapshotNow().transport.browserReachable, null)
  assert.equal(snapshotNow().transport.claimedMounted, true)
  assert.match(snapshotNow().transport.note, /no request has reached it yet/)

  // Now serve one request through the registered handler, the way the host would.
  const handlers = new Map()
  const req = { method: 'GET', url: '/dsh-den', on: (event, handler) => handlers.set(event, handler), destroy() {} }
  const res = { statusCode: null, headers: {}, setHeader(k, v) { this.headers[k] = v }, end(t) { this.body = t } }
  const pending = route.handler(req, res)
  handlers.get('end')?.()
  await pending

  const after = snapshotNow()
  // statusSnapshot nests it as `route`; firstReachedAt is what the route records.
  assert.equal(typeof after.route.firstReachedAt, 'number', 'the request records contact')
  assert.equal(after.transport.browserReachable, after.route.firstReachedAt)
  assert.match(after.transport.note, /a request has reached this route/)
  dispose()
})

test('activation registers every model-facing tool with an explicit schema', () => {
  const { ctx, state } = fakeHost()
  apply(ctx)
  const names = state.tools.map((tool) => tool.name).sort()
  assert.deepEqual(names, [
    'den_configure',
    'den_explain_gate',
    'den_forget',
    'den_profile',
    'den_recall',
    'den_remember',
    'den_scenarios',
    'den_schedule_check',
    'den_schedule_delete',
    'den_schedule_list',
    'den_set_autonomy',
    'den_status',
    'den_task_advance',
    'den_task_block',
    'den_task_create',
    'den_task_list',
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
  assert.equal(state.tools.length, 16)
  dispose()
  assert.equal(state.tools.length, 0, 'disposal must unregister every tool')
  assert.equal(state.guards.length, 0, 'disposal must remove the guard')
  assert.equal(state.listeners.size, 0, 'disposal must remove the listener')
  assert.equal(state.provided.size, 0, 'disposal must unprovide the service')
})

test('the wake surface is measured, not asserted, and reports its own limits', () => {
  // A live agent carrying the method the delivery path calls.
  const { ctx, state } = fakeHost()
  const live = {
    id: 'live-1',
    inbox: { nextTurn: [], nextStep: [] },
    followup: () => {},
  }
  state.agentsApi.list = () => [live]
  apply(ctx)
  const service = state.provided.get('den')

  const seen = service.status().wakeApi
  assert.equal(seen.checked, true, 'the measurement must run when the service is wired')
  assert.equal(seen.sawLiveAgent, true)
  assert.equal(seen.liveAgent.followup, true, 'the capability must be reported from the live object')
  assert.equal(
    seen.contract.followup,
    undefined,
    'the contract check must report what the service signatures offer, which excludes followup',
  )
  assert.equal(seen.contract.get, true)
  assert.equal(seen.contract.resume, true)
})

test('the wake measurement reports "could not look" rather than a result it did not get', () => {
  const { ctx, state } = fakeHost()
  // `list` exists but nothing is live: the capability is unobservable, which is neither a
  // pass nor a failure. Reporting it as a pass is exactly the mistake that hid the broken
  // delivery path.
  state.agentsApi.list = () => []
  apply(ctx)
  const service = state.provided.get('den')

  const seen = service.status().wakeApi
  assert.equal(seen.checked, true)
  assert.equal(seen.sawLiveAgent, false, 'no live agent means the capability was not observed')
  assert.equal(seen.liveAgent, null)
})

test('the wake measurement says which service is missing, not that delivery is broken', () => {
  const { ctx, state } = fakeHost({ withAgents: false })
  apply(ctx)
  const service = state.provided.get('den')

  const seen = service.status().wakeApi
  assert.equal(seen.checked, false)
  assert.match(
    seen.reason,
    /agents service is not wired/,
    'a profile with no agents service is a configuration fact, and must not read as a defect',
  )
})

test('the kernel defers instead of running blind when no delivery path exists', () => {  const { ctx, state } = fakeHost({ withAgents: false })
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
    const { ctx, state } = fakeHost({ withAgents: false })
    apply(ctx)
    const service = state.provided.get('den')
    assert.equal(service.kernel, null, 'nothing to deliver to yet')

    // The service arrives late, as it does when profile load order differs.
    state.arriveAgents()
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
    const { ctx, state } = fakeHost({ withAgents: false })
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
    const { ctx, state } = fakeHost({ withAgents: false })
    const dispose = apply(ctx)
    const service = state.provided.get('den')
    dispose()

    // If the retry timer survived disposal it would start a kernel on a disposed
    // fiber, which is exactly the kind of leak a resident plugin cannot afford.
    state.arriveAgents()
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
  // Two facts live here and they used to be conflated. That the boot *claimed the tree* is
  // what this test is about. That the state *survived a restart* is a claim about a
  // previous life: this file shares one home and earlier tests have already booted into it,
  // so `true` is the honest answer *here* — but it is an observation about the disk, not a
  // constant. The false-to-true transition is pinned on an empty home in the test below.
  assert.equal(status.stateSurvivesRestart, true, 'the field must agree with what earlier boots left on disk')
  assert.ok(status.stateCreatedAt, 'and the tree must record when it was first claimed')
  assert.equal(status.gate, 'mounted')
  assert.ok(status.kernel.running)
  assert.equal(status.triggers.total, 0)
  assert.equal(status.ledger.turns, 0)
})

test('state survival is measured rather than assumed: false on a first boot, true on a second', () => {
  // `stateSurvivesRestart` was computed as `readJson(statePath) !== undefined` *inside*
  // `status()`, which runs long after the boot wrote that very file. It was therefore
  // always `true` — on a machine that had never been restarted, on a home that had just
  // been created — while its name asserted a past event and a live acceptance check cited
  // it as proof of one. A field can only be evidence if it is read at a moment when the
  // answer could still be no, so it is captured before the boot claims the tree.
  //
  // Two `apply()` calls over one home is what a process restart looks like from the
  // plugin's side: new instances, same disk.
  const home = mkdtempSync(join(tmpdir(), 'dsh-den-reboot-'))
  const previousHome = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = home

    const firstHost = fakeHost()
    apply(firstHost.ctx)
    const first = firstHost.state.provided.get('den').status()
    assert.equal(first.stateSurvivesRestart, false, 'a first boot has nothing behind it to survive')
    assert.ok(first.stateCreatedAt, 'yet it must still claim the tree and record when')
    const createdAt = first.stateCreatedAt

    const secondHost = fakeHost()
    apply(secondHost.ctx)
    const secondService = secondHost.state.provided.get('den')
    const second = secondService.status()
    assert.equal(second.stateSurvivesRestart, true, 'a second boot finds the state the first one left')
    assert.equal(second.stateCreatedAt, createdAt, 'and the creation time still names the first boot')

    // Residency, in the same restart-shaped scene. The first instance is still **alive in this
    // process**, so it still holds the lease and the second stands down. That is the honest
    // answer here rather than a modelling artefact: a lease is released when its holder goes
    // away, and this holder has not gone anywhere. In production the old process is dead, and a
    // dead owner is reclaimed on the first claim instead of waiting out the staleness window —
    // covered where a dead pid can be faked, in kernel.test.mjs.
    assert.equal(first.residency?.held, true, 'the first boot holds residency')
    assert.equal(second.residency?.held, false, 'the second boot must stand down while the first holds it')
    assert.equal(second.residency?.holderPid, first.residency?.pid, 'and must name the holder')
    assert.equal(second.kernel?.running, true, 'standing down is not failing: the heartbeat still runs')

    // And it has to survive the panel payload, which is built field by field rather than spread.
    // A status field is invisible to the panel until it is named there, which is a defect this
    // repository has already shipped once, so the plumbing is asserted and not assumed.
    const snapshot = statusSnapshot(secondService, {})
    assert.equal(snapshot.residency?.held, false, 'the panel payload has to carry residency')
    assert.equal(snapshot.residency?.holderPid, first.residency?.pid, 'including who holds it')
  } finally {
    process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('booting persists state without clobbering an existing configuration', async () => {  const { ctx, state } = fakeHost()
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

  // An agent in scope, but no human ever asked the panel — so there is no request for this
  // call to satisfy. This is the cheapest check and it comes first: without a human having
  // minted a request, nothing else about the call can make it a grant.
  const agent = { id: 'a1', status: 'running', session: { id: 's1', events: [] } }
  const unasked = await grant.execute({ autonomy: true, humanMessageId: 'never-happened' }, { agent })
  assert.equal(unasked.ok, false)
  assert.match(unasked.error, /no autonomy request is outstanding/)

  // With a real request outstanding, a message id that is not a human message in this turn
  // still fails. The two factors are independent, and neither substitutes for the other.
  const service = state.provided.get('den')
  const minted = await invokeAction(service, 'autonomy/request', { autonomy: true }, { sessionId: 's1' })
  assert.equal(minted.ok, true)
  agent.session.events.push({ seq: 1, type: 'turn/start', data: {} })
  const forged = await grant.execute({ autonomy: true, humanMessageId: 'never-happened' }, { agent })
  assert.equal(forged.ok, false)
  assert.match(forged.error, /direct human request/)

  // And a failed attempt must not quietly spend the human's single-use token.
  assert.ok(service.panelAutonomyRequest, 'a refusal must leave the token unspent')
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
  const { ctx, state } = fakeHost({ withAgents: false })
  const service = new DenService(ctx)
  const deliver = createDeliver(ctx, service)

  // Throwing, not returning an empty string. An empty reply is what the kernel reads as
  // "the den woke, looked, and chose silence" — a successful wake. A wake that never
  // reached anyone must not be reported as one: it would charge the turn, advance the
  // cadence, and consume a check-in the human asked for. Throwing routes it to the
  // retry path instead.
  await assert.rejects(
    deliver({ trigger: { id: 't1', sessionId: 's1', title: 'x', prompt: 'y' }, instruction: 'go' }),
    /no delivery path/,
    'a wake that could not run must report failure, not invent output',
  )
  assert.ok(service.recentEvents.some((event) => event.type === 'wake-unavailable'))
})

test('registering tools twice does not duplicate them', () => {
  const { ctx, state } = fakeHost()
  const service = new DenService(ctx)
  const disposeA = registerTools(state.toolsApi, service)
  const disposeB = registerTools(state.toolsApi, service)
  assert.equal(state.tools.length, 32, 'the registry itself allows two sets; disposal must be exact')

  disposeA()
  assert.equal(state.tools.length, 16)
  disposeB()
  assert.equal(state.tools.length, 0)
})
