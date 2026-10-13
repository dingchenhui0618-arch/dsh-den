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
 * Children are spawned with `stdio: 'ignore'` and report to a file, so nothing here depends on
 * capturing a child's output.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'

import { fileURLToPath } from 'node:url'

const childScript = fileURLToPath(new URL('./support/resident-child.mjs', import.meta.url))
const sandboxHome = mkdtempSync(join(tmpdir(), 'dsh-den-two-process-'))
const SESSION_ID = 'session-two-process'

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
  const child = spawn(process.execPath, [childScript, mode, resultFile, ...flags], {
    env: { ...process.env, DSH_HOME: sandboxHome, DEN_CHILD_SESSION: SESSION_ID },
    stdio: 'ignore',
  })
  children.push(child)
  return child
}

const exited = (child) =>
  new Promise((resolve, reject) => {
    child.on('exit', (code) => (code === 0 ? resolve(code) : reject(new Error(`child exited ${code}`))))
    child.on('error', reject)
  })

/** Wait for a child that was killed rather than one that finished, so any exit code is fine. */
const stopped = (child) =>
  new Promise((resolve, reject) => {
    child.on('exit', resolve)
    child.on('error', reject)
  })

async function waitForFile(path, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${path}`)
}

const at = (dir, name) => join(dir, name)
const readResult = (path) => JSON.parse(readFileSync(path, 'utf8'))

test('a second real process takes residency once the first one has exited', async () => {
  const firstFile = at(sandboxHome, 'first.json')
  const first = spawnChild('report', firstFile)
  await exited(first)
  const firstReport = readResult(firstFile)
  assert.equal(firstReport.residency.held, true, 'the first process holds residency')
  assert.equal(firstReport.pid, firstReport.residency.pid)
  assert.equal(alive(firstReport.pid), false, 'and it is genuinely gone, or this proves nothing')

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
  await waitForFile(holderFile)
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
  await waitForFile(`${firstFile}.parked`)
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
  await waitForFile(holderFile)
  const holderPid = readResult(holderFile).pid
  assert.equal(alive(holderPid), true, 'the holder was alive when it claimed residency')

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
