/**
 * The gate in front of every live probe: may this probe speak about this tree?
 *
 * The incident these tests encode is not a missing measurement. `check-deployment.mjs` had been
 * measuring staleness correctly for weeks — on 2026-10-13 it reported the host was running code
 * from before `client/client.js` was edited, while six separate `check:*` probes had just exited
 * 0 and been reported as live evidence. The measurement existed; it simply was not on the path a
 * single probe takes. So the tests below are about the *decision*, and the decision has to refuse
 * in two different ways that a careless reader would flatten into one.
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { judgeHostUsability } from '../tools/support/route-client.mjs'

const STALE = {
  known: true,
  stale: true,
  detail: 'client\\client.js was edited 2460s after this instance loaded, so this process is running older code',
}
const CURRENT = { known: true, stale: false, detail: "the newest edit to src/index.js is 240s older than this instance's start" }
const CANNOT_SAY = { known: false, stale: null, detail: 'this instance did not say when it loaded' }

test('an instance that says it is older than the tree is refused, and the file is named', () => {
  const verdict = judgeHostUsability(STALE)
  assert.equal(verdict.usable, false)
  assert.equal(verdict.code, 'stale')
  assert.match(verdict.reason, /client\\client\.js/)
})

test('an instance that cannot judge itself is refused too, under its own code', () => {
  // Not the same failure and not the same label: one is the instance telling you it is old, the
  // other is the instance being unable to tell. Both refuse, because only one answer is a pass.
  const verdict = judgeHostUsability(CANNOT_SAY)
  assert.equal(verdict.usable, false)
  assert.equal(verdict.code, 'cannot-say')
  assert.notEqual(verdict.code, 'stale', 'refusing for two different reasons is the point of the codes')
  assert.match(verdict.reason, /did not say when it loaded/)
})

test('an instance old enough to predate the field is refused as well', () => {
  // This is not hypothetical: it is what the live host reported while these tests were written.
  // A missing field is evidence of age, not an absence of evidence.
  const verdict = judgeHostUsability(undefined)
  assert.equal(verdict.usable, false)
  assert.equal(verdict.code, 'no-field')
  assert.match(verdict.reason, /predates the field/)
  assert.equal(judgeHostUsability(null).code, 'no-field')
})

test('only one of the four answers is a pass', () => {
  // Spelled out as a set, so a future branch that accidentally widens the gate fails here.
  const answers = [STALE, CURRENT, CANNOT_SAY, undefined]
  const usable = answers.filter((answer) => judgeHostUsability(answer).usable)
  assert.equal(usable.length, 1, 'exactly one payload is usable')
  assert.equal(judgeHostUsability(usable[0]).code, 'current')
})

test('a malformed verdict fails closed', () => {
  // `stale` truthy-but-not-true, and a missing `detail`, must not drift into a pass.
  assert.equal(judgeHostUsability({ known: true, stale: 'yes' }).usable, false)
  assert.equal(judgeHostUsability({ known: true }).usable, true, 'known and not stale is current')
  const noDetail = judgeHostUsability({ known: true, stale: false })
  assert.equal(noDetail.usable, true)
  assert.equal(noDetail.reason, 'no detail given', 'and it says so rather than inventing one')
})

/* ----------------------------- the guard as a process, not just a decision */

const GUARD = fileURLToPath(new URL('../tools/require-fresh-host.mjs', import.meta.url))

/**
 * Run the guard against a synthetic route that answers with `payload`.
 *
 * The point of doing this through a real socket and a real child process is that the pass path
 * has to be demonstrated. A gate that refuses everything is not a check — it is a gate that gets
 * turned off, and the discipline in this repository says a refusal needs a control or it can pass
 * for the wrong reason.
 */
function runGuard(payload) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, value: payload }))
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      // `spawn`, not `spawnSync`: this process is the fake host, and blocking the event loop here
      // means the fake host can never accept the connection the child is making. The first version
      // of this test did exactly that and waited out the guard's own timeout.
      const child = spawn(process.execPath, [GUARD, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.on('data', (chunk) => (out += chunk))
      child.stderr.on('data', (chunk) => (out += chunk))
      child.on('close', (code) => server.close(() => resolve({ code, out })))
    })
  })
}

test('the guard lets a fresh instance through, naming the newest edit it compared', async () => {
  const result = await runGuard({ startedAt: '2026-10-13T10:00:00.000Z', freshness: CURRENT })
  assert.equal(result.code, 0, `the guard must not block a current host:\n${result.out}`)
  assert.match(result.out, /the running instance loaded this tree/)
})

test('the guard stops the probe in front of a stale instance', async () => {
  const result = await runGuard({ startedAt: '2026-10-13T08:43:05.676Z', freshness: STALE })
  assert.equal(result.code, 1)
  assert.match(result.out, /cannot be probed about this tree \(stale\)/)
  assert.match(result.out, /restart DSH/)
})

test('nothing listening is a refusal, not a skip', async () => {
  // Port 9 is the discard port: connecting there is refused immediately on a normal machine.
  const child = spawnSync(process.execPath, [GUARD, '--port', '9'], { encoding: 'utf8', timeout: 20_000 })
  assert.equal(child.status, 1)
  assert.match(`${child.stdout}${child.stderr}`, /no host answered|route answered/)
})

/* ------------------------------------------- and the guard is actually in the path */

test('every live probe script is chained behind the guard', async () => {
  // The incident was not a missing measurement but a measurement missing from the path a single
  // probe takes. Chaining in `package.json` is what makes it inherited by every way of running a
  // probe, so this test pins the chaining rather than trusting the last person to add one.
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  // `drill-live-wake` is in here for the same reason as the probes: it asks a *running* host what
  // its ledger says and draws the project's last conclusion from the answer, so a stale instance
  // would let it certify a wake on code that is not on disk.
  const LIVE = /tools\/(check-live-[\w-]+|check-tools-live|check-wake-api|drill-live-wake)\.mjs/
  const guarded = []
  const unguarded = []
  for (const [name, command] of Object.entries(pkg.scripts)) {
    if (!LIVE.test(command)) continue
    ;(command.startsWith('node tools/require-fresh-host.mjs && ') ? guarded : unguarded).push(name)
  }
  assert.ok(guarded.length >= 5, `found the live probes to check (${guarded.length})`)
  assert.deepEqual(
    unguarded,
    [],
    'chain the probe behind `node tools/require-fresh-host.mjs &&`, or its passes describe whatever is listening',
  )
  // `check:deployment` is exempt on purpose: it *is* the measurement, and it must still be able to
  // report a stale host rather than refuse to talk about one.
  assert.ok(pkg.scripts['check:deployment'].startsWith('node tools/check-deployment.mjs'))
})
