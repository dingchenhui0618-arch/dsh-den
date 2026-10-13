/**
 * Smoke tests for the durability and authority primitives.
 *
 * These run with the bundled Node and home-relative paths only; they never touch
 * the live DSH profile or the user's real `~/.dsh/den` state.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// Point every module at an isolated home before importing them.
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-den-test-'))
process.env.DSH_HOME = sandbox

const { denHome, digest, readJsonChecked, reapStaleTempFiles, writeJsonAtomic, publishIfAbsent, STALE_TEMP_MS } =
  await import('../src/atom.js')
const { currentGrant, hasAutonomy, isDirectHumanDriver, recordGrant } = await import('../src/grant.js')
const { NOTICE_TTL_MS, isExpired, noticeId, pendingNotices, queueNotice } = await import('../src/notices.js')

test.after(() => rmSync(sandbox, { recursive: true, force: true }))

test('state root is self-contained under the configured DSH home', () => {
  assert.equal(denHome(), join(sandbox, 'den'))
})

test('atomic write is readable and round-trips', () => {
  const path = join(sandbox, 'den', 'roundtrip.json')
  writeJsonAtomic(path, { hello: 'world', n: 1 })
  const result = readJsonChecked(path, (value) => value?.n === 1)
  assert.equal(result.ok, true)
  assert.equal(result.value.hello, 'world')
})

test('a corrupt record degrades to absent instead of throwing', () => {
  const path = join(sandbox, 'den', 'corrupt.json')
  writeJsonAtomic(path, { n: 1 })
  // Simulate bit rot.
  writeFileSync(path, '{ not json')
  const result = readJsonChecked(path, () => true)
  assert.equal(result.ok, false)
  assert.match(result.reason, /unparseable/)
})

test('publishIfAbsent never replaces an existing record', () => {
  const path = join(sandbox, 'den', 'once.json')
  assert.equal(publishIfAbsent(path, { generation: 1 }), true)
  assert.equal(publishIfAbsent(path, { generation: 2 }), false)
  assert.equal(readJsonChecked(path, () => true).value.generation, 1)
})

test('an abandoned temp file from a crash is reclaimed', () => {
  const directory = join(sandbox, 'den', 'reap')
  writeJsonAtomic(join(directory, 'keep.json'), { n: 1 })
  // A hard kill between open and rename leaves exactly this shape behind; the
  // measured rate was 39 of 40 kills, so it is the normal case, not the rare one.
  const abandoned = join(directory, 'state.json.deadbeef-0000.tmp')
  writeFileSync(abandoned, '{"partial":')
  const old = new Date(Date.now() - STALE_TEMP_MS - 60_000)
  utimesSync(abandoned, old, old)

  assert.equal(reapStaleTempFiles(directory), 1)
  assert.equal(readdirSync(directory).includes('state.json.deadbeef-0000.tmp'), false)
  // Housekeeping must never touch real records.
  assert.equal(readJsonChecked(join(directory, 'keep.json'), (v) => v?.n === 1).ok, true)
})

test('a temp file young enough to be an in-flight write is left alone', () => {
  const directory = join(sandbox, 'den', 'reap-young')
  writeJsonAtomic(join(directory, 'other.json'), { n: 1 })
  // Another process may be writing this file right now. Reaping it would break a
  // legitimate concurrent write, so the grace period is the safety property.
  const inFlight = join(directory, 'state.json.cafe-1111.tmp')
  writeFileSync(inFlight, '{"n":2}')

  assert.equal(reapStaleTempFiles(directory), 0)
  assert.equal(readdirSync(directory).includes('state.json.cafe-1111.tmp'), true)
})

test('the reaper only ever removes its own temp shapes', () => {
  const directory = join(sandbox, 'den', 'reap-shape')
  // Create the directory first: a missing one would make the write below throw
  // and the test would pass for the wrong reason.
  writeJsonAtomic(join(directory, 'seed.json'), { n: 0 })
  writeFileSync(join(directory, 'a-real-note.json'), '{}')
  writeFileSync(join(directory, 'notes.txt'), 'human file')
  const old = new Date(Date.now() - STALE_TEMP_MS - 60_000)
  for (const name of ['a-real-note.json', 'notes.txt']) utimesSync(join(directory, name), old, old)

  assert.equal(reapStaleTempFiles(directory), 0)
  assert.deepEqual(readdirSync(directory).sort(), ['a-real-note.json', 'notes.txt', 'seed.json'])
})

test('a completed write leaves no temp litter of its own', () => {
  const directory = join(sandbox, 'den', 'clean-write')
  for (let i = 0; i < 5; i += 1) writeJsonAtomic(join(directory, 'state.json'), { n: i })
  const strays = readdirSync(directory).filter((name) => name.endsWith('.tmp') || name.endsWith('.pending'))
  assert.deepEqual(strays, [])
  assert.equal(JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8')).n, 4)
})

test('identical notice content collapses to one record', () => {
  const first = queueNotice('session-a', '  build is green  ', 'notice')
  const second = queueNotice('session-a', 'build is green', 'notice')
  assert.equal(first.id, second.id)
  assert.equal(first.queued, true)
  assert.equal(second.queued, false)
})

test('observation notices expire but ideas do not', () => {
  const stale = { kind: 'notice', createdAt: Date.now() - NOTICE_TTL_MS - 1000 }
  const fresh = { kind: 'notice', createdAt: Date.now() }
  const idea = { kind: 'idea', createdAt: Date.now() - NOTICE_TTL_MS * 10 }
  assert.equal(isExpired(stale), true)
  assert.equal(isExpired(fresh), false)
  assert.equal(isExpired(idea), false)
})

test('expired notices are withheld from delivery but reported', () => {
  const session = 'session-expiry'
  const id = noticeId(session, 'notice', 'stale reminder')
  writeJsonAtomic(join(sandbox, 'den', 'notices', `${id}.json`), {
    version: 1,
    id,
    sessionId: session,
    kind: 'notice',
    text: 'stale reminder',
    createdAt: Date.now() - NOTICE_TTL_MS - 60_000,
  })
  queueNotice(session, 'still relevant', 'notice')
  const { deliverable, expired } = pendingNotices(session)
  assert.deepEqual(
    deliverable.map((notice) => notice.text),
    ['still relevant'],
  )
  assert.deepEqual(
    expired.map((notice) => notice.text),
    ['stale reminder'],
  )
})

/** Minimal stand-ins for the Host surface the grant module authenticates against. */
function fakeAgent({ status = 'running', events = [] } = {}) {
  return { id: 'agent-1', status, session: { id: 'session-1', events } }
}

