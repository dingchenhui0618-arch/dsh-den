/**
 * The instant two Hosts claim the same lease at the same time.
 *
 * Capability 2 rested on one sentence: create-if-absent is the mutual exclusion, so two hosts
 * reclaiming at the same instant both reach `openSync(path, 'wx')` and exactly one wins. That was
 * an argument from the semantics of `wx`, and it had never been measured between processes. The
 * existing cross-process tests cannot measure it either: they arrange for one process to be
 * parked inside a delivery before the other starts, which is the *sequential* case. A lease
 * implemented as "check whether the file exists, then write it" passes every one of them.
 *
 * So this puts four real processes inside `acquire` in the same instant. Each one builds its lease
 * and announces readiness; the parent then writes a single shared `go` file; each child is spinning
 * on that file with `existsSync`, which costs microseconds. Spawn order and process startup —
 * hundreds of milliseconds of variation, and enough to hide a non-atomic claim — are spent before
 * the gun, not after it.
 *
 * What it can and cannot say: it measures that exactly one of four got in, over several rounds, on
 * this machine. It is not a proof of atomicity on every filesystem. It is a measurement of the
 * claim the source already makes.
 */
import assert from 'node:assert/strict'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'

import { fileURLToPath } from 'node:url'

const childScript = fileURLToPath(new URL('./support/resident-child.mjs', import.meta.url))
const sandboxHome = mkdtempSync(join(tmpdir(), 'dsh-den-race-'))
const LEASE = join(sandboxHome, 'den', 'kernel-lease.json')
const RACERS = 4
const ROUNDS = 4

let children = []

test.afterEach(() => {
  for (const child of children) {
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }
  children = []
})

test.after(() => rmSync(sandboxHome, { recursive: true, force: true }))

/**
 * Start one racer and listen for its exit **now**.
 *
 * The listener is attached at spawn rather than when the test gets around to waiting, and that is
 * not tidiness. `exit` is emitted once: a listener attached after that never fires, so the await
 * hangs forever instead of failing. Four racers released by one file exit within milliseconds of
 * each other, so attaching the listeners one at a time inside the await loop loses three of them
 * — which is exactly what the first version of this test did, and it hung rather than failing.
 *
 * The no-op catch is for the same reason: a promise that rejects before anyone awaits it is an
 * unhandled rejection, and the runner treats that as a crash. The assertion still sees it.
 *
 * The child's own output goes to a **file**, not to a pipe and no longer to the void. `stdio:
 * 'ignore'` was discarding the only evidence there is when a racer dies on the way up, and a piped
 * stdio is what the confined sandbox refuses; a file redirect is neither.
 */
function spawnRacer(resultFile, goFile, extraEnv = {}) {
  const logPath = `${resultFile}.log`
  const logFd = openSync(logPath, 'a')
  const child = spawn(process.execPath, [childScript, 'race', resultFile, `--go=${goFile}`], {
    env: { ...process.env, DSH_HOME: sandboxHome, ...extraEnv },
    stdio: ['ignore', logFd, logFd],
  })
  closeSync(logFd)
  children.push(child)

  const done = new Promise((resolve, reject) => {
    child.on('exit', (code) =>
      code === 0 ? resolve(code) : reject(new Error(`racer exited ${code}${tailOf(logPath)}`)),
    )
    child.on('error', reject)
  })
  done.catch(() => {})
  return { child, done }
}

/** A child's last words, so a failure can say more than "exited 3". */
function tailOf(logPath) {
  try {
    const text = readFileSync(logPath, 'utf8').trim()
    if (!text) return ' (the racer wrote nothing to its log)'
    return ` — its log: ${text.split('\n').slice(-4).join(' | ')}`
  } catch {
    return ''
  }
}

/**
 * Wait until every racer has announced readiness — and stop the instant one of them stops.
 *
 * Readiness is announced *before* the racer enters its spin, so a `.ready` file that never appears
 * means the process died on the way up, not that it is busy. Waiting out thirty seconds on a
 * process that is already gone reports a missing file and hides the exit code that explains it.
 * A `.ready` file that exists but never becomes readable, or a racer that exits 0 without
 * announcing, are both failures too — this waits for readiness, not for the clock.
 */
