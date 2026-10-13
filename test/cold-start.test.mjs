/**
 * Cold start: the den wakes itself in a fresh process, with no human present.
 *
 * This is capability (2) — self-wake across a restart — and until now only its parts
 * were tested. `kernel.test.mjs` tests the gates, `triggers.js` catch-up is unit
 * tested, and `mount.test.mjs` checks that two activations over one home keep the
 * stored budget. None of those runs the whole chain: a trigger written by one process
 * being found, admitted, delivered, and marked fired by a *different* process whose
 * only connection to the first is the filesystem.
 *
 * The distinction matters because every step of that chain has its own way of failing
 * quietly:
 *
 *   - the trigger file could stop validating on a fresh read
 *   - the catch-up arithmetic could skip a window that elapsed while the host was down
 *   - the grant could fail to re-attest, because authority is bound to a human message
 *     and that message lives in the session's transcript
 *   - the cadence could be committed before delivery, so a crash mid-wake eats the
 *     check-in instead of retrying it
 *
 * Nothing here is simulated in-process. Two separate `apply()` calls over one
 * `DSH_HOME`, with the clock moved by hand, is what a restart is from the filesystem's
 * point of view — which is the only point of view a restarted process has.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { mock } from 'node:test'

const sandboxHome = mkdtempSync(join(tmpdir(), 'dsh-den-coldstart-'))
process.env.DSH_HOME = sandboxHome
// Exercise the "reply never arrived" timeout in seconds instead of the production two
// minutes. What is being tested is the behaviour on timeout, and waiting the real
// duration observes the same thing while making the suite slow enough to skip.
process.env.DSH_DEN_WAKE_REPLY_TIMEOUT_MS = '1500'
test.after(() => rmSync(sandboxHome, { recursive: true, force: true }))

const { apply } = await import('../src/index.js')
const { denHome, denPath, listJsonFiles, readJson, writeJsonAtomic } = await import('../src/atom.js')

/**
 * Back-date every stored schedule so it is due, the way downtime would leave it.
 *
 * Writing the file directly rather than going through `saveTrigger` is deliberate: the
 * point is to model a *different process* finding a schedule it did not create, and a
 * hand-edited or old file on disk is exactly that. It also pins the anchor in the past
 * relative to the real clock, which `mock.timers` cannot do — see the heartbeat test.
 */
function ageStoredTriggers(anchor) {
  const directory = denPath('triggers')
  for (const file of listJsonFiles(directory)) {
    const stored = readJson(file)
    if (!stored) continue
    writeJsonAtomic(file, { ...stored, createdAt: anchor, lastFiredAt: anchor })
  }
}

/**
 * Start every test from an empty den home.
 *
 * The state this suite exercises is durable *by design* — that is the whole point of a
 * cold start — so it leaks between tests unless it is cleared. The first run of this
 * file proved it: the first test spoke, `recordSpoke` wrote a timestamp, and every
 * later test was refused at the `pacing` gate for the next fifteen minutes. The
 * failures looked like broken authority and broken catch-up, and were neither.
 */
test.beforeEach(() => {
  rmSync(denHome(), { recursive: true, force: true })
})

/**
 * Let pending promise callbacks run.
 *
 * `mock.timers.tick()` fires the interval synchronously, but the heartbeat's callback
 * is async and passes through several awaits. Several real macrotask turns are needed
 * for that chain to finish; `setImmediate` is used rather than `setTimeout` because the
 * mocked clock does not advance on its own.
 */
function drain(turns = 5) {
  return new Promise((resolve) => {
    let left = turns
    const step = () => {
      if (left-- <= 0) return resolve()
      setImmediate(step)
    }
    step()
  })
}

/* ------------------------------------------------- a host whose sessions are durable */

/** The human's request, as it appears in the immutable session log. */
const HUMAN_MESSAGE_ID = 'msg-human-1'
const SESSION_ID = 'session-cold'

