/**
 * Smoke tests for the durability and authority primitives.
 *
 * These run with the bundled Node and home-relative paths only; they never touch
 * the live DSH profile or the user's real `~/.dsh/den` state.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// Point every module at an isolated home before importing them.
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-den-test-'))
process.env.DSH_HOME = sandbox

const { denHome, digest, readJsonChecked, writeJsonAtomic, publishIfAbsent } = await import('../src/atom.js')
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
