import test from 'node:test'
import assert from 'node:assert/strict'
import { createTask, pickTaskWork } from '../src/tasks.js'

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