/**
 * A session transcript that survives a "restart".
 *
 * Deliberately module-level, not per-host: the point of a cold start is that the
 * transcript is the *same* object graph rebuilt from disk, so the grant's proof is
 * re-attested against records the previous process wrote, not against a fresh empty
 * session that would trivially make every check fail.
 *
 * The two turn boundaries are load-bearing and took a probe to get right.
 * `isDirectHumanDriver` walks backwards from the end of the log to the most recent
 * `turn/start` and looks for the human message *inside that turn only*. So a grant
 * can be authorized by the turn that asked for it, and never by some older human
 * message quoted out of history — a real constraint, and a stronger one than this
 * fixture originally modelled. The first version put the human message in a closed
 * turn and the gate correctly refused it.
 *
 * The current turn therefore contains: the human's request, the assistant's
 * acknowledgement of it, and nothing after — which is the state a real grant is made
 * in.
 */
function durableSession() {
  return {
    id: SESSION_ID,
    events: [
      { seq: 1, type: 'turn/start', data: {} },
      { seq: 2, type: 'user/message', data: { id: 'msg-earlier', source: { kind: 'user' }, text: 'unrelated earlier request' } },
      { seq: 3, type: 'assistant/message', data: { text: 'done' } },
      { seq: 4, type: 'turn/end', data: {} },
      { seq: 5, type: 'turn/start', data: {} },
      { seq: 6, type: 'user/message', data: { id: HUMAN_MESSAGE_ID, source: { kind: 'user' }, text: 'wake me up if CI breaks' } },
      { seq: 7, type: 'assistant/message', data: { text: 'understood' } },
    ],
  }
}

/**
 * A host context built for this test rather than shared, because the shared fixture
 * models a host that is up. This one has to model a host that was *down*: the clock
 * advances, nothing is live, and the wake has to cold-resume the conversation.
 */
