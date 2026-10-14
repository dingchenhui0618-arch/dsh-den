import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DenKernel } from '../src/kernel.js'
import { addTask, loadTasks, TASKS_FILE } from '../src/tasks-store.js'

/**
 * DESIGN §7.3 through the real heartbeat, with no agent — because that is how the heartbeat is
 * actually invoked: `start()` installs `setInterval(() => this.tick())`, no arguments at all.
 * A path that is only ever tested with a hand-passed agent is a path that does not exist in the
 * field, and this file has already paid for learning that once.
 *
 * Every case below deliberately avoids faking an autonomy grant. Two of them need no authority at
 * all, and the third asserts what happens when authority is *absent* — which is the safety
 * property, not the happy path.
 */
const state = () => ({ dailyTurnBudget: 50, cooldownSeconds: 0, quietHours: null })
const fresh = () => join(mkdtempSync(join(tmpdir(), 'den-task-tick-')), TASKS_FILE)
const tasksOn = (path) => {
  const doc = loadTasks(path)
  return Array.isArray(doc) ? doc : (doc && doc.tasks) || []
}

test('a task with nowhere to speak is blocked by the heartbeat itself, with the reason on disk', async () => {
  const path = fresh()
  addTask(path, { goal: '没有会话的活', steps: [{ title: '一步', mode: 'auto' }], sessionId: '' })
  const events = []
  const delivered = []
  const kernel = new DenKernel({
    service: { state },
    deliver: async (wake) => {
      delivered.push(wake)
      return 'ok'
    },
    onEvent: (event) => events.push(event),
    taskPath: path,
  })

  const out = await kernel.tick({ now: Date.now() })

  assert.equal(delivered.length, 0, 'nothing may be delivered for a task with no conversation')
  const task = tasksOn(path)[0]
  assert.equal(task.state, 'blocked')
  assert.match(task.blockedReason, /conversation/)
  assert.equal(task.steps[0].state, 'pending', 'a blocked task does not advance itself')
  assert.ok(
    events.some((event) => event.type === 'task-blocked'),
    'and the block is announced, not silent',
  )
  assert.deepEqual(out.results, [])
})

test('an ask step is waiting on the person, so a quiet heartbeat changes nothing at all', async () => {
  const path = fresh()
  addTask(path, { goal: '要你点头的活', steps: [{ title: '发出去' }], sessionId: 'session-1' })
  const before = JSON.stringify(tasksOn(path))
  const delivered = []
  const kernel = new DenKernel({
    service: { state },
    deliver: async (wake) => {
      delivered.push(wake)
      return 'ok'
    },
    taskPath: path,
  })

  await kernel.tick({ now: Date.now() })

  assert.equal(delivered.length, 0, 'an ask step is never taken by the heartbeat')
  assert.equal(JSON.stringify(tasksOn(path)), before, 'and nothing on disk moves')
  assert.equal(tasksOn(path)[0].state, 'active')
})

test('without a grant the step is refused and stays pending, so nothing advances unauthorised', async () => {
  const path = fresh()
  addTask(path, { goal: '自动那步', steps: [{ title: '跑测试', mode: 'auto' }], sessionId: 'session-1' })
  const events = []
  const delivered = []
  const kernel = new DenKernel({
    service: { state },
    deliver: async (wake) => {
      delivered.push(wake)
      return 'ok'
    },
    onEvent: (event) => events.push(event),
    taskPath: path,
  })

  const out = await kernel.tick({ now: Date.now() })

  assert.equal(delivered.length, 0)
  const task = tasksOn(path)[0]
  assert.equal(task.steps[0].state, 'pending', 'a refused step must not move')
  assert.equal(task.state, 'active')
  assert.equal(out.results.length, 1)
  assert.equal(out.results[0].outcome, 'refused')
  assert.ok(
    events.some((event) => event.type === 'task-refused' || event.type === 'task-unresolved'),
    'a refusal on this path is recorded like every other refusal',
  )
})