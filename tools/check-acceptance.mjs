/**
 * Acceptance for the two reliability goals, run as one observable lifecycle.
 *
 *   Goal 1 — a deferred heartbeat self-heals. Inject a Host whose delivery path is
 *            absent at boot and appears later, then watch the real retry start the
 *            kernel. This is the case that previously left `kernel: null` forever.
 *   Goal 2 — boot persists state. A fresh home must end up with a real
 *            `state.json`, and a restart must preserve what the human configured.
 *
 * Both are driven through the real `apply()` and the real tools, on a throwaway
 * home, so the assertions are about files and return values rather than about a
 * mock's bookkeeping.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(ok, label, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
  if (!ok) failures += 1
}

const homes = []
function freshHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-den-accept-'))
  homes.push(home)
  return home
}

let serial = 0

/**
 * Bring the plugin up on a Host whose delivery path can appear late.
 *
 * `agents` is read through `ctx.get`, so the fixture has to dispatch through mutable
 * state — closing over the option makes a late arrival unobservable, and that mistake
 * made a harness bug look like a product bug earlier.
 *
 * This used to stand up `subagents`, because delivery went through
 * `subagents.sendMessage`. Delivery now goes through the resolved driver's own inbox
 * (`Agent.followup`), so `agents` is the service whose arrival the kernel waits for. A
 * fixture that still arranges `subagents` would be testing the plugin's ability to notice
 * a service it no longer consults.
 */
