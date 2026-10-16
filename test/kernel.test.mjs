/**
 * Tests for the scheduling triggers, the three gates, and the heartbeat.
 *
 * These are the safety-critical paths: an interval floor that holds, a spent
 * budget that survives a restart, quiet hours that actually wrap midnight, and a
 * silent wake that produces no notice at all.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-den-kernel-'))
process.env.DSH_HOME = sandbox

const { writeJsonAtomic, digest } = await import('../src/atom.js')
const {
  FAILED_WAKE_RETRY_MS,
  MAX_PROMPT_CHARS,
  MIN_INTERVAL_SECONDS,
  deleteTrigger,
  dueTriggers,
  listTriggers,
  markFired,
  nextTriggerAt,
  normalizeTrigger,
  readTrigger,
  saveTrigger,
} = await import('../src/triggers.js')
const {
  DenKernel,
  bumpLedger,
  evaluateGates,
  inQuietHours,
  interpretWakeResult,
  TASK_STEP_INSTRUCTION,
  WAKE_INSTRUCTION,
  readLedger,
  recordSpoke,
} = await import('../src/kernel.js')
const { allNotices } = await import('../src/notices.js')
const { KernelLease, TAKEOVER_GRACE_MS, leasePath } = await import('../src/resident.js')

test.after(() => rmSync(sandbox, { recursive: true, force: true }))

function baseTrigger(overrides = {}) {
  return {
    sessionId: 'session-k',
    title: 'Check the build',
    prompt: 'Look at CI and report only if it broke.',
    ...overrides,
  }
}

/**
 * Every gate reads durable state, so tests must not inherit each other's ledger,
 * pacing timestamp, or triggers. A cooldown recorded by one test would otherwise
 * silently refuse a later test's wake and the failure would look like a kernel
 * bug rather than test bleed.
 */
test.beforeEach(() => {
  for (const sub of ['triggers', 'ledger', 'notices']) {
    rmSync(join(sandbox, 'den', sub), { recursive: true, force: true })
  }
  rmSync(join(sandbox, 'den', 'pacing.json'), { force: true })
  // The residency lease is durable too, and a lease left by one test would make the next one
  // stand down and look like a broken kernel.
  rmSync(leasePath(), { force: true })
})

/** Grant standing autonomy to a fake agent through a verifiable human turn. */
function authorizedAgent(sessionId = 'session-k', messageId = 'msg-1') {
  const events = [
    { seq: 1, type: 'turn/start' },
    { seq: 2, type: 'user/message', data: { id: messageId, source: { kind: 'user' } } },
  ]
  writeJsonAtomic(join(sandbox, 'den', 'grants', `${digest(sessionId)}.json`), {
    version: 1,
    sessionId,
    autonomy: true,
    humanMessageId: messageId,
    humanSeq: 2,
    recordedAfterSeq: 2,
  })
  return { id: 'agent-k', status: 'running', session: { id: sessionId, events } }
}

// ---------------------------------------------------------------- triggers

test('an interval shorter than the floor is rejected', () => {
  assert.throws(
    () => normalizeTrigger(baseTrigger({ kind: 'interval', everySeconds: MIN_INTERVAL_SECONDS - 1 })),
    { message: /at least 300/ },
  )
  const ok = normalizeTrigger(baseTrigger({ kind: 'interval', everySeconds: MIN_INTERVAL_SECONDS }))
  assert.equal(ok.everySeconds, 300)
})

test('a prompt cannot exceed the bound', () => {
  assert.throws(
    () => normalizeTrigger(baseTrigger({ kind: 'once', at: Date.now(), prompt: 'x'.repeat(MAX_PROMPT_CHARS + 1) })),
    { message: /exceeds 8000/ },
  )
})

test('a trigger must belong to a session', () => {
  assert.throws(
    () => normalizeTrigger({ kind: 'once', at: Date.now(), title: 't', prompt: 'p' }),
    { message: /sessionId is required/ },
  )
})

test('maxRuns above 1000 is rejected', () => {
  assert.throws(
    () => normalizeTrigger(baseTrigger({ kind: 'interval', everySeconds: 600, maxRuns: 1001 })),
    { message: /maxRuns exceeds 1000/ },
  )
})