function fakeCtx(agent) {
  return {
    agents: {
      get: (id) => (id === agent.id ? agent : undefined),
      currentInitiator: () => agent,
      roots: () => [agent],
    },
  }
}

function humanTurn(messageId) {
  return [
    { seq: 1, type: 'turn/start' },
    { seq: 2, type: 'user/message', data: { id: messageId, source: { kind: 'user' } } },
  ]
}

test('a verified human turn grants, and revocation always wins', () => {
  const agent = fakeAgent({ events: humanTurn('msg-1') })
  const ctx = fakeCtx(agent)

  // The host guarantees a live human turn is what invokes grant recording, so the
  // authenticated path is exercised here directly.
  assert.equal(isDirectHumanDriver(ctx, agent, 'msg-1'), true)
  recordGrant(ctx, agent, true, 'msg-1')
  assert.equal(currentGrant(agent), true)
  assert.equal(hasAutonomy(agent), true)

  recordGrant(ctx, agent, false, 'msg-1')
  assert.equal(currentGrant(agent), false)
  assert.equal(hasAutonomy(agent), false)
})

test('the token identifies the human message, so a caller need not know its id', () => {
  const token = `tok-${'a'.repeat(28)}`
  const turn = (text) => [
    { seq: 1, type: 'turn/start' },
    { seq: 2, type: 'user/message', data: { id: 'msg-1', source: { kind: 'user' }, text } },
  ]

  // A model driving a tool call has no reliable way to *know* the id of the message it is
  // answering, and requiring one made an otherwise complete flow impossible to finish. The
  // token stands in for the id, and the record still names the message it found.
  const agent = fakeAgent({ events: turn(`please grant — ${token}`) })
  const record = recordGrant(fakeCtx(agent), agent, true, '', { requireToken: token })
  assert.equal(record.humanMessageId, 'msg-1', 'the record must name the message the token was found in')
  assert.equal(currentGrant(agent), true)

  // A token nobody typed is not a grant. This is the entire second factor: the string is
  // random, only a human who read the panel can type it, and an agent cannot author a
  // `user/message` to put it in.
  const silent = fakeAgent({ events: turn('no token in this one') })
  assert.throws(
    () => recordGrant(fakeCtx(silent), silent, true, '', { requireToken: token }),
    /no human message in this turn carries the panel token/,
  )
})

