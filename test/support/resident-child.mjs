/**
 * One real Host process, for the tests that cannot be honest in-process.
 *
 * Every other residency test models two Hosts with two kernel objects in one process. That model
 * cannot reach the branch the lease actually turns on in the field: `defaultIsAlive(pid)`, which
 * asks the operating system whether the recorded owner still exists. In one process both owners
 * are `process.pid`, so the check is a tautology and a broken implementation would still pass.
 *
 * So the fixture is a process. Modes:
 *
 *   report <file>            mount the plugin, record residency, exit. A process that stops.
 *   hold <file>              mount, record residency, stay alive. A process that does not.
 *   tick <file> [--setup]    build a kernel with a real lease, make one check-in due, tick once,
 *                            record what it decided, exit.
 *   tick <file> --park       as above, but deliver writes `parked` and then blocks until a `go`
 *                            file appears, which is the window a real delivery spends waiting on
 *                            a Host. Another process can only be told the same check-in is due
 *                            while this one is inside it.
 *   race <file> [--go=<f>]   build a lease over one home, announce readiness, then spin on the
 *                            shared `go` file and claim. Several of these started together is
 *                            the only way to see whether two processes can both believe they own
 *                            the same lease.
 *
 * The result is written to a file rather than piped: the tests run their children with
 * `stdio: 'ignore'` so the fixture never depends on capturing a child's output.
 */
import { existsSync, writeFileSync } from 'node:fs'

const [, , mode, resultFile, ...flags] = process.argv
const park = flags.includes('--park')
const setup = flags.includes('--setup')
// Shared on purpose where it matters: several racers have to be released by the same file at
// once, so `--go=` overrides the per-child default.
const goFlag = flags.find((flag) => flag.startsWith('--go='))
const goFile = goFlag ? goFlag.slice('--go='.length) : `${resultFile}.go`

// A child that dies on the way up, on purpose, in any mode. A parent cannot tell a dead child from a
// slow one by looking at the filesystem - readiness and results are files, so a file that never
// appears is all it sees - and this is what makes the parent's failure path testable instead of
// something that only ever shows up as a flake. It writes to stderr first, because the point is that
// the parent has to be able to show it.
if (flags.includes('--crash') || process.env.DEN_CHILD_CRASH === '1') {
  process.stderr.write('deliberate startup failure: this child dies before it does anything\n')
  process.exit(3)
}

const { apply } = await import('../../src/index.js')
const { fakeHost } = await import('./host.mjs')
const { writeJsonAtomic, digest, denPath } = await import('../../src/atom.js')
const { normalizeTrigger, saveTrigger } = await import('../../src/triggers.js')
const { DenKernel } = await import('../../src/kernel.js')
const { KernelLease, leasePath } = await import('../../src/resident.js')

const record = (value) => writeJsonAtomic(resultFile, value)

if (mode === 'report' || mode === 'hold') {
  const host = fakeHost()
  apply(host.ctx)
  const service = host.state.provided.get('den')
  const status = service.status()
  record({ pid: process.pid, residency: status.residency, kernelRunning: status.kernel?.running ?? null })
  if (mode === 'hold') setInterval(() => {}, 1000)
  else process.exit(0)
} else if (mode === 'tick') {
  const sessionId = process.env.DEN_CHILD_SESSION
  // The real clock, not a synthetic one. A synthetic `now` puts this process's lease timestamps
  // thousands of times away from the other process's real ones, so the record always reads as
  // stale and the pid-liveness branch is never reached — and that branch is the one these
  // processes exist to exercise. Real time keeps both on one clock, so freshness is decided by
  // whether the recorded owner is still alive, exactly as it is in the field.
  const now = Date.now()

  // The grant and the check-in are written by whichever process runs with `--setup`. Both
  // children then read the same files, which is what makes them two Hosts over one home rather
  // than two independent fixtures that happen to agree.
  if (setup) {
    const trigger = normalizeTrigger({
      kind: 'interval',
      everySeconds: 300,
      sessionId,
      title: 'cross-process check',
      prompt: 'report only failures',
    })
    saveTrigger({ ...trigger, createdAt: now - 3_600_000, lastFiredAt: now - 3_600_000 })
    writeJsonAtomic(denPath('grants', `${digest(sessionId)}.json`), {
      version: 1,
      sessionId,
      autonomy: true,
      humanMessageId: 'msg-child',
      humanSeq: 2,
      recordedAfterSeq: 2,
    })
  }

  const agent = {
    id: 'agent-child',
    status: 'running',
    session: {
      id: sessionId,
      events: [
        { seq: 1, type: 'turn/start' },
        { seq: 2, type: 'user/message', data: { id: 'msg-child', source: { kind: 'user' } } },
      ],
    },
  }

  const deliveries = `${resultFile}.deliveries`
  const service = { state: () => ({ dailyTurnBudget: 50, cooldownSeconds: 0, quietHours: null }) }
  const kernel = new DenKernel({
    service,
    lease: new KernelLease({ path: leasePath(), staleMs: 600_000 }),
    deliver: async () => {
      // Append, never truncate: the whole question is how many times this ran.
      writeFileSync(deliveries, 'delivered\n', { flag: 'a' })
      if (park) {
        // Carries the pid: the final result file is only written once the tick returns, and the
        // other process has to be started while this one is still inside the delivery.
        writeFileSync(`${resultFile}.parked`, String(process.pid))
        while (!existsSync(goFile)) {
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
      }
      return 'the cross-process check spoke'
    },
  })

  const result = await kernel.tick({ agent, now })
  record({
    pid: process.pid,
    standby: result.standby ?? false,
    due: result.due ?? null,
    holderPid: result.holderPid ?? null,
    residency: kernel.lease?.report() ?? null,
  })
  process.exit(0)
} else if (mode === 'race') {
  // The lease is built first and readiness is announced, so the imports and the directory
  // preparation are already paid for by the time the starting gun goes off. What is left in the
  // window is the claim itself.
  //
  // Spinning on the file rather than sleeping on a timer is the point. A timer, or simply the
  // order the parent spawned them in, spreads four attempts over milliseconds — wide enough that
  // a check-then-write implementation would usually get away with it, and the test would pass
  // while proving nothing about the instant. File polling costs microseconds, so all four are
  // inside `acquire` at once.
  const lease = new KernelLease({ path: leasePath(), staleMs: 600_000 })
  writeFileSync(`${resultFile}.ready`, String(process.pid))
  while (!existsSync(goFile)) {
    /* spin: the window has to be tight or this measures nothing */
  }
  const held = lease.acquire()
  record({
    pid: process.pid,
    held,
    instance: lease.instance,
    report: lease.report(),
    lastError: lease.lastError ?? null,
  })
  process.exit(0)
} else {
  record({ error: `unknown mode ${JSON.stringify(mode)}` })
  process.exit(2)
}