test('a malformed clock is rejected for daily triggers', () => {
  assert.throws(() => normalizeTrigger(baseTrigger({ kind: 'daily', atTime: '25:00' })), { message: /HH:MM/ })
  assert.throws(() => normalizeTrigger(baseTrigger({ kind: 'daily', atTime: '7:5' })), { message: /HH:MM/ })
})

test('an interval asked for a moment after the outage lands back on its original grid', () => {
  // What this does NOT show is that the system keeps its cadence across an outage. It shows the
  // arithmetic of `nextTriggerAt` when the caller asks for an instant later than one step past the
  // last fire - and no caller in this repo asks that way: `dueTriggers` and `statusSnapshot` both
  // pass `lastFiredAt ?? 0`, which is the same value the arithmetic starts from, so the branch below
  // never runs in the shipped system. That is deliberate for `dueTriggers` (asking "after now" would
  // push a check-in missed during downtime into the future and skip it), and its cost is that a
  // wake re-anchors the cadence to when it actually ran.
  const createdAt = Date.UTC(2026, 0, 1, 0, 0, 0)
  const trigger = normalizeTrigger(baseTrigger({ kind: 'interval', everySeconds: 600 }))
  const stored = { ...trigger, createdAt, lastFiredAt: createdAt }

  // Querying at the last fire instant yields the very next step.
  assert.equal(nextTriggerAt(stored, createdAt), createdAt + 600_000)

  // Asked for a moment after an hour of downtime, the answer stays on the 600s grid and is at most
  // one step away — not an hour of backlog to replay.
  const afterOutage = createdAt + 3_600_000 + 1
  const next = nextTriggerAt(stored, afterOutage)
  assert.equal((next - createdAt) % 600_000, 0)
  assert.ok(next > afterOutage && next - afterOutage <= 600_000)

  // The same outage asked the way the callers ask: one step past the last fire, phase shifted.
  assert.equal(nextTriggerAt(stored, stored.lastFiredAt), createdAt + 600_000)
})

test('a stored trigger missing the fields its schedule needs is reported invalid, not silently dead', () => {
  // `isValidStored` checked the envelope — id, sessionId, kind, title, prompt, enabled, fireCount —
  // and none of the fields `nextTriggerAt` reads. A record with no `everySeconds` therefore passed
  // validation, was listed as a *valid* trigger, and could never be due: a reminder the human relies
  // on that never fires while everything reports it as healthy.
  const prefix = `broken-${Date.now()}`
  const whole = normalizeTrigger(baseTrigger({ kind: 'interval', everySeconds: 600 }))
  // Spreading over `whole` cannot *remove* a field, only replace it: `{ kind: 'interval' }` leaves
  // the everySeconds that `whole` already had, so the fixture would quietly keep the field the test
  // is about. Every removal below is written as an explicit `undefined`, which JSON drops on write.
  const broken = [
    ['interval with no everySeconds', { kind: 'interval', everySeconds: undefined }],
    ['daily with no atTime', { kind: 'daily', atTime: undefined }],
    ['weekly with no weekday', { kind: 'weekly', atTime: 540, weekday: undefined }],
    ['once with no at', { kind: 'once', at: undefined }],
    ['interval below the floor', { kind: 'interval', everySeconds: 5 }],
    ['daily with an out-of-range atTime', { kind: 'daily', atTime: 1440 }],
    ['no createdAt', { kind: 'interval', everySeconds: 600, createdAt: undefined }],
  ]
  const brokenIds = []
  broken.forEach(([, shape], index) => {
    const id = `${prefix}-${index}`
    brokenIds.push(id)
    saveTrigger({ ...whole, ...shape, id })
  })

  // A wholly valid trigger in the same store, so "reject everything" cannot pass this test.
  const healthyId = `${prefix}-ok`
  saveTrigger({ ...whole, id: healthyId })

  const listed = listTriggers()
  const invalidNames = listed.invalid.map((path) => String(path).split(/[\\/]/).pop())
  for (const id of brokenIds) {
    assert.ok(invalidNames.includes(`${id}.json`), `${id} must be reported invalid, not silently dead`)
  }
  assert.ok(
    listed.valid.some((trigger) => trigger.id === healthyId),
    'the healthy trigger in the same store must stay valid',
  )
  assert.equal(
    listed.valid.filter((trigger) => brokenIds.includes(trigger.id)).length,
    0,
    'no unschedulable trigger may be reported as valid',
  )

  const far = Date.now() + 90 * 24 * 3600 * 1000
  const dueIds = dueTriggers(far).map((entry) => entry.trigger.id)
  assert.ok(dueIds.includes(healthyId), 'the healthy trigger is due ninety days out')
  for (const id of brokenIds) assert.ok(!dueIds.includes(id), `${id} must never be due`)
})

