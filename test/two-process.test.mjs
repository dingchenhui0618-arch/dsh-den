/**
 * Residency across processes, because in-process it cannot be tested.
 *
 * The whole point of the lease is what two *processes* do over one home, and the branch that
 * decides it — `defaultIsAlive(pid)` — asks the operating system whether the recorded owner
 * exists. Inside one process both owners are `process.pid`, so the answer is a tautology: an
 * implementation that never checked the pid at all would pass every in-process test.
 *
 * These tests therefore spawn real children. `test/support/resident-child.mjs` is one Host; each
 * test runs two of them over one `DSH_HOME`, which is two profiles sharing one state tree — the
 * accident `~/.dsh/den` being keyed on `DSH_HOME` makes possible.
 *
 * Children report to a file rather than to a pipe, so nothing here depends on capturing a child's
 * output. They also *log* to a file, which is the same trick for the other direction: when a child
 * dies on the way up, the exit code alone says nothing and the reason was being discarded.
 */
import assert from 'node:assert/strict'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'

import { fileURLToPath } from 'node:url'

import { TAKEOVER_GRACE_MS } from '../src/resident.js'

const childScript = fileURLToPath(new URL('./support/resident-child.mjs', import.meta.url))
const sandboxHome = mkdtempSync(join(tmpdir(), 'dsh-den-two-process-'))
const SESSION_ID = 'session-two-process'

/**
 * A restart finds a record that has been there a while, not one written a millisecond ago.
 *
 * That distinction is now load-bearing: a liveness probe was measured answering "no such process"
 * for a process that was alive, so a *young* record is protected from a negative answer until it is
 * older than `TAKEOVER_GRACE_MS`. A test that kills a holder immediately after it claimed residency
 * would be testing a case no restart produces, and would be measuring the grace rather than
 * recovery.
 */
const pastTakeoverGrace = () => new Promise((resolve) => setTimeout(resolve, TAKEOVER_GRACE_MS + 200))

let children = []

test.beforeEach(() => {
  for (const sub of ['triggers', 'grants', 'ledger', 'notices']) {
    rmSync(join(sandboxHome, 'den', sub), { recursive: true, force: true })
  }
  rmSync(join(sandboxHome, 'den', 'pacing.json'), { force: true })
  rmSync(join(sandboxHome, 'den', 'kernel-lease.json'), { force: true })
  children = []
})

test.afterEach(() => {
  for (const child of children) {
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }
})

test.after(() => rmSync(sandboxHome, { recursive: true, force: true }))

/** Is this pid still running? The question the lease asks, asked from here. */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function spawnChild(mode, resultFile, flags = []) {
  // The child's own words go to a file, not to a pipe and no longer to the void: a piped stdio is
  // what the confined sandbox refuses, and `stdio: 'ignore'` threw away the explanation for exactly
  // the failure this fixture is prone to. Measured once as `child exited 2147483651` and nothing else.
  const logPath = `${resultFile}.log`
  const logFd = openSync(logPath, 'a')
  const child = spawn(process.execPath, [childScript, mode, resultFile, ...flags], {
    env: { ...process.env, DSH_HOME: sandboxHome, DEN_CHILD_SESSION: SESSION_ID },
    stdio: ['ignore', logFd, logFd],
  })
  closeSync(logFd)
  child.logPath = logPath
  children.push(child)
  // The listener goes on now, not when a test gets around to waiting. `exit` is emitted once, and
  // a listener attached after that never fires — so a test that asks late would hang instead of
  // failing, which is the worst way to find out. Measured while building the simultaneous-claim
  // test: four children released by one file exited inside the gap and three were waited on
  // forever. These call sites happen to attach before the child can exit; that is luck, not
  // correctness, so the fixture attaches at spawn and the helpers just read the result.
  child.exit = new Promise((resolve, reject) => {
    child.on('exit', (code, signal) => resolve({ code, signal }))
    child.on('error', reject)
  })
  child.exit.catch(() => {})
  return child
}

/** A child's last words, so a failure can say more than "exited 2147483651". */
function tailOf(logPath) {
  try {
    const text = readFileSync(logPath, 'utf8').trim()
    if (!text) return ' (the child wrote nothing to its log)'
    return ` — its log: ${text.split('\n').slice(-4).join(' | ')}`
  } catch {
    return ''
  }
}

