/**
 * Round 4's chain, measured end to end without a host: another conversation ends a turn in an error, den
 * notices it on its own heartbeat, schedules a wake in **its own** conversation, and touches nothing in the
 * watched one.
 *
 * The pieces are the real ones: `DenService.scanSessions`, the real trigger store, and `dueTriggers`, which is
 * the exact function the kernel's heartbeat iterates to decide what to deliver. So the join between "den
 * noticed" and "den can wake itself about it" is a function boundary both halves actually share, rather than a
 * leap of narration.
 *
 * `DSH_HOME` is pointed at a temp tree **before** the service exists. `denHome()` reads the environment at call
 * time and the constructor captures it, so this is what keeps a test from writing `sessions-seen.json` and a
 * trigger into the machine's real den home.
 *
 * This file is deliberately ASCII-only. A PowerShell `Set-Content` round trip mangled the non-ASCII comments
 * here once already and silently ate a newline, which is exactly the failure the workspace rules warn about.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const home = mkdtempSync(join(tmpdir(), 'dsh-den-watch-chain-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home

const { DenService } = await import('../src/index.js')
const { dueTriggers } = await import('../src/triggers.js')
const { watcherSeenPath } = await import('../src/watcher.js')

const OTHER = 'other-session-id'
const DEN = 'den-own-session-id'
const LOG_DIR = join(home, 'sessions', '--C-Users-someone-project--', OTHER)
const LOG = join(LOG_DIR, 'session.v4.jsonl.zstd')

function frame(events) {
  return zstdCompressSync(Buffer.from(events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8'))
}

const asked = (text) => ({ type: 'user/message', time: 1, data: { content: [{ type: 'text', text }] } })
const fine = () => ({ type: 'turn/end', time: 2, data: { reason: { kind: 'completed' } } })
const failed = (message) => ({ type: 'turn/end', time: 3, data: { reason: { kind: 'error', error: { message } } } })

/** A service whose den home is the temp one, plus the conversation record this test wrote. */
function serviceForTest() {
  mkdirSync(join(home, 'den'), { recursive: true })
  const conversationPath = join(home, 'den', 'conversation.json')
  writeFileSync(
    conversationPath,
    JSON.stringify({
      sessionId: DEN,
      createdAt: 1,
      agentPreset: 'standard',
      cwd: home,
      cwdSource: 'den-home',
    }),
  )
  const service = new DenService({ effect: (fn) => fn() })
  return { service, conversationPath }
}

test('another conversation failing makes den schedule a wake in its own, unasked', () => {
  mkdirSync(LOG_DIR, { recursive: true })
  writeFileSync(LOG, frame([asked('please build it'), fine()]))
  const { service, conversationPath } = serviceForTest()

  // First sighting: a baseline. Nothing is read for it and nothing is scheduled, or den would report the whole
  // machine's history as news the moment it starts watching.
  const first = service.scanSessions({ now: 1000, conversationPath })
  assert.equal(first.watched, 1)
  assert.equal(first.adopted, 1)
  assert.deepEqual(first.attention, [])
  assert.deepEqual(dueTriggers(2000), [], 'a first sighting must not become a wake')

  // Now the other conversation really does fail.
  appendFileSync(LOG, frame([failed('prompt variable "{{cwd}}" has no value')]))
  const sizeAfterAppend = statSync(LOG).size
  const second = service.scanSessions({ now: 3000, conversationPath })
  assert.equal(second.attention.length, 1, 'a new error is attention')
  assert.equal(second.attention[0].sessionId, OTHER)

  // `dueTriggers` yields `{ trigger, dueAt }`, which is exactly how the kernel iterates it. Reading
  // `due[0].sessionId` reads `undefined` and then blames the wake.
  const due = dueTriggers(4000)
  assert.equal(due.length, 1, 'exactly one wake was scheduled, and nobody asked for it')
  const wake = due[0].trigger
  assert.equal(wake.sessionId, DEN, 'the wake belongs to the den conversation, not the watched one')
  assert.equal(wake.maxRuns, 1, 'one shot: a resident assistant that retries forever is a loop')
  assert.equal(wake.prompt.includes('{{cwd}}'), true, 'the wake carries the fact it was woken about')
  assert.match(wake.prompt, /Do not write into the other session/)
  assert.equal(wake.enabled, true)
  assert.equal(wake.maySpeak, true, 'a wake that may not speak accomplishes nothing')
  assert.equal(due[0].dueAt, 3000, 'and it is due at the instant it was created for')
  const summaryAfterSecond = service.watchSummary()

  // Non-intrusion, measured rather than promised: the scan read the log and changed nothing about it, not one
  // byte, and nothing at all was added to the directory the other session lives in.
  assert.equal(statSync(LOG).size, sizeAfterAppend, 'reading a log must not append to it')
  assert.deepEqual(readdirSync(LOG_DIR), ['session.v4.jsonl.zstd'], 'nothing was added to the watched session')

  // The same error does not wake den twice.
  const third = service.scanSessions({ now: 5000, conversationPath })
  assert.equal(third.attention.length, 0, 'already alerted is alerted')
  assert.equal(dueTriggers(6000).length, 1, 'still exactly the one wake')
  assert.equal(statSync(LOG).size, sizeAfterAppend, 'and the second scan wrote nothing either')

  // `watchSummary` is a method returning the state; a field of the same name used to shadow it, and the status
  // payload carried a function where JSON belonged. The summary describes the LAST scan, so the scan that
  // queued the wake is the one captured above, not the quiet one after it.
  assert.equal(typeof summaryAfterSecond, 'object')
  assert.equal(summaryAfterSecond.watched, 1)
  assert.equal(summaryAfterSecond.attention, 1)
  assert.equal(summaryAfterSecond.queued, 1)
  const summaryAfterThird = service.watchSummary()
  assert.equal(summaryAfterThird.attention, 0, 'the third scan saw nothing new')
  assert.equal(summaryAfterThird.queued, 0, 'and queued nothing, which is what "already alerted" means')

  // The scan state is real and durable, in the temp home.
  const seen = JSON.parse(String(readFileSync(watcherSeenPath(), 'utf8')))
  assert.equal(typeof seen.sessions[OTHER].size, 'number')
  assert.equal(typeof seen.alerted[`${OTHER}:${seen.sessions[OTHER].size}`], 'number')
})

test.after(() => {
  rmSync(home, { recursive: true, force: true })
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
})