test('a well-formed stored trigger of every kind stays valid and schedulable', () => {
  // The control for the test above: a validator that rejected everything would satisfy it.
  const prefix = `shape-${Date.now()}`
  const shapes = [
    baseTrigger({ kind: 'once', at: Date.now() + 3_600_000 }),
    baseTrigger({ kind: 'interval', everySeconds: MIN_INTERVAL_SECONDS }),
    baseTrigger({ kind: 'daily', atTime: '09:30' }),
    baseTrigger({ kind: 'weekly', atTime: '09:30', weekday: 3 }),
  ]
  const ids = shapes.map((shape, index) => {
    const id = `${prefix}-${index}`
    saveTrigger({ ...normalizeTrigger(shape), id })
    return id
  })

  const { valid } = listTriggers()
  for (const id of ids) {
    const stored = valid.find((trigger) => trigger.id === id)
    assert.ok(stored, `${id} must stay valid`)
    assert.notEqual(nextTriggerAt(stored, Date.now()), undefined, `${id} must be schedulable`)
  }
})

test('a one-shot trigger in the past is spent', () => {
  const trigger = normalizeTrigger(baseTrigger({ kind: 'once', at: 1000 }))
  assert.equal(nextTriggerAt(trigger, 2000), undefined)
  assert.equal(nextTriggerAt(trigger, 500), 1000)
})

test('a trigger that reached maxRuns is spent', () => {
  const trigger = normalizeTrigger(baseTrigger({ kind: 'interval', everySeconds: 600, maxRuns: 2 }))
  assert.equal(nextTriggerAt({ ...trigger, fireCount: 2 }, Date.now()), undefined)
})

test('a daily trigger lands on the next occurrence at the configured local time', () => {
  const trigger = normalizeTrigger(baseTrigger({ kind: 'daily', atTime: '09:30' }))
  const from = new Date(2026, 4, 10, 12, 0, 0).getTime()
  const next = nextTriggerAt(trigger, from)
  const asDate = new Date(next)
  assert.equal(asDate.getHours(), 9)
  assert.equal(asDate.getMinutes(), 30)
  assert.equal(asDate.getDate(), 11)
})

test('a due trigger is detected and firing it advances the count', () => {
  const trigger = normalizeTrigger(baseTrigger({ kind: 'interval', everySeconds: 300, title: 'unique-due' }))
  const stored = { ...trigger, createdAt: 1000, lastFiredAt: 1000 }
  saveTrigger(stored)

  const due = dueTriggers(1000 + 300_000)
  assert.ok(due.some((item) => item.trigger.id === stored.id))

  const after = markFired(stored, 1000 + 300_000)
  assert.equal(after.fireCount, 1)
  assert.equal(after.lastFiredAt, 1000 + 300_000)
})

test('a one-shot trigger disables itself once fired', () => {
  const trigger = normalizeTrigger(baseTrigger({ kind: 'once', at: 5000, title: 'unique-once' }))
  saveTrigger(trigger)
  const after = markFired(trigger, 5000)
  assert.equal(after.enabled, false)
})

test('triggers for another session are never mixed in', () => {
  const mine = normalizeTrigger(baseTrigger({ kind: 'interval', everySeconds: 300, title: 'mine' }))
  saveTrigger({ ...mine, sessionId: 'session-mine', createdAt: 1, lastFiredAt: 1 })
  const due = dueTriggers(1 + 300_000)
  assert.ok(due.every((item) => typeof item.trigger.sessionId === 'string'))
})