async function waitForReady(files, racers, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  const stopped = Promise.race(
    racers.map((racer, index) =>
      racer.done.then(
        () => {
          throw new Error(`racer ${index} exited cleanly without ever announcing readiness`)
        },
        (error) => {
          throw error
        },
      ),
    ),
  )
  stopped.catch(() => {})

  while (files.some((file) => !existsSync(`${file}.ready`))) {
    await Promise.race([stopped, new Promise((resolve) => setTimeout(resolve, 20))])
    if (Date.now() > deadline) {
      const missing = files.filter((file) => !existsSync(`${file}.ready`))
      throw new Error(
        `timed out waiting for ${missing.length} of ${files.length} racer(s): ` +
          `${missing.map((file) => `${file}.ready`).join(', ')}${tailOf(`${missing[0]}.log`)}`,
      )
    }
  }
}

test('four real processes released in the same instant produce exactly one owner', async () => {
  const winners = []

  for (let round = 0; round < ROUNDS; round += 1) {
    // Every round starts from no lease at all, which is the state that matters: with a lease
    // already on disk the losers would mostly stand down on freshness, and the atomic create —
    // the thing being measured — would never be the deciding step.
    rmSync(LEASE, { force: true })
    const goFile = join(sandboxHome, `go-${round}`)
    rmSync(goFile, { force: true })

    const files = []
    const racers = []
    for (let index = 0; index < RACERS; index += 1) {
      const resultFile = join(sandboxHome, `round-${round}-racer-${index}.json`)
      rmSync(resultFile, { force: true })
      rmSync(`${resultFile}.ready`, { force: true })
      files.push(resultFile)
      racers.push(spawnRacer(resultFile, goFile))
    }

    // Wait for every racer to be built and idle before releasing them. Starting the round while
    // one is still importing would stagger the attempts and quietly turn this into the
    // sequential test that already exists.
    await waitForReady(files, racers)
    writeFileSync(goFile, 'go')

    await Promise.all(racers.map((racer) => racer.done))

    const reports = files.map((file) => JSON.parse(readFileSync(file, 'utf8')))
    assert.equal(reports.length, RACERS, 'every racer must report, or a crash would look like a loser')

    const owners = reports.filter((report) => report.held === true)
    const standers = reports.filter((report) => report.held === false)

    assert.equal(
      owners.length,
      1,
      `round ${round}: ${owners.length} processes believed they owned the lease\n    ${reports
        .map((report) => JSON.stringify(report))
        .join('\n    ')}`,
    )
    assert.equal(standers.length, RACERS - 1, `round ${round}: the rest must stand down`)
    // Standing down has to be a decision, not a failure. The lease fails *open* on an unwritable
    // home, so a racer that could not write at all would report `held: true` — the opposite
    // mistake — and one that errored would carry a `lastError`. Both are excluded here.
    for (const report of reports) {
      assert.equal(report.lastError, null, `round ${round}: pid ${report.pid} hit ${report.lastError}`)
    }

    // And the single owner is the one whose record is actually on disk. Without this the test
    // would accept four processes that agreed they owned it while the file said something else.
    const onDisk = JSON.parse(readFileSync(LEASE, 'utf8'))
    assert.equal(onDisk.pid, owners[0].pid, `round ${round}: the lease on disk names the owner`)
    assert.equal(onDisk.instance, owners[0].instance, `round ${round}: and it is that process's claim`)
    winners.push(owners[0].pid)
  }

  // Four rounds is four separate starting guns. The winner legitimately can repeat, so this only
  // records that every round produced one — the per-round assertions are the real ones.
  assert.equal(winners.length, ROUNDS)
})

