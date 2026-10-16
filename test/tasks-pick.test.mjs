import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTask, pickTaskWork, standingSessionIdFor } from '../src/tasks.js'

const NOW = 1_800_000_000_000
const task = (over = {}) =>
  createTask({ goal: '做点事', steps: [{ title: '一步' }], sessionId: 'session-1', now: NOW, ...over })

test('an auto step in a task that knows its conversation is the heartbeat’s to take', () => {
  const t = task({ steps: [{ title: '跑测试', mode: 'auto' }] })
  const pick = pickTaskWork([t], NOW)
  assert.equal(pick.kind, 'step')
  assert.equal(pick.step.title, '跑测试')
  assert.equal(pick.task.sessionId, 'session-1')
})

test('an ask step is waiting on the person, not broken', () => {
  const t = task()
  const pick = pickTaskWork([t], NOW)
  assert.equal(pick.kind, 'waiting')
  assert.equal(pick.step.mode, 'ask')
})

test('a task with nowhere to speak is blocked with a reason, never skipped in silence', () => {
  const t = task({ sessionId: '' })
  const pick = pickTaskWork([t], NOW)
  assert.equal(pick.kind, 'blocked')
  assert.match(pick.reason, /conversation/)
})

test('a later step never overtakes an earlier one, and finished work is idle', () => {
  const t = task({ steps: [{ title: '第一步' }, { title: '第二步', mode: 'auto' }] })
  assert.equal(pickTaskWork([t], NOW).step.title, '第一步')
  const done = { ...t, state: 'done' }
  assert.equal(pickTaskWork([done], NOW).kind, 'idle')
  assert.equal(pickTaskWork([], NOW).kind, 'idle')
})

test('a task whose own conversation is gone reports into the standing one instead of blocking forever', () => {
  const t = task({ sessionId: '', steps: [{ title: '跑测试', mode: 'auto' }] })
  const pick = pickTaskWork([t], NOW, { fallbackSessionId: 'session-standing' })
  assert.equal(pick.kind, 'step')
  assert.equal(pick.task.sessionId, 'session-standing', 'the step now knows where to report')
  assert.equal(t.sessionId, '', 'the stored task itself is not mutated by the fallback')
  // An empty or absent fallback keeps the old, honest behaviour: blocked, with the reason on it.
  assert.equal(pickTaskWork([t], NOW).kind, 'blocked')
  assert.equal(pickTaskWork([t], NOW, { fallbackSessionId: '   ' }).kind, 'blocked')
  assert.match(pickTaskWork([t], NOW).reason, /conversation/)
})

test('the standing conversation is read from the pointer beside the task file, and any failure means empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-den-tasks-'))
  try {
    const pointer = join(dir, 'conversation.json')
    const tasksPath = join(dir, 'tasks.json')
    const t = task({ sessionId: '', steps: [{ title: '跑测试', mode: 'auto' }] })
    writeFileSync(pointer, JSON.stringify({ sessionId: 'session-standing' }))
    assert.equal(pickTaskWork([t], NOW, { tasksPath }).task.sessionId, 'session-standing')
    // A half-written pointer and a missing one are both "no conversation", never a crash.
    writeFileSync(pointer, '{ half')
    assert.equal(pickTaskWork([t], NOW, { tasksPath }).kind, 'blocked')
    assert.equal(pickTaskWork([t], NOW, { tasksPath: join(dir, 'nope', 'tasks.json') }).kind, 'blocked')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the standing-conversation reader is shared, takes a pointer directly, and never throws', () => {
  // `panel-api.js`'s `notices/ack` imports this same function, so the heartbeat and the panel cannot
  // end up with two readings of "which conversation is den's standing one" — the second copy of a
  // read is exactly how the two get to disagree. Naming the pointer itself is what a caller that
  // already holds a conversation path relies on: the derivation from a state file is a no-op on it.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-den-standing-'))
  try {
    const pointer = join(dir, 'conversation.json')
    writeFileSync(pointer, JSON.stringify({ sessionId: 'session-standing' }))
    assert.equal(standingSessionIdFor(pointer), 'session-standing', 'a conversation path may be handed in as-is')
    assert.equal(standingSessionIdFor(join(dir, 'tasks.json')), 'session-standing', 'or its neighbour')
    // Absent, unreadable, half-written and not-given are all "no conversation", and none of them throws:
    // a missing pointer must stay a reportable state rather than taking the caller down with it.
    assert.equal(standingSessionIdFor(''), '')
    assert.equal(standingSessionIdFor(undefined), '')
    assert.equal(standingSessionIdFor(join(dir, 'nope', 'tasks.json')), '')
    writeFileSync(pointer, '{ half')
    assert.equal(standingSessionIdFor(pointer), '')
    writeFileSync(pointer, JSON.stringify({ sessionId: '   ' }))
    assert.equal(standingSessionIdFor(pointer), '', 'whitespace is not a conversation')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})