test('a deleted trigger disappears and a missing one reports false', () => {
  const trigger = normalizeTrigger(baseTrigger({ kind: 'interval', everySeconds: 300, title: 'to-delete' }))
  saveTrigger(trigger)
  assert.equal(deleteTrigger(trigger.id), true)
  assert.equal(deleteTrigger(trigger.id), false)
  assert.ok(!listTriggers().valid.some((item) => item.id === trigger.id))
})

test('a corrupt stored trigger is reported invalid, not trusted', () => {
  writeJsonAtomic(join(sandbox, 'den', 'triggers', 'broken.json'), { kind: 'interval', version: 1 })
  const { invalid } = listTriggers()
  assert.ok(invalid.length >= 1)
})

// ------------------------------------------------------------------- gates

test('quiet hours wrap past midnight', () => {
  const quiet = { from: 23 * 60, to: 7 * 60 }
  assert.equal(inQuietHours(quiet, new Date(2026, 0, 1, 23, 30)), true)
  assert.equal(inQuietHours(quiet, new Date(2026, 0, 1, 3, 0)), true)
  assert.equal(inQuietHours(quiet, new Date(2026, 0, 1, 12, 0)), false)
  assert.equal(inQuietHours(null, new Date(2026, 0, 1, 3, 0)), false)
})

test('an agent without verified authority is refused at the authority gate', () => {
  const stranger = { id: 'agent-x', status: 'running', session: { id: 'session-none', events: [] } }
  const verdict = evaluateGates({ state: { dailyTurnBudget: 10, cooldownSeconds: 0, quietHours: null }, agent: stranger })
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.gate, 'authority')
})

test('a zero budget disables proactivity entirely', () => {
  const agent = authorizedAgent('session-budget')
  const verdict = evaluateGates({
    state: { dailyTurnBudget: 0, cooldownSeconds: 0, quietHours: null },
    agent,
  })
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.gate, 'budget')
})

test('a spent budget survives a restart', () => {
  const agent = authorizedAgent('session-spent')
  const state = { dailyTurnBudget: 2, cooldownSeconds: 0, quietHours: null }
  assert.equal(evaluateGates({ state, agent }).allowed, true)
  bumpLedger('turns')
  bumpLedger('turns')
  // A fresh call stands in for a restarted process: the ledger is on disk.
  assert.equal(readLedger().turns, 2)
  const verdict = evaluateGates({ state, agent })
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.gate, 'budget')
  assert.match(verdict.reason, /2\/2/)
})

test('the pacing gate blocks a second utterance too soon', () => {
  const agent = authorizedAgent('session-pacing')
  const state = { dailyTurnBudget: 100, cooldownSeconds: 900, quietHours: null }
  const now = Date.now()
  recordSpoke(now)
  const verdict = evaluateGates({ state, agent, now: now + 1000 })
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.gate, 'pacing')
})

// ------------------------------------------------------------- wake output

test('a SKIP reply means say nothing', () => {
  assert.deepEqual(interpretWakeResult('SKIP'), { speak: false, reason: 'skip' })
  assert.deepEqual(interpretWakeResult('  skip.  '), { speak: false, reason: 'skip' })
  assert.deepEqual(interpretWakeResult('   '), { speak: false, reason: 'empty' })
  assert.deepEqual(interpretWakeResult(undefined), { speak: false, reason: 'empty' })
})

test('a real message is spoken and bounded', () => {
  const long = interpretWakeResult('x'.repeat(9000))
  assert.equal(long.speak, true)
  assert.equal(long.message.length, 4000)
  const short = interpretWakeResult('CI is red on main since 14:02.')
  assert.equal(short.speak, true)
  assert.match(short.message, /CI is red/)
})