const exited = (child) =>
  child.exit.then(({ code, signal }) => {
    if (code !== 0) throw new Error(`child exited ${code ?? signal}${tailOf(child.logPath)}`)
    return code
  })

/** Wait for a child that was killed rather than one that finished, so any exit code is fine. */
const stopped = (child) => child.exit.then(() => undefined)

/**
 * Wait for a file a child will write — and stop the instant that child stops.
 *
 * A child that died on the way up never writes its file, so polling to the deadline reports a missing
 * path and hides the exit code and output that explain it. That is not hypothetical: a full-suite run
 * failed with `timed out waiting for ...round-0-racer-2.json.ready` after thirty seconds while the
 * child's stderr held the reason. The race test pins this contract deterministically; this is the
 * same wait, so a failure here carries the same information.
 */
async function waitForChildFile(child, path, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  const stoppedEarly = child.exit.then(
    ({ code, signal }) => {
      throw new Error(`child exited ${code ?? signal} before writing ${path}${tailOf(child.logPath)}`)
    },
    (error) => {
      throw error
    },
  )
  stoppedEarly.catch(() => {})
  while (!existsSync(path)) {
    await Promise.race([stoppedEarly, new Promise((resolve) => setTimeout(resolve, 25))])
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${path}${tailOf(child.logPath)}`)
    }
  }
}

const at = (dir, name) => join(dir, name)
const readResult = (path) => JSON.parse(readFileSync(path, 'utf8'))

test('a child that dies on the way up is reported with its exit code and its own output', async () => {
  // The other half of this fixture's honesty. These tests need real processes, so a real process can
  // fail to start - and `child exited 2147483651` on its own is not a diagnosis. Measured once in a
  // full-suite run, with the child's stderr discarded, and nothing anywhere said why.
  const file = at(sandboxHome, 'crash-report.json')
  const child = spawnChild('report', file, ['--crash'])
  const error = await exited(child).then(
    () => null,
    (rejection) => rejection,
  )
  assert.ok(error, 'a dead child must reject')
  assert.match(error.message, /child exited 3/, 'the exit code must be in the message')
  assert.match(error.message, /deliberate startup failure/, "and so must the child's own output")
  assert.equal(existsSync(file), false, 'and it really did die before writing anything')
})

test('waiting on a file a dead child will never write fails on the exit, not on the clock', async () => {
  // The same defect from the other side: this wait used to poll for thirty seconds and then report a
  // missing path, which is the least useful thing it could say.
  const file = at(sandboxHome, 'crash-hold.json')
  const child = spawnChild('hold', file, ['--crash'])
  const startedAt = Date.now()
  const error = await waitForChildFile(child, file).then(
    () => null,
    (rejection) => rejection,
  )
  const elapsed = Date.now() - startedAt

  assert.ok(error, 'a dead child must fail the wait')
  assert.match(error.message, /child exited 3/, 'the exit code must be in the message')
  assert.match(error.message, /deliberate startup failure/, "and so must the child's own output")
  assert.ok(elapsed < 10_000, `it must fail on the exit, not on the clock (took ${elapsed}ms)`)
})

test('a second real process takes residency once the first one has exited', async () => {
  const firstFile = at(sandboxHome, 'first.json')
  const first = spawnChild('report', firstFile)
  await exited(first)
  const firstReport = readResult(firstFile)
  assert.equal(firstReport.residency.held, true, 'the first process holds residency')
  assert.equal(firstReport.pid, firstReport.residency.pid)
  assert.equal(alive(firstReport.pid), false, 'and it is genuinely gone, or this proves nothing')
  await pastTakeoverGrace()

  // Same home, same lease file, left behind by a process that no longer exists.
  const secondFile = at(sandboxHome, 'second.json')
  const second = spawnChild('report', secondFile)
  await exited(second)
  const secondReport = readResult(secondFile)

  assert.equal(secondReport.residency.held, true, 'a dead owner must not block the tree')
  assert.notEqual(secondReport.pid, firstReport.pid, 'these are different processes')
  assert.equal(secondReport.residency.holderPid, secondReport.pid, 'and the survivor now holds it')
})

test('a real process stands down while another real process holds residency', async () => {
  const holderFile = at(sandboxHome, 'holder.json')
  const holder = spawnChild('hold', holderFile)
  await waitForChildFile(holder, holderFile)
  const holderReport = readResult(holderFile)
  assert.equal(holderReport.residency.held, true)
  assert.equal(alive(holderReport.pid), true, 'the holder has to still exist for this to mean anything')

  const otherFile = at(sandboxHome, 'other.json')
  const other = spawnChild('report', otherFile)
  await exited(other)
  const otherReport = readResult(otherFile)

  assert.equal(otherReport.residency.held, false, 'a live owner must keep residency')
  assert.equal(otherReport.residency.holderPid, holderReport.pid, 'and the standby host names it')
  assert.equal(otherReport.kernelRunning, true, 'standing down is not failing: the heartbeat still runs')

  holder.kill()
})

test('two real processes deliver one check-in, because only one holds residency', async () => {
  // The measurement that started this: with the first kernel parked inside its delivery, the
  // second admitted the same check-in and the conversation received it twice. This is that scene
  // with two operating-system processes instead of two objects, and with the lease in place.
  const firstFile = at(sandboxHome, 'parked.json')
  const first = spawnChild('tick', firstFile, ['--setup', '--park'])
  await waitForChildFile(first, `${firstFile}.parked`)
  // The holder's result is not written yet — it is parked inside the delivery, which is the
  // point — so the pid comes from the marker it dropped on the way in.
  const parkedPid = Number(readFileSync(`${firstFile}.parked`, 'utf8'))
  assert.equal(alive(parkedPid), true, 'the holder must still exist while it is parked')

  // The second process reads the same trigger file, with the same clock, while the first one is
  // still inside its delivery. Nothing about this is arranged in memory.
  const secondFile = at(sandboxHome, 'second-tick.json')
  const second = spawnChild('tick', secondFile)
  await exited(second)
  const secondReport = readResult(secondFile)

  assert.equal(secondReport.due, 1, 'the second process must see the same check-in due')
  assert.equal(secondReport.standby, true, 'and must stand down rather than deliver it')
  assert.equal(secondReport.holderPid, parkedPid, 'naming the process that holds residency')

  writeFileSync(`${firstFile}.go`, 'go')
  await exited(first)
  const firstReport = readResult(firstFile)
  assert.equal(firstReport.standby, false, 'the holder delivered, because it never stood down')

  const deliveries = readFileSync(`${firstFile}.deliveries`, 'utf8').trim().split('\n').filter(Boolean)
  assert.equal(deliveries.length, 1, `one check-in must be delivered once, not ${deliveries.length} times`)
})

test('a killed process leaves residency behind and the next one recovers it with nobody watching', async () => {
  // Cold recovery, the way it actually happens. The holder is killed rather than disposed, so
  // nothing releases the lease and nothing renews it — the file is simply left behind by a
  // process that no longer exists, which is what a crash or a forced restart looks like from the
  // next boot's side.
  //
  // This is also the case a start-time lock would get wrong: if residency were claimed once at
  // boot, this state tree would have no resident until a human noticed. The next process has to
  // take it over on its own, and then actually deliver.
  const holderFile = at(sandboxHome, 'killed.json')
  const holder = spawnChild('hold', holderFile)
  await waitForChildFile(holder, holderFile)
  const holderPid = readResult(holderFile).pid
  assert.equal(alive(holderPid), true, 'the holder was alive when it claimed residency')
  await pastTakeoverGrace()

  holder.kill()
  await stopped(holder)
  const deadline = Date.now() + 10_000
  while (alive(holderPid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(alive(holderPid), false, 'it has to be genuinely gone, or this tests nothing')
  assert.equal(existsSync(`${sandboxHome}/den/kernel-lease.json`), true, 'and its lease is still on disk')

  const recoverFile = at(sandboxHome, 'recovered.json')
  const recover = spawnChild('tick', recoverFile, ['--setup'])
  await exited(recover)
  const report = readResult(recoverFile)

  assert.equal(report.standby, false, 'a dead owner must not keep the survivor waiting')
  // `holderPid` on the tick result only exists on a standby tick — the kernel has no reason to
  // report a holder it is not deferring to. Who holds residency is the lease's answer.
  assert.equal(report.residency.held, true, 'the survivor holds residency now')
  assert.equal(report.residency.holderPid, report.pid, 'and it is the survivor that holds it')
  assert.equal(report.due, 1, 'and it found the check-in the dead process never fired')

  const deliveries = readFileSync(`${recoverFile}.deliveries`, 'utf8').trim().split('\n').filter(Boolean)
  assert.equal(deliveries.length, 1, 'which it delivered, with no human involved')
})