async function boot({ home, withAgents }) {
  process.env.DSH_HOME = home
  serial += 1
  const index = await import(`file:///D:/Projects/dsh-den/src/index.js?accept=${serial}`)

  const state = { provided: new Map(), tools: [], guards: [], routes: [], listeners: new Map() }
  const toolsApi = {
    register: (definition) => (state.tools.push(definition), () => {}),
    guard: (handler) => (state.guards.push(handler), () => {}),
  }
  const sent = []
  const agentFor = () => ({
    id: 'accept-agent',
    status: 'running',
    session: { id: 'accept-session', header: { id: 'accept-session' }, snapshotEvents: () => [] },
    followup: (message) => sent.push(message),
  })
  state.agents = withAgents
    ? { get: () => undefined, resume: async () => ({ agent: agentFor(), dispose: async () => {} }) }
    : null

  const ctx = {
    tools: toolsApi,
    agents: { get: () => undefined, currentInitiator: () => undefined, roots: () => [], resume: async () => ({ agent: { id: 'r' }, dispose: async () => {} }) },
    connection: { fetch: { register: (route) => (state.routes.push(route), () => {}) } },
    effect: (fn) => fn(),
    provide: (key, value) => (state.provided.set(key, value), () => state.provided.delete(key)),
    get(key) {
      if (key === 'agents') return state.agents
      if (key === 'tools') return toolsApi
      if (key === 'connection') return ctx.connection
      return undefined
    },
    on: (event, handler) => (state.listeners.set(event, handler), () => state.listeners.delete(event)),
  }

  index.apply(ctx)
  const service = state.provided.get('den')
  const tool = (name) => state.tools.find((entry) => entry.name === name)
  return { index, state, service, tool, ctx }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ------------------------------------------------- Goal 2: boot persists state */

console.log('\n=== GOAL 2 — boot persists state ===')
{
  const home = freshHome()
  const den = join(home, 'den')
  check(!existsSync(den), 'the home starts empty', den)

  const first = await boot({ home, withSubagents: true })

  const afterBoot = await first.tool('den_status').execute({})
  check(existsSync(join(den, 'state.json')), 'booting writes state.json', join(den, 'state.json'))
  check(afterBoot.stateSurvivesRestart === true, 'status reports that state survives a restart')
  const stored = JSON.parse(readFileSync(join(den, 'state.json'), 'utf8'))
  check(typeof stored.dailyTurnBudget === 'number', 'the stored state carries the budget', `dailyTurnBudget=${stored.dailyTurnBudget}`)
  check(typeof stored.tickSeconds === 'number', 'the stored state carries the cadence', `tickSeconds=${stored.tickSeconds}`)
  check(stored.version >= 1, 'the stored state is versioned for future migrations', `version=${stored.version}`)

  // The human changes something, then the process restarts.
  await first.tool('den_configure').execute({ dailyTurnBudget: 7, tickSeconds: 120, quietHours: { from: '23:30', to: '06:15' } })

  const second = await boot({ home, withSubagents: true })
  const afterRestart = await second.tool('den_status').execute({})
  check(afterRestart.dailyTurnBudget === 7, 'a restart preserves the daily budget', `dailyTurnBudget=${afterRestart.dailyTurnBudget}`)
  check(afterRestart.tickSeconds === 120, 'a restart preserves the heartbeat cadence', `tickSeconds=${afterRestart.tickSeconds}`)
  check(
    JSON.stringify(afterRestart.quietHours) === JSON.stringify({ from: 23 * 60 + 30, to: 6 * 60 + 15 }),
    'a restart preserves quiet hours',
    JSON.stringify(afterRestart.quietHours),
  )
}

/* ------------------------------------------- Goal 1: the heartbeat self-heals */

console.log('\n=== GOAL 1 — a deferred heartbeat self-heals ===')
{
  const home = freshHome()
  const deferred = await boot({ home, withAgents: false })

  const atBoot = await deferred.tool('den_status').execute({})
  check(atBoot.kernel === null, 'no delivery path means no heartbeat yet')
  check(atBoot.kernelDeferred !== null, 'and the deferral is reported by status, not just logged')
  check(atBoot.kernelDeferred.retrying === true, 'and it says it is still trying')
  check(
    deferred.service.recentEvents.some((event) => event.type === 'kernel-deferred'),
    'the deferral is recorded as an event too',
  )

  // The delivery path arrives, as it does when profile load order differs.
  deferred.state.agents = {
    get: () => undefined,
    resume: async () => ({
      agent: {
        id: 'accept-agent',
        status: 'running',
        session: { id: 'accept-session', header: { id: 'accept-session' }, snapshotEvents: () => [] },
        followup: () => {},
      },
      dispose: async () => {},
    }),
  }
  await wait(6500)

  const afterArrival = await deferred.tool('den_status').execute({})
  check(afterArrival.kernel?.running === true, 'the heartbeat starts on its own once delivery is possible')
  check(afterArrival.kernelDeferred === null, 'the deferred marker is cleared')
  check(
    deferred.service.recentEvents.some((event) => event.type === 'kernel-recovered'),
    'and the recovery is recorded so the gap is visible after the fact',
  )

  // The default cadence is 60s, which no acceptance run can wait for. Shortening it
  // through the real tool also proves the cadence change reaches the *running*
  // timer: the interval was armed once at construction, so a stored change that the
  // live timer ignored would look applied and not be.
  const retimed = await deferred.tool('den_configure').execute({ tickSeconds: 5 })
  check(retimed.ok === true && retimed.effective.tickSeconds === 5, 'the cadence can be shortened', JSON.stringify(retimed.effective?.tickSeconds))

  // Take a settled baseline first: comparing against a `null` lastTickAt would
  // "pass" on a single tick and prove nothing about progress.
  await wait(6000)
  const firstTick = (await deferred.tool('den_status').execute({})).kernel.lastTickAt
  check(typeof firstTick === 'number', 'the heartbeat has recorded a tick', `lastTickAt=${firstTick}`)

  await wait(7000)
  const later = await deferred.tool('den_status').execute({})
  check(
    typeof later.kernel.lastTickAt === 'number' && later.kernel.lastTickAt > firstTick,
    'the heartbeat is really ticking, not merely present',
    `${firstTick} -> ${later.kernel.lastTickAt} (+${later.kernel.lastTickAt - firstTick}ms)`,
  )
  check(later.kernel.lastError === null, 'and it is ticking without error')
  check(
    deferred.service.recentEvents.some((event) => event.type === 'retimed' && event.tickSeconds === 5),
    're-arming the live timer is recorded',
  )
}

/* ------------------------------------------------------------------- report */

for (const home of homes) rmSync(home, { recursive: true, force: true })
console.log('')
console.log(failures ? `FAIL — ${failures} acceptance check(s) failed` : 'PASS — every acceptance check')
process.exit(failures ? 1 : 0)