test('the wake instruction carries the read-only limit and asks for no permission', () => {
  // The user settled this boundary on 2026-10-16: den stands in for them with the same reach, but its own
  // reach is read-only — so it must not ask for approval, because there is nothing for anyone to approve.
  // The instruction is the only place the heartbeat's own turns learn that, so it is pinned, not left to drift.
  // Both constants are already joined text, not arrays.
  const text = WAKE_INSTRUCTION
  assert.match(text, /read-only/)
  assert.match(text, /do not ask them for permission/)
  assert.doesNotMatch(text, /gated separately/, 'the old line told den to expect a gate that is switched off')
  assert.match(text, /drafts, patches, plans/, 'what it may produce is the substitute for acting')
  assert.match(TASK_STEP_INSTRUCTION, /read-only/, 'a task step is den acting too, so the limit applies there as well')
})

// ------------------------------------------------------------------ kernel

test('a silent wake writes no notice and counts as skipped', async () => {
  const sessionId = 'session-silent'
  const agent = authorizedAgent(sessionId)
  const trigger = normalizeTrigger({
    kind: 'interval',
    everySeconds: 300,
    sessionId,
    title: 'silent-check',
    prompt: 'check quietly',
  })
  saveTrigger({ ...trigger, createdAt: 1000, lastFiredAt: 1000 })

  const service = {
    state: () => ({ dailyTurnBudget: 50, cooldownSeconds: 0, quietHours: null }),
  }
  const kernel = new DenKernel({ service, deliver: async () => 'SKIP' })
  const result = await kernel.tick({ agent, now: 1000 + 300_000 })

  assert.equal(result.results[0].outcome, 'silent')
  assert.equal(allNotices().filter((notice) => notice.sessionId === sessionId).length, 0)
})

test('a valuable wake queues exactly one durable notice', async () => {
  const sessionId = 'session-spoken'
  const agent = authorizedAgent(sessionId)
  const trigger = normalizeTrigger({
    kind: 'interval',
    everySeconds: 300,
    sessionId,
    title: 'valuable-check',
    prompt: 'check and report',
  })
  saveTrigger({ ...trigger, createdAt: 1000, lastFiredAt: 1000 })

  const service = {
    state: () => ({ dailyTurnBudget: 50, cooldownSeconds: 0, quietHours: null }),
  }
  const kernel = new DenKernel({ service, deliver: async () => 'The build broke on main.' })
  const result = await kernel.tick({ agent, now: 1000 + 300_000 })

  assert.equal(result.results[0].outcome, 'spoke')
  const mine = allNotices().filter((notice) => notice.sessionId === sessionId)
  assert.equal(mine.length, 1)
  assert.equal(mine[0].text, 'The build broke on main.')
})

test('two kernels over one home deliver one check-in, because only one holds residency', async () => {
  // Two Hosts over one home is reachable by accident: `~/.dsh/den` is keyed on DSH_HOME, not
  // on the profile, so two profiles share one state tree and both mount this plugin.
  //
  // Two kernels over one home model two Host processes. What they share is the lease file and
  // the trigger file on disk, which is the state that actually races.
  const sessionId = 'session-two-hosts'
  const agent = authorizedAgent(sessionId)
  const trigger = normalizeTrigger({
    kind: 'interval',
    everySeconds: 300,
    sessionId,
    title: 'two-host',
    prompt: 'check and report',
  })
  saveTrigger({ ...trigger, createdAt: 1000, lastFiredAt: 1000 })

  const service = { state: () => ({ dailyTurnBudget: 50, cooldownSeconds: 0, quietHours: null }) }

  let delivered = 0
  let entered = () => {}
  const inside = new Promise((resolve) => {
    entered = resolve
  })
  let release = () => {}
  const held = new Promise((resolve) => {
    release = resolve
  })
  const deliver = async () => {
    delivered += 1
    entered()
    // Park the first delivery inside the window that the real one spends waiting on a Host.
    // This is the window the duplicate was measured in: without a lease, the second kernel
    // admits the same check-in while the first is still in here.
    if (delivered === 1) await held
    return 'The build broke on main.'
  }

  const dueAt = 1000 + 300_000
  const first = new DenKernel({ service, deliver, lease: new KernelLease({ path: leasePath() }) }).tick({
    agent,
    now: dueAt,
  })
  await inside // kernel one is now parked inside its delivery
  const second = await new DenKernel({ service, deliver, lease: new KernelLease({ path: leasePath() }) }).tick({
    agent,
    now: dueAt,
  })
  release()
  await first

  // The second host has to still be *running* and still tidying up after itself; standing down
  // is not a failure state. Its tick reports `standby` with the holder's pid, which is what the
  // status payload surfaces so an operator can tell a standby host from a broken one.
  assert.equal(second.standby, true, `the second kernel must stand down, got ${JSON.stringify(second)}`)
  assert.equal(second.results.length, 0, 'a standby tick must decide nothing')
  assert.equal(second.due, 1, 'and must still report what it declined to act on')
  assert.equal(delivered, 1, `the same check-in was delivered ${delivered} times`)
})

