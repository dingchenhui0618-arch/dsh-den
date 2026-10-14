import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeTaskTools } from '../src/tasks-tools.js'
import { loadTasks, TASKS_FILE } from '../src/tasks-store.js'

const path = join(mkdtempSync(join(tmpdir(), 'den-task-session-')), TASKS_FILE)
const tool = (name) => {
  const found = makeTaskTools({ path }).find((entry) => entry.name === name)
  assert.ok(found, `${name} must exist`)
  return found
}
const stored = () => {
  const doc = loadTasks(path)
  return Array.isArray(doc) ? doc : (doc && doc.tasks) || []
}

test('with a conversation, the task remembers where the den must speak', async () => {
  const res = await tool('den_task_create').execute({
    goal: '做点事',
    steps: [{ title: '一步' }],
    sessionId: 'session-abc',
  })
  assert.equal(res.ok, true)
  const tasks = stored()
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].sessionId, 'session-abc')
  assert.equal(tasks[0].steps.length, 1)
})

test('without one the task is still created, and records no conversation rather than a guessed one', async () => {
  const res = await tool('den_task_create').execute({ goal: '另一件事', steps: [{ title: '一步' }] })
  assert.equal(res.ok, true)
  const tasks = stored()
  assert.equal(tasks.length, 2)
  assert.equal(tasks[1].sessionId, '')
  assert.equal(tasks[1].goal, '另一件事')
})