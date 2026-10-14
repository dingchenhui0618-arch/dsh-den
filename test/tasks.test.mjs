import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createTask,
  nextDueStep,
  dueTasks,
  completeStep,
  blockTask,
  resumeTask,
  summarize,
  DEFAULT_STEP_MODE,
} from '../src/tasks.js'

const NOW = 1_700_000_000_000

test('a task carries steps, and an unlabelled step asks', () => {
  const task = createTask({ goal: '办好这件事', steps: [{ title: '查资料' }, { title: '发布', mode: 'auto' }], now: NOW })
  assert.equal(task.steps.length, 2)
  assert.equal(task.steps[0].mode, DEFAULT_STEP_MODE)
  assert.equal(task.steps[0].mode, 'ask')
  assert.equal(task.steps[1].mode, 'auto')
  assert.equal(task.state, 'active')
})

test('an unrecognised level falls back to asking, never to acting', () => {
  const task = createTask({ goal: 'x', steps: [{ title: 'a', mode: 'AUTO' }, { title: 'b', mode: 'whatever' }], now: NOW })
  assert.equal(task.steps[0].mode, 'ask')
  assert.equal(task.steps[1].mode, 'ask')
})

test('an empty goal or no steps is refused instead of stored', () => {
  assert.throws(() => createTask({ goal: '   ', steps: [{ title: 'a' }] }), TypeError)
  assert.throws(() => createTask({ goal: 'x', steps: [] }), TypeError)
  assert.throws(() => createTask({ goal: 'x', steps: [{ title: '  ' }] }), TypeError)
})

test('the next due step is the first one allowed now, and a later step waits its turn', () => {
  const task = createTask({ goal: 'x', steps: [{ title: 'a', notBefore: NOW + 60_000 }, { title: 'b' }], now: NOW })
  assert.equal(nextDueStep(task, NOW), null)
  assert.equal(nextDueStep(task, NOW + 60_000).title, 'a')
})

test('finishing every step closes the task, and nothing is mutated on the way', () => {
  const task = createTask({ goal: 'x', steps: [{ title: 'a' }, { title: 'b' }], now: NOW })
  const afterFirst = completeStep(task, { stepId: task.steps[0].id, now: NOW + 1 })
  assert.equal(task.steps[0].state, 'pending')
  assert.equal(afterFirst.state, 'active')
  const afterSecond = completeStep(afterFirst, { stepId: task.steps[1].id, now: NOW + 2 })
  assert.equal(afterSecond.state, 'done')
  assert.equal(nextDueStep(afterSecond, NOW + 3), null)
})

test('a blocked task keeps its reason and offers no steps', () => {
  const task = createTask({ goal: 'x', steps: [{ title: 'a' }], now: NOW })
  const blocked = blockTask(task, { reason: '等对方回复', now: NOW + 1 })
  assert.equal(blocked.state, 'blocked')
  assert.equal(blocked.blockedReason, '等对方回复')
  assert.equal(nextDueStep(blocked, NOW + 2), null)
  assert.equal(resumeTask(blocked, { now: NOW + 3 }).state, 'active')
})

test('the summary counts what is in progress, stuck, and waiting on the human', () => {
  const asks = createTask({ goal: 'ask', steps: [{ title: 'a', mode: 'ask' }], now: NOW })
  const autos = createTask({ goal: 'auto', steps: [{ title: 'a', mode: 'auto' }], now: NOW })
  const stuck = blockTask(createTask({ goal: 'stuck', steps: [{ title: 'a' }], now: NOW }), { reason: 'r', now: NOW })
  const summary = summarize([asks, autos, stuck], NOW)
  assert.equal(summary.total, 3)
  assert.equal(summary.active, 2)
  assert.equal(summary.blocked, 1)
  assert.equal(summary.waiting, 1)
})

test('a step that is not due yet does not count as waiting', () => {
  const later = createTask({ goal: 'x', steps: [{ title: 'a', mode: 'ask', notBefore: NOW + 60_000 }], now: NOW })
  assert.equal(summarize([later], NOW).waiting, 0)
  assert.equal(dueTasks([later], NOW).length, 0)
  assert.equal(dueTasks([later], NOW + 60_000).length, 1)
})