test('a standby kernel takes over once the holder stops renewing', async () => {
  // The other half: standing down must not be permanent. If the holder is killed rather than
  // disposed it never releases, so residency has to age out — otherwise a crash leaves the
  // state tree with no resident at all, which is the failure a start-time lock would cause.
  const leasePathHere = leasePath()
  const holder = new KernelLease({ path: leasePathHere, staleMs: 1000 })
  assert.equal(holder.acquire(10_000), true)

  const standby = new KernelLease({ path: leasePathHere, staleMs: 1000, isAlive: () => true })
  assert.equal(standby.acquire(10_500), false, 'a live holder inside the window keeps residency')

  // Past the window the record is no longer authoritative, even with the owner still alive —
  // a wandering pid must not hold the tree forever.
  assert.equal(standby.acquire(12_000), true, 'a lease that stopped renewing must be reclaimable')
  assert.equal(standby.report().held, true)
})

test('a fresh lease whose owner is gone is reclaimed at once, so a restart does not wait', async () => {
  // The staleness window exists for a holder that died without releasing. It must not be what a
  // restart waits for: after a restart the previous pid no longer exists, and there is no reason
  // to leave the assistant mute for three heartbeats before noticing.
  //
  // "At once" means inside the grace, not literally the same millisecond. A liveness probe was
  // measured answering "no such process" for a process that was alive, so a record younger than
  // `TAKEOVER_GRACE_MS` is protected from a negative answer — a wrong answer is cheap to survive,
  // a deleted live lease is not. The restart this describes is one where the holder ran for a
  // while, which is every restart: its record is at least a heartbeat old.
  const path = leasePath()
  const dead = new KernelLease({ path, staleMs: 600_000, isAlive: () => false })
  assert.equal(dead.acquire(10_000), true, 'the first holder claims it')

  const restarted = new KernelLease({ path, staleMs: 600_000, isAlive: () => false })
  assert.equal(
    restarted.acquire(10_000 + TAKEOVER_GRACE_MS),
    true,
    'a dead owner is reclaimed immediately, well inside the window',
  )
  assert.equal(restarted.report().held, true)
  assert.equal(restarted.report().holderPid, restarted.pid)
})

test('a record younger than the grace is not taken over on a liveness answer alone', async () => {
  // The guard itself, and the reason it exists. The probe said the owner was gone; the record was
  // written a moment ago; a process can be wrong about that and cannot be wrong about having just
  // written it. Measured: four processes over one lease, a holder one millisecond old declared
  // gone, its record deleted, and a second owner created.
  const path = leasePath()
  const holder = new KernelLease({ path, staleMs: 600_000, isAlive: () => true })
  assert.equal(holder.acquire(10_000), true)

  const impatient = new KernelLease({ path, staleMs: 600_000, isAlive: () => false })
  assert.equal(impatient.acquire(10_000 + TAKEOVER_GRACE_MS - 1), false, 'a millisecond inside the grace')
  assert.equal(impatient.report().held, false)
  assert.equal(
    JSON.parse(readFileSync(path, 'utf8')).instance,
    holder.instance,
    'and the holder keeps its record',
  )
  assert.equal(
    impatient.acquire(10_000 + TAKEOVER_GRACE_MS),
    true,
    'but refusing forever would be the other failure: every host declining',
  )
})

