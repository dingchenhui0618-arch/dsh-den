import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addTask,
  advanceTask,
  blockTaskOn,
  dueFromDisk,
  loadTasks,
  summarizeFromDisk,
  TASKS_FILE,
} from '../src/tasks-store.js'

const NOW = 1_700_000_000_000
const dir = mkdtempSync(join(tmpdir(), 'den-tasks-'))
const path = join(dir, TASKS_FILE)

test('a task survives a round trip to disk', () => {
  const saved = addTask(path, { goal: '把这件事办成', steps: [{ title: '查资料' }, { title: '发出去', mode: 'auto' }] }, NOW)
  assert.equal(saved.tasks.length, 1)
  const reread = loadTasks(path)
  assert.equal(reread.tasks.length, 1)
  assert.equal(reread.tasks[0].goal, '把这件事办成')
  assert.equal(reread.tasks[0].steps[0].mode, 'ask')
  assert.equal(reread.tasks[0].steps[1].mode, 'auto')
})

test('advancing a step persists the new state', () => {
  const task = loadTasks(path).tasks[0]
  advanceTask(path, { taskId: task.id, stepId: task.steps[0].id, note: '查完了', now: NOW + 1000 })
  const again = loadTasks(path).tasks[0]
  assert.equal(again.steps[0].state, 'done')
  assert.equal(again.steps[0].note, '查完了')
  assert.equal(again.state, 'active')
})

test('a blocked task keeps its reason on disk and offers nothing', () => {
  const task = loadTasks(path).tasks[0]
  blockTaskOn(path, { taskId: task.id, reason: '等对方回复', now: NOW + 2000 })
  const again = loadTasks(path).tasks[0]
  assert.equal(again.state, 'blocked')
  assert.equal(again.blockedReason, '等对方回复')
  assert.equal(dueFromDisk(path, NOW + 3000).length, 0)
})

test('a missing file is an empty list; a corrupt one is left exactly as it is', () => {
  assert.deepEqual(loadTasks(join(dir, 'missing.json')).tasks, [])
  const broken = join(dir, 'broken.json')
  writeFileSync(broken, '{ this is not json', 'utf8')
  assert.deepEqual(loadTasks(broken).tasks, [])
  assert.equal(readFileSync(broken, 'utf8'), '{ this is not json')
})

test('the panel numbers come from disk', () => {
  const summary = summarizeFromDisk(path, NOW + 4000)
  assert.equal(summary.total, 1)
  assert.equal(summary.blocked, 1)
  const fresh = join(dir, 'fresh.json')
  addTask(fresh, { goal: 'a', steps: [{ title: 'x', mode: 'ask' }] }, NOW)
  assert.equal(summarizeFromDisk(fresh, NOW).waiting, 1)
  assert.equal(existsSync(fresh), true)
})