test('four real processes reclaiming one expired lease produce exactly one owner', async () => {
  // The other half, and the half that does not depend on a liveness answer at all.
  //
  // A restart finds a record from a holder that is gone. Taking it over means deleting that record
  // and creating a new one — and a delete followed by a create is **not** mutual exclusion, however
  // atomic the create is: two hosts that judge the same record free both delete, and the second
  // delete removes the record the first host just created. Every one of them then believes it
  // created the lease, and every one delivers.
  //
  // This is measured with a record that is an hour past its staleness window, so no liveness probe
  // is consulted anywhere in it. Before the takeover claim existed this produced three owners from
  // four processes.
  for (let round = 0; round < 3; round += 1) {
    mkdirSync(join(sandboxHome, 'den'), { recursive: true })
    // Takeover markers are deliberately permanent (that is what stops a slow host acting on a record
    // it read before the takeover), so a round has to start from a clean slate or the second round
    // finds the first round's marker and every racer stands down.
    for (const name of readdirSync(join(sandboxHome, 'den'))) {
      if (name.startsWith('kernel-lease.json.reclaim-')) rmSync(join(sandboxHome, 'den', name), { force: true })
    }
    const staleSince = Date.now() - 3_600_000
    writeFileSync(
      LEASE,
      JSON.stringify({ version: 1, pid: 4, instance: 'a-holder-that-is-gone', startedAt: staleSince, renewedAt: staleSince }),
    )
    const goFile = join(sandboxHome, `stale-go-${round}`)
    rmSync(goFile, { force: true })

    const files = []
    const racers = []
    for (let index = 0; index < RACERS; index += 1) {
      const resultFile = join(sandboxHome, `stale-${round}-racer-${index}.json`)
      rmSync(resultFile, { force: true })
      rmSync(`${resultFile}.ready`, { force: true })
      files.push(resultFile)
      racers.push(spawnRacer(resultFile, goFile))
    }

    await waitForReady(files, racers)
    writeFileSync(goFile, 'go')
    await Promise.all(racers.map((racer) => racer.done))

    const reports = files.map((file) => JSON.parse(readFileSync(file, 'utf8')))
    const owners = reports.filter((report) => report.held === true)
    assert.equal(
      owners.length,
      1,
      `round ${round}: ${owners.length} processes took over the same expired lease\n    ${reports
        .map((report) => JSON.stringify(report))
        .join('\n    ')}`,
    )
    const onDisk = JSON.parse(readFileSync(LEASE, 'utf8'))
    assert.equal(onDisk.pid, owners[0].pid, `round ${round}: the lease on disk names the taker`)
  }
})

test('a racer that dies before announcing readiness is reported at once, with its own words', async () => {
  // What this pins is a *diagnosis* failure, and it is one that was measured: a full-suite run failed
  // with "timed out waiting for ...round-0-racer-2.json.ready" after thirty seconds, while the child's
  // stderr - discarded by `stdio: 'ignore'` - held the reason. A suite whose rare failure says only
  // "something did not appear" cannot be debugged, and a race test whose failure mode is a mystery
  // gets deleted rather than fixed.
  //
  // Deterministic on purpose. The real flake needs a busy machine and shows up in roughly one full
  // run in six; this pins the same code path with a racer that dies on demand.
  const resultFile = join(sandboxHome, 'crash-racer.json')
  const goFile = join(sandboxHome, 'crash-go')
  rmSync(resultFile, { force: true })
  rmSync(`${resultFile}.ready`, { force: true })
  rmSync(`${resultFile}.log`, { force: true })

  const racer = spawnRacer(resultFile, goFile, { DEN_CHILD_CRASH: '1' })
  const startedAt = Date.now()
  const error = await waitForReady([resultFile], [racer]).then(
    () => null,
    (rejection) => rejection,
  )
  const elapsed = Date.now() - startedAt

  assert.ok(error, 'a racer that died must fail the wait rather than let it run out the clock')
  assert.match(error.message, /racer exited 3/, 'the exit code must be in the message')
  assert.match(error.message, /deliberate startup failure/, "and so must the child's own output")
  assert.ok(elapsed < 10_000, `it must fail on the exit, not on the clock (took ${elapsed}ms)`)
})