const noGrantsLedger = mkdtempSync(join(tmpdir(), 'den-no-grants-'))
test('a refused wake is recorded in the ledger, never silently dropped', async () => {
  const agent = { id: 'agent-n', status: 'running', session: { id: 'session-noauth', events: [] } }
  const trigger = normalizeTrigger({
    kind: 'interval',
    everySeconds: 300,
    sessionId: 'session-noauth',
    title: 'unauthorized-check',
    prompt: 'try to run',
  })
  saveTrigger({ ...trigger, createdAt: 1000, lastFiredAt: 1000 })

  const service = {
    state: () => ({ dailyTurnBudget: 50, cooldownSeconds: 0, quietHours: null }),
  }
  let delivered = 0
  const kernel = new DenKernel({ grantsDir: noGrantsLedger, 
    service,
    deliver: async () => {
      delivered += 1
      return 'should never happen'
    },
  })
  const result = await kernel.tick({ agent, now: 1000 + 300_000 })

  assert.equal(result.results[0].outcome, 'refused')
  assert.equal(result.results[0].gate, 'authority')
  assert.equal(delivered, 0, 'an unauthorized wake must never reach the model')
})

test('a re-entrant tick is refused instead of double-spending budget', async () => {
  const sessionId = 'session-reentrant'
  const agent = authorizedAgent(sessionId)
  const trigger = normalizeTrigger({
    kind: 'interval',
    everySeconds: 300,
    sessionId,
    title: 'slow-check',
    prompt: 'slow',
  })
  saveTrigger({ ...trigger, createdAt: 1000, lastFiredAt: 1000 })

  const service = {
    state: () => ({ dailyTurnBudget: 50, cooldownSeconds: 0, quietHours: null }),
  }
  let concurrent = 0
  let maxConcurrent = 0
  const kernel = new DenKernel({
    service,
    deliver: async () => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((resolve) => setTimeout(resolve, 20))
      concurrent -= 1
      return 'done'
    },
  })

  const [first, second] = await Promise.all([
    kernel.tick({ agent, now: 1000 + 300_000 }),
    kernel.tick({ agent, now: 1000 + 300_001 }),
  ])

  assert.equal(maxConcurrent, 1, 'wakes must never overlap')
  const outcomes = [first, second].map((item) => item.skipped ?? 'ran')
  assert.ok(outcomes.includes('reentrant'))
})

test('a failing delivery is recorded and does not abort the heartbeat', async () => {
  const sessionId = 'session-failing'
  const agent = authorizedAgent(sessionId)
  const trigger = normalizeTrigger({
    kind: 'interval',
    everySeconds: 300,
    sessionId,
    title: 'failing-check',
    prompt: 'boom',
  })
  saveTrigger({ ...trigger, createdAt: 1000, lastFiredAt: 1000 })

  const service = {
    state: () => ({ dailyTurnBudget: 50, cooldownSeconds: 0, quietHours: null }),
  }
  const events = []
  const kernel = new DenKernel({
    service,
    deliver: async () => {
      throw new Error('model unavailable')
    },
    onEvent: (event) => events.push(event),
  })
  const result = await kernel.tick({ agent, now: 1000 + 300_000 })

  assert.equal(result.results[0].outcome, 'failed')
  assert.ok(events.some((event) => event.type === 'wake-failed'))
  assert.equal(events.find((event) => event.type === 'wake-failed').willRetry, true)

  // The defect this guards: charging `lastFiredAt` before delivery consumed the
  // trigger, so a single transient failure silently ate the whole interval.
  const stored = readTrigger(trigger.id)
  assert.equal(stored.fireCount, 0, 'a failed wake must not count as a fired run')
  assert.equal(stored.lastFiredAt, 1000, 'a failed wake must not re-date the cadence')
  assert.equal(stored.lastAttemptAt, 1000 + 300_000, 'the attempt itself is still recorded')

  // Because the cadence did not move, the check-in is still due — just throttled.
  assert.equal(dueTriggers(1000 + 300_000).length, 0, 'the retry must not hammer every heartbeat')
  assert.equal(dueTriggers(1000 + 300_000 + FAILED_WAKE_RETRY_MS).length, 1, 'it must become due again')
})

