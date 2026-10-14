/**
 * The drill's plumbing, exercised as a process against a synthetic host.
 *
 * `test/drill-live-wake.test.mjs` tests the verdict; this file tests everything around it —
 * that the frame is really written under `DSH_HOME`, that the route's envelope is really parsed,
 * that the exit codes are the ones a caller would script against, and that the drill refuses a
 * stale instance itself rather than only inheriting the guard's refusal.
 *
 * The reason to bother: the drill only runs in front of a human act, so its plumbing would
 * otherwise first execute during the one manual attempt this project gets. A tool whose untested
 * half is "the part that runs when a person is watching" is the worst half to leave untested.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const DRILL = fileURLToPath(new URL('../tools/drill-live-wake.mjs', import.meta.url))
const home = mkdtempSync(join(tmpdir(), 'dsh-den-drill-host-'))
const framePath = join(home, 'den', 'drill-frame.json')

test.after(() => rmSync(home, { recursive: true, force: true }))

const CURRENT = { known: true, stale: false, detail: 'the newest edit is older than this instance' }
const STALE = { known: true, stale: true, detail: 'client\\client.js was edited after this instance loaded' }

/** A status payload in the shape the route really returns, with the fields the drill reads. */
function statusPayload(overrides = {}) {
  return {
    startedAt: '2026-10-13T10:00:00.000Z',
    autonomy: true,
    autonomyKnown: true,
    kernel: { running: true, lastTickAt: 1791885000000 },
    residency: { held: true, pid: 1, staleMs: 180000 },
    triggers: { total: 1, invalid: 0, due: 0 },
    ledger: { turns: 0, spoken: 0, skipped: 0, refused: 0 },
    freshness: CURRENT,
    recentEvents: [],
    ...overrides,
  }
}

/**
 * Run one drill frame against a synthetic route answering `payload`.
 *
 * `spawn`, not `spawnSync`: this process *is* the fake host, and blocking the event loop here
 * means the fake host can never accept the connection the child is opening.
 */
function runFrame(args, payload) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, value: payload }))
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      const child = spawn(process.execPath, [DRILL, ...args, '--port', String(port)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, DSH_HOME: home },
      })
      let out = ''
      child.stdout.on('data', (chunk) => (out += chunk))
      child.stderr.on('data', (chunk) => (out += chunk))
      child.on('close', (code) => server.close(() => resolve({ code, out })))
    })
  })
}

test('frame one records what the host said, and states the trap before the human acts', async () => {
  const result = await runFrame(['--before'], statusPayload())
  assert.equal(result.code, 0, `frame one must succeed against a healthy host:\n${result.out}`)
  assert.match(result.out, /RESULT: ARMED/)

  const frame = JSON.parse(readFileSync(framePath, 'utf8'))
  assert.equal(frame.startedAt, '2026-10-13T10:00:00.000Z', 'the frame carries the instance it read')
  assert.equal(frame.turns, 0)
  assert.equal(frame.spoken, 0)
  assert.equal(frame.triggersTotal, 1)
  assert.ok(frame.at, 'and the moment it was taken, so the two frames can be told apart')

  // The step people miss, said before they act rather than after they wait: authority is a
  // permission, not a schedule.
  assert.match(result.out, /Authority alone wakes nothing/)
})

test('frame two passes on a delivered, spoken wake and fails on a silent one', async () => {
  await runFrame(['--before'], statusPayload())

  const spoke = await runFrame(['--after'], statusPayload({ ledger: { turns: 1, spoken: 1, skipped: 0, refused: 0 } }))
  assert.equal(spoke.code, 0, `a real wake must pass:\n${spoke.out}`)
  assert.match(spoke.out, /RESULT: PASS/)
  assert.match(spoke.out, /ledger\.turns/)

  // The control: the same host, the same moved turn, nothing said. It reads like a wake in every
  // log except the one that matters, so it has to fail — and fail by name.
  const silent = await runFrame(['--after'], statusPayload({ ledger: { turns: 1, spoken: 0, skipped: 1, refused: 0 } }))
  assert.equal(silent.code, 1, `a silent wake must not pass:\n${silent.out}`)
  assert.match(silent.out, /nothing was spoken/)
})

test('the drill refuses a stale instance itself, rather than only inheriting the guard', async () => {
  // The guard is chained in front of both frames in `package.json`; this asserts the drill would
  // also refuse on its own, because a tool used by hand (`node tools/drill-live-wake.mjs --after`)
  // must not be the way a verdict gets read off an instance running older code.
  const result = await runFrame(['--after'], statusPayload({ freshness: STALE }))
  assert.equal(result.code, 1)
  assert.match(result.out, /cannot be probed about this tree/)
  assert.match(result.out, /edited after this instance loaded/)
})