function coldHost({ agent = null } = {}) {
  const state = {
    provided: new Map(),
    listeners: new Map(),
    tools: [],
    guards: [],
    routes: [],
    resumeCalls: [],
    sentMessages: [],
    delivered: [],
    /**
     * What the den says when the heartbeat wakes it. Read back from the session log,
     * because `sendMessage` returns only an inbox id.
     */
    replyText: 'The build on main is red since 14:02 - two failures in the parser suite.',
  }

  state.session = durableSession()
  state.toolsApi = {
    register(definition) {
      state.tools.push(definition)
      return () => {}
    },
    guard(handler) {
      state.guards.push(handler)
      return () => {}
    },
  }

  state.agentsApi = {
    /**
     * Resolve by agent id *and* by session id, reading `state.liveAgent` rather than a
     * captured parameter.
     *
     * Two different lookups are needed: `isDirectHumanDriver` asks the registry to hand
     * back the very agent object it was given, while the wake path asks "is anything
     * live for this conversation?". Collapsing them made a correct grant fail its own
     * authentication.
     *
     * Reading the captured `agent` option instead of `state.liveAgent` is the subtler
     * bug: the option is how a test *seeds* a live agent, but the grant test creates
     * one and registers it afterwards. A closure over the seed value then answers
     * "nothing is live" forever, and the failure looks like a product rejection rather
     * than a fixture that cannot see what the test just did. Dispatch through `state`
     * only.
     */
    get: (id) => {
      const live = state.liveAgent
      if (live && live.id === id) return live
      if (live && live.session?.id === id) return live
      return undefined
    },
    resume: async ({ resumeSessionId }) => {
      state.resumeCalls.push(resumeSessionId)
      // A cold resume hands back a driver over the persisted transcript — the same
      // events, rebuilt. Authority is re-attested against them, not re-granted.
      //
      // Recording it as live is not a convenience: resuming *is* what makes a
      // conversation live, and the wake path then looks the driver up by session id.
      // A fixture that resumes without registering models a host where resume silently
      // does nothing, and the wake reports "nothing to say" — the right answer to the
      // wrong question.
      const resumed = { id: 'agent-resumed', status: 'running', session: state.session }
      state.liveAgent = resumed
      return {
        agent: resumed,
        dispose: async () => {
          state.resumedDisposed = true
        },
      }
    },
  }

  /**
   * Delivery, modelled on what the real host does.
   *
   * `sendMessage` returns the accepted message's **inbox id** and nothing else — that
   * is the real contract, `Promise<MessageId>`. What the den actually said arrives
   * later, as an `assistant/message` event on the session. So this fixture appends
   * one, which is the only way the wake's reply can be read back at all.
   *
   * The first version of this fixture recorded the delivery and appended nothing. The
   * test then hung for the full two-minute reply timeout — which is the correct
   * behaviour for a wake whose reply never lands, and is exactly why the timeout and
   * the `wake-reply-unreadable` event exist.
   */
  state.subagents = {
    async sendMessage(sender, sessionId, content) {
      state.sentMessages.push({ sender, sessionId, content })
      if (state.replyText === null) return 'msg-wake' // a wake with no readable reply
      const nextSeq = state.session.events.length + 1
      state.session.events.push({
        seq: nextSeq,
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 1,
          message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: state.replyText }] },
          stream: [],
        },
      })
      return 'msg-wake'
    },
  }

  state.webServer = { register: () => () => {} }

  /**
   * The live session store, as `ctx.sessions.get(id)` presents it.
   *
   * Needed because the wake's reply is read from the session log rather than returned
   * by `sendMessage`. Returning the session object lets the real `sessionEvents()` in
   * `grant.js` run against it, so the fixture exercises the production read path
   * instead of a bespoke one.
   */
  state.sessions = {
    get: (id) => {
      const live = state.liveAgent
      if (live && live.session?.id === id) return live.session
      if (state.session?.id === id) return state.session
      return undefined
    },
  }

  const ctx = {
    tools: state.toolsApi,
    agents: state.agentsApi,
    webServer: state.webServer,
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    provide: (key, value) => state.provided.set(key, value),
    get(key) {
      // Read through `state` so a test can withdraw a service and have the plugin
      // observe its absence, rather than closing over the original object.
      if (key === 'subagents') return state.subagents
      if (key === 'sessions') return state.sessions
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

  state.ctx = ctx
  return { ctx, state }
}

/** Call a tool by name against an activated host. */
async function callTool(state, name, args, exec) {
  const tool = state.tools.find((item) => item.name === name)
  if (!tool) throw new Error(`no such tool: ${name}`)
  return tool.execute(args, exec)
}

/**
 * Grant autonomy through the real tool, so the record on disk has the shape the real
 * code writes rather than one this test invented.
 *
 * `exec.agent` is how the host tells a tool which conversation called it. Autonomy is
 * per conversation, so a grant without that scope is refused — which is the correct
 * behaviour and is asserted separately.
 *
 * The agent has to satisfy `isDirectHumanDriver`: a running status, an id the registry
 * resolves back to this very object, and a transcript whose current turn contains the
 * human message. That is a deliberately hard gate, and it is a grant path, so the
 * fixture must meet it honestly rather than the check being loosened for the test.
 */
async function grantAutonomy(state) {
  const agent = { id: 'agent-cold', status: 'running', session: state.session }

  state.liveAgent = agent
  return callTool(
    state,
    'den_set_autonomy',
    { autonomy: true, humanMessageId: HUMAN_MESSAGE_ID },
    { agent },
  )
}

/* ------------------------------------------------------------------------- tests */

test('a trigger created before the restart is found and fired after it', async () => {
  // --- process one: the human is present, sets up a check, and authorizes it.
  const first = coldHost()
  apply(first.ctx)
  const created = await callTool(first.state, 'den_schedule_check', {
    kind: 'interval',
    title: 'CI watch',
    prompt: 'Report only failures.',
    sessionId: SESSION_ID,
    everySeconds: 300,
  })
  assert.equal(created.ok, true, 'the schedule must be created')
  const grant = await grantAutonomy(first.state)
  assert.equal(grant.ok, true, `the human grant must be recorded: ${JSON.stringify(grant)}`)
  first.state.dispose?.()

  // --- the host is down for an hour. Nothing runs. The clock moves by hand, because
  //     a restart that happens to take 300 seconds is not the interesting case.
  const downFor = 60 * 60 * 1000
  const now = Date.now() + downFor

  // --- process two: a fresh activation over the same home, no human, nothing live.
  const second = coldHost()
  apply(second.ctx)
  const service = second.state.provided.get('den')

  const due = service.dueTriggers(now)
  assert.equal(due.length, 1, 'the overnight trigger must be due on the next boot')
  assert.equal(due[0].trigger.title, 'CI watch')

  // Drive the real heartbeat at the synthetic instant. This is the cold wake.
  const outcome = await service.kernel.tick({ agent: undefined, now })

  assert.equal(outcome.due, 1)
  const result = outcome.results[0]
  assert.equal(result.outcome, 'spoke', `expected a real wake, got ${JSON.stringify(result)}`)

  // The wake reached the conversation by cold-resuming it, not by finding a live one.
  assert.deepEqual(second.state.resumeCalls, [SESSION_ID], 'the session must be cold-resumed')
  assert.equal(second.state.sentMessages.length, 1, 'exactly one wake was delivered')
  assert.match(second.state.sentMessages[0].content[0].text, /Report only failures\./)
  assert.equal(second.state.resumedDisposed, true, 'the resumed driver must be released again')

  // And the cadence advanced, on disk, so the wake is not delivered twice.
  const after = service.listTriggers().valid[0]
  assert.equal(after.fireCount, 1)
  assert.equal(typeof after.lastFiredAt, 'number')
  service.kernel.stop()
})

test('authority survives the restart because it is re-attested, not re-granted', async () => {
  const first = coldHost()
  apply(first.ctx)
  await callTool(first.state, 'den_schedule_check', {
    kind: 'interval',
    title: 'second check',
    prompt: 'x',
    sessionId: SESSION_ID,
    everySeconds: 300,
  })
  await grantAutonomy(first.state)
  first.state.dispose?.()

  const now = Date.now() + 60 * 60 * 1000
  const second = coldHost()
  apply(second.ctx)
  const service = second.state.provided.get('den')

  // The grant record is on disk; the proof is in the transcript. If either fails to
  // re-attest, this wake is refused at the authority gate — which is the correct
  // outcome, and the one worth asserting explicitly rather than inferring.
  const outcome = await service.kernel.tick({ agent: undefined, now })
  assert.equal(outcome.results[0].outcome, 'spoke', 'authority must survive the restart')
  service.kernel.stop()
})

test('a restart without a grant wakes nothing and says which gate stopped it', async () => {
  const first = coldHost()
  apply(first.ctx)
  await callTool(first.state, 'den_schedule_check', {
    kind: 'interval',
    title: 'unauthorized check',
    prompt: 'x',
    sessionId: SESSION_ID,
    everySeconds: 300,
  })
  // Note the omission: no grant. A timer is not a permission.
  first.state.dispose?.()

  const now = Date.now() + 60 * 60 * 1000
  const second = coldHost()
  apply(second.ctx)
  const service = second.state.provided.get('den')

  const outcome = await service.kernel.tick({ agent: undefined, now })
  assert.equal(outcome.results[0].outcome, 'refused')
  assert.equal(outcome.results[0].gate, 'authority', 'the refusal must name the gate')
  assert.equal(second.state.sentMessages.length, 0, 'nothing may be delivered without authority')
  // The trigger is untouched, so it is still due — the intent is not consumed by a
  // refusal. This is what makes the gate safe to leave switched on.
  assert.equal(service.listTriggers().valid[0].fireCount, 0)
  service.kernel.stop()
})

test('downtime longer than the interval resumes the cadence instead of firing a storm', async () => {
  const first = coldHost()
  apply(first.ctx)
  await callTool(first.state, 'den_schedule_check', {
    kind: 'interval',
    title: 'every five minutes',
    prompt: 'x',
    sessionId: SESSION_ID,
    everySeconds: 300,
  })
  await grantAutonomy(first.state)
  first.state.dispose?.()

  // Down for a whole day: 288 intervals elapsed. A naive implementation delivers 288
  // check-ins on the first tick. `nextTriggerAt` catches up in whole steps instead.
  const now = Date.now() + 24 * 60 * 60 * 1000
  const second = coldHost()
  apply(second.ctx)
  const service = second.state.provided.get('den')

  const outcome = await service.kernel.tick({ agent: undefined, now })
  assert.equal(outcome.due, 1, 'a day of downtime is one due occurrence, not hundreds')
  assert.equal(second.state.sentMessages.length, 1)
  service.kernel.stop()
})

test('the real heartbeat fires the wake, with no agent handed to tick()', async () => {
  // Every other test in this file calls `tick({ agent })` by hand. The production
  // heartbeat does not: `start()` arms `setInterval(() => this.tick())`, with no
  // arguments. So those calls exercise a path that never runs in the field, and this
  // test drives the one that does.
  const first = coldHost()
  apply(first.ctx)
  await callTool(first.state, 'den_schedule_check', {
    kind: 'interval',
    title: 'heartbeat check',
    prompt: 'Report only failures.',
    sessionId: SESSION_ID,
    everySeconds: 300,
  })
  await grantAutonomy(first.state)

  // Make the stored schedule genuinely due, as it would be after an hour of downtime.
  //
  // This has to be written to disk rather than arranged in memory, because the whole
  // point is that the *second* process knows nothing except what it reads. It also has
  // to happen after creation: a freshly created interval is deliberately never due at
  // once — its anchor is its creation time — so a den that is working normally does not
  // fire a check-in the moment the human asks for one. `mock.timers` cannot manufacture
  // this either, because it freezes one shared `Date.now()` for the whole process: a
  // trigger created at the real now is anchored there, and moving that same clock
  // forward by a minute moves creation forward with it.
  ageStoredTriggers(Date.now() - 60 * 60 * 1000)
  first.state.dispose?.()

  // The interval is mocked so the *real* callback can be reached. Nobody passes it
  // anything: whatever it has, it resolved itself.
  mock.timers.enable({ apis: ['setInterval'], now: Date.now() })
  try {
    const second = coldHost()
    apply(second.ctx)
    const service = second.state.provided.get('den')
    assert.ok(service.kernel, 'the heartbeat must be running')
    assert.equal(second.state.sentMessages.length, 0, 'nothing has fired yet')

    mock.timers.tick(60_000)
    // `tick()` fires the interval synchronously, but the callback is async: the wake
    // runs through several awaits (resolve the driver, deliver, read the reply). Let
    // the microtask queue drain before asserting, or the assertion races the wake.
    await drain(30)

    assert.equal(
      second.state.sentMessages.length,
      1,
      'the heartbeat must deliver the wake without being handed an agent',
    )
    assert.match(second.state.sentMessages[0].content[0].text, /heartbeat check/)
    assert.equal(service.listTriggers().valid[0].fireCount, 1)

    // The reply was read back from the session log, so the wake counted as something
    // worth saying and a notice is waiting for the human. Without the read-back this
    // is `silent` and the notice is never queued — the defect this test was written
    // after finding.
    const notices = service.noticesFor(SESSION_ID)
    assert.equal(notices.deliverable.length, 1, 'a wake with something to say must queue a notice')
    assert.match(notices.deliverable[0].text, /build on main is red/)
    service.kernel.stop()
  } finally {
    mock.timers.reset()
  }
})

test('a wake whose reply never lands is recorded, retried, and not charged', async () => {
  const first = coldHost()
  apply(first.ctx)
  await callTool(first.state, 'den_schedule_check', {
    kind: 'interval',
    title: 'unreadable reply',
    prompt: 'x',
    sessionId: SESSION_ID,
    everySeconds: 300,
  })
  await grantAutonomy(first.state)
  first.state.dispose?.()

  const now = Date.now() + 60 * 60 * 1000
  const second = coldHost()
  apply(second.ctx)
  const service = second.state.provided.get('den')
  // Authority resolves, the wake is delivered, but no assistant message is ever
  // appended: the reply cannot be read.
  second.state.replyText = null

  const outcome = await service.kernel.tick({ agent: undefined, now })

  // The turn was spent, so this trigger is due again on the next heartbeat rather than
  // silently consumed — an unreadable reply must not look like a deliberate silence.
  assert.equal(outcome.results[0].outcome, 'silent')
  assert.equal(outcome.results[0].reason, 'empty')
  assert.ok(
    service.recentEvents.some((event) => event.type === 'wake-reply-unreadable'),
    'an unreadable reply must be visible in the event log, not swallowed',
  )
  assert.equal(second.state.sentMessages.length, 1, 'the wake really was delivered')
  service.kernel.stop()
})

test('a refusal distinguishes "no transcript" from "not authorized"', async () => {
  const first = coldHost()
  apply(first.ctx)
  await callTool(first.state, 'den_schedule_check', {
    kind: 'interval',
    title: 'readable transcript, unauthorized',
    prompt: 'x',
    sessionId: SESSION_ID,
    everySeconds: 300,
  })
  await grantAutonomy(first.state)
  ageStoredTriggers(Date.now() - 60 * 60 * 1000)
  first.state.dispose?.()

  const now = Date.now()
  const second = coldHost()
  apply(second.ctx)
  const service = second.state.provided.get('den')

  // The transcript is readable and the grant is valid, so authority is genuine. There
  // is no delivery path, so the wake is admitted and then fails to reach anyone — which
  // is a *different* outcome from a gate refusal, and must be reported as a failure that
  // will be retried rather than as a wake that chose to stay silent.
  second.state.subagents = null
  const admitted = await service.kernel.tick({ agent: undefined, now })
  assert.equal(admitted.results[0].outcome, 'failed')
  assert.equal(admitted.results[0].willRetry, true)
  assert.ok(
    service.recentEvents.some((event) => event.type === 'wake-unavailable'),
    'an admitted wake with nowhere to go must say so',
  )
  assert.equal(
    service.listTriggers().valid[0].fireCount,
    0,
    'a check-in that never reached anyone must not be consumed',
  )
  service.kernel.stop()
})

test('a refusal is not charged, so the intent survives until it can run', async () => {
  const first = coldHost()
  apply(first.ctx)
  await callTool(first.state, 'den_schedule_check', {
    kind: 'interval',
    title: 'never authorized',
    prompt: 'x',
    sessionId: SESSION_ID,
    everySeconds: 300,
  })
  // Note the omission: no grant. A schedule is not a permission, so the authority gate
  // refuses - and this is the case that must be told apart from "nothing to check
  // against", because the transcript is perfectly readable here.
  ageStoredTriggers(Date.now() - 60 * 60 * 1000)
  first.state.dispose?.()

  const now = Date.now()
  const second = coldHost()
  apply(second.ctx)
  const service = second.state.provided.get('den')

  const outcome = await service.kernel.tick({ agent: undefined, now })
  assert.equal(outcome.due, 1)
  assert.equal(outcome.results[0].outcome, 'refused')
  assert.equal(outcome.results[0].gate, 'authority')
  assert.equal(
    outcome.results[0].hadSession,
    true,
    'the refusal must say the transcript was readable, so this is a real denial',
  )
  assert.equal(service.listTriggers().valid[0].fireCount, 0, 'a refused check-in must not be charged')
  assert.equal(second.state.sentMessages.length, 0, 'nothing may be delivered without authority')
  service.kernel.stop()
})

test('a refused wake is throttled instead of re-asked every heartbeat', async () => {
  // Found on the running host, not here: a single unauthorized `once` trigger produced a
  // `wake-refused` event every 60 seconds, exactly on the tick. Nothing on the refusal
  // path advances `lastFiredAt`, so the trigger stayed due and every heartbeat asked the
  // same question again — 1,440 times a day, each one appending to the event log. The
  // reply to a permanent condition cannot change by asking again.
  const first = coldHost()
  apply(first.ctx)
  await callTool(first.state, 'den_schedule_check', {
    kind: 'interval',
    title: 'never authorized',
    prompt: 'x',
    sessionId: SESSION_ID,
    everySeconds: 300,
  })
  ageStoredTriggers(Date.now() - 60 * 60 * 1000)
  first.state.dispose?.()

  const now = Date.now()
  const second = coldHost()
  apply(second.ctx)
  const service = second.state.provided.get('den')

  const refused = await service.kernel.tick({ agent: undefined, now })
  assert.equal(refused.results[0].outcome, 'refused')
  assert.equal(refused.results[0].gate, 'authority')

  // One second later the trigger is still due by its own cadence — which is exactly why
  // the cadence alone cannot be what stops it.
  const again = await service.kernel.tick({ agent: undefined, now: now + 1000 })
assert.equal(again.due, 0, 'a refused wake must go quiet for the retry window')
  assert.equal(again.results.length, 0, 'and must not be re-decided in the meantime')

  const stored = service.listTriggers().valid[0]
  assert.ok(
    Number.isFinite(stored.lastAttemptAt),
    'the throttle is what did it, so the attempt must be recorded on the trigger',
  )
  assert.equal(
    new Date(stored.lastAttemptAt).getTime(),
    now,
    'recorded at the refusal, not at some later moment',
  )
  assert.equal(stored.fireCount, 0, 'throttling must not charge the check-in')

  // And it must come back, or the throttle would be indistinguishable from a silent drop.
  const later = await service.kernel.tick({ agent: undefined, now: now + 16 * 60 * 1000 })
  assert.equal(later.due, 1, 'once the window passes the check-in is reconsidered')
  service.kernel.stop()
})

test('an idle tick answers with the same shape as a busy one', async () => {
  // `tick()` used to resolve to `{due: 0, woke: 0, spoke: 0}` when nothing was due and
  // to an object *with* `results` otherwise. Reading `tick().results.length` — the
  // obvious way to ask what a tick decided — threw on exactly the ticks where nothing
  // happened, and for a resident assistant that is the common case. The first two
  // assertions below are the ones that found it.
  const host = coldHost()
  apply(host.ctx)
  const service = host.state.provided.get('den')

  const idle = await service.kernel.tick({ agent: undefined, now: Date.now() })
  assert.equal(idle.due, 0)
  assert.ok(Array.isArray(idle.results), 'an idle tick must still report its decisions as a list')
  assert.equal(idle.results.length, 0)

  await callTool(host.state, 'den_schedule_check', {
    kind: 'interval',
    title: 'something due',
    prompt: 'x',
    sessionId: SESSION_ID,
    everySeconds: 300,
  })
  ageStoredTriggers(Date.now() - 60 * 60 * 1000)

  const busy = await service.kernel.tick({ agent: undefined, now: Date.now() })
  assert.equal(busy.due, 1)
  assert.ok(Array.isArray(busy.results))
  assert.deepEqual(
    Object.keys(busy).sort(),
    Object.keys(idle).sort(),
    'the two outcomes of one method must not have different shapes',
  )
  service.kernel.stop()
})

test('an unreadable transcript refuses without cold-resuming the conversation', async () => {
  const first = coldHost()
  apply(first.ctx)
  await callTool(first.state, 'den_schedule_check', {
    kind: 'interval',
    title: 'gone conversation',
    prompt: 'x',
    sessionId: SESSION_ID,
    everySeconds: 300,
  })
  await grantAutonomy(first.state)
  ageStoredTriggers(Date.now() - 60 * 60 * 1000)
  first.state.dispose?.()

  const now = Date.now()
  const second = coldHost()
  apply(second.ctx)
  const service = second.state.provided.get('den')
  // Nothing live, nothing readable: the session is simply gone.
  second.state.sessions = { get: () => undefined }
  second.state.liveAgent = undefined

  const outcome = await service.kernel.tick({ agent: undefined, now })
  assert.equal(outcome.results[0].outcome, 'refused')
  assert.equal(outcome.results[0].gate, 'authority')
  assert.equal(outcome.results[0].hadSession, false)
  // The point of the split: authority needs a transcript, not a driver. Resuming here
  // would spend a driver on every refusal, on a timer, forever.
  assert.deepEqual(
    second.state.resumeCalls,
    [],
    'an unauthorized wake must not cold-resume anything',
  )
  service.kernel.stop()
})