test('a grant attempt with a message id absent from the log is refused', () => {
  const agent = fakeAgent({ events: humanTurn('msg-1') })
  assert.throws(
    () => recordGrant(fakeCtx(agent), agent, true, 'msg-does-not-exist'),
    { message: /direct human request/ },
  )
})

test('authority is undefined when no record exists, never implicitly true', () => {
  // No record has ever been written for this session id.
  const agent = { id: 'agent-3', status: 'running', session: { id: 'session-never-granted', events: [] } }
  assert.equal(currentGrant(agent), undefined)
  assert.equal(hasAutonomy(agent), false)
})

test('an unreadable or invalid record is treated as absent', () => {
  const sessionId = 'session-invalid-record'
  const agent = { id: 'agent-4', status: 'running', session: { id: sessionId, events: [] } }
  writeJsonAtomic(join(sandbox, 'den', 'grants', `${digest(sessionId)}.json`), {
    version: 99,
    sessionId,
    autonomy: true,
  })
  assert.equal(currentGrant(agent), undefined)
})

test('a record whose proof is missing degrades to false, not true', () => {
  const sessionId = 'session-proof'
  const agent = { id: 'agent-2', status: 'running', session: { id: sessionId, events: [] } }
  // Forge a record whose bound human message never existed in that session log.
  writeJsonAtomic(join(sandbox, 'den', 'grants', `${digest(sessionId)}.json`), {
    version: 1,
    sessionId,
    autonomy: true,
    humanMessageId: 'never-happened',
    humanSeq: 99,
    recordedAfterSeq: 99,
  })
  assert.equal(currentGrant(agent), false)
  assert.equal(hasAutonomy(agent), false)
})

test('a verified record still yields false once the human revokes it', () => {
  const sessionId = 'session-revoked'
  const messageId = 'msg-revoke'
  const events = [
    { seq: 1, type: 'turn/start' },
    { seq: 2, type: 'user/message', data: { id: messageId, source: { kind: 'user' } } },
  ]
  const agent = { id: 'agent-5', status: 'running', session: { id: sessionId, events } }
  writeJsonAtomic(join(sandbox, 'den', 'grants', `${digest(sessionId)}.json`), {
    version: 1,
    sessionId,
    autonomy: false,
    humanMessageId: messageId,
    humanSeq: 2,
    recordedAfterSeq: 2,
  })
  assert.equal(currentGrant(agent), false)
  assert.equal(hasAutonomy(agent), false)
})

test('a grant bound to a foreign message id is not authority', () => {
  const sessionId = 'session-foreign'
  const events = [
    { seq: 1, type: 'turn/start' },
    { seq: 2, type: 'user/message', data: { id: 'real-message', source: { kind: 'user' } } },
  ]
  const agent = { id: 'agent-6', status: 'running', session: { id: sessionId, events } }
  writeJsonAtomic(join(sandbox, 'den', 'grants', `${digest(sessionId)}.json`), {
    version: 1,
    sessionId,
    autonomy: true,
    humanMessageId: 'some-other-message',
    humanSeq: 2,
    recordedAfterSeq: 2,
  })
  assert.equal(currentGrant(agent), false)
})

test('a non-human source never authenticates as a human driver', () => {
  const events = [
    { seq: 1, type: 'turn/start' },
    { seq: 2, type: 'user/message', data: { id: 'auto-1', source: { kind: 'schedule' } } },
  ]
  const agent = { id: 'agent-7', status: 'running', session: { id: 'session-auto', events } }
  const ctx = {
    agents: { get: () => agent, currentInitiator: () => agent, roots: () => [agent] },
  }
  assert.equal(isDirectHumanDriver(ctx, agent, 'auto-1'), false)
  assert.throws(() => recordGrant(ctx, agent, true, 'auto-1'))
})