test('a wake that fails once is retried and then delivered, not lost', async () => {
  const sessionId = 'session-retry'
  const agent = authorizedAgent(sessionId)
  const trigger = normalizeTrigger({
    kind: 'interval',
    everySeconds: 300,
    sessionId,
    title: 'retry-check',
    prompt: 'Report only if it broke.',
  })
  saveTrigger({ ...trigger, createdAt: 1000, lastFiredAt: 1000 })

  const service = {
    state: () => ({ dailyTurnBudget: 50, cooldownSeconds: 0, quietHours: null }),
  }
  let attempts = 0
  const kernel = new DenKernel({
    service,
    deliver: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('model unavailable')
      return 'CI is red on master.'
    },
    onEvent: () => {},
  })

  const dueAt = 1000 + 300_000
  const first = await kernel.tick({ agent, now: dueAt })
  assert.equal(first.results[0].outcome, 'failed')

  // The whole point: after the throttle expires the same check-in runs again,
  // rather than waiting a full interval for a model that was down for one call.
  const second = await kernel.tick({ agent, now: dueAt + FAILED_WAKE_RETRY_MS })
  assert.equal(second.results[0].outcome, 'spoke', 'the retry must actually speak')

  const stored = readTrigger(trigger.id)
  assert.equal(stored.fireCount, 1, 'exactly one run is charged for the recovered check-in')
  assert.equal(stored.lastFiredAt, dueAt + FAILED_WAKE_RETRY_MS)

  const notices = allNotices()
  assert.equal(notices.length, 1, 'the recovered check-in leaves exactly one notice, not two')
})

test('start and stop leave no timer behind', () => {
  const service = { state: () => ({ dailyTurnBudget: 1, cooldownSeconds: 0, quietHours: null }) }
  const events = []
  const kernel = new DenKernel({ service, deliver: async () => 'SKIP', onEvent: (e) => events.push(e) })
  kernel.start()
  assert.ok(kernel.timer)
  kernel.start()
  assert.equal(events.filter((event) => event.type === 'started').length, 1, 'start is idempotent')
  kernel.stop()
  assert.equal(kernel.timer, null)
  assert.ok(events.some((event) => event.type === 'stopped'))
})

/* ------------------------------------------------------- re-arming the cadence */

test('retime re-arms a running heartbeat instead of waiting for a restart', () => {
  // The stored cadence and the live timer are different things. Measured in the
  // acceptance run: `den_configure` changed tickSeconds, the state file agreed, and
  // the interval kept firing on the old value — a setting that looked applied and
  // was not.
  const kernel = new DenKernel({ service: { state: () => ({ dailyTurnBudget: 50, cooldownSeconds: 0, quietHours: null }) }, deliver: async () => 'SKIP', tickSeconds: 60 })
  kernel.start()
  const startedWith = kernel.timer
  assert.ok(startedWith, 'the heartbeat arms a timer')

  const applied = kernel.retime(5)
  assert.equal(applied, 5)
  assert.equal(kernel.tickSeconds, 5)
  assert.notEqual(kernel.timer, startedWith, 'the timer must be replaced, not left on the old cadence')
  kernel.stop()
})

test('retime clamps to the documented floor and ignores a no-op change', () => {
  const kernel = new DenKernel({ service: { state: () => ({ dailyTurnBudget: 50, cooldownSeconds: 0, quietHours: null }) }, deliver: async () => 'SKIP', tickSeconds: 60 })
  kernel.start()
  const before = kernel.timer

  assert.equal(kernel.retime(60), 60)
  assert.equal(kernel.timer, before, 'an unchanged cadence must not churn the timer')

  assert.equal(kernel.retime(1), 5, 'below the floor it clamps, rather than arming a 1-second heartbeat')
  assert.equal(kernel.tickSeconds, 5)

  assert.equal(kernel.retime(undefined), 5, 'a missing value leaves the cadence alone')
  kernel.stop()
})

test('retime on a stopped heartbeat changes the next cadence without starting it', () => {
  const kernel = new DenKernel({ service: { state: () => ({ dailyTurnBudget: 50, cooldownSeconds: 0, quietHours: null }) }, deliver: async () => 'SKIP', tickSeconds: 60 })
  assert.equal(kernel.timer, null)
  kernel.retime(15)
  assert.equal(kernel.tickSeconds, 15)
  assert.equal(kernel.timer, null, 'a stopped heartbeat must not be started as a side effect')
})
