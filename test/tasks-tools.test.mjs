import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeTaskTools } from '../src/tasks-tools.js'

const path = join(mkdtempSync(join(tmpdir(), 'den-tools-')), 'tasks.json')
const tool = (name) => {
  const found = makeTaskTools({ path }).find((entry) => entry.name === name)
  assert.ok(found, name + ' must exist')
  return found
}
const list = async () => (await tool('den_task_list').execute({})).tasks

test('the four task tools exist with the den_ prefix', () => {
  const names = makeTaskTools({ path }).map((entry) => entry.name).sort()
  assert.deepEqual(names, ['den_task_advance', 'den_task_block', 'den_task_create', 'den_task_list'])
})

test('a request becomes a task, and the answer carries the numbers the panel needs', async () => {
  const res = await tool('den_task_create').execute({
    goal: '把这件事办成',
    steps: [{ title: '查资料' }, { title: '发出去' }],
  })
  assert.equal(res.ok, true)
  assert.equal(res.goal, '把这件事办成')
  assert.equal(res.steps.length, 2)
  assert.equal(res.steps[0].mode, 'ask')
  assert.equal(res.waiting, 1)
  assert.equal(res.active, 1)
})

test('a request with no usable goal or steps is refused, not stored', async () => {
  const res = await tool('den_task_create').execute({ goal: '   ', steps: [] })
  assert.equal(res.ok, false)
  assert.match(res.error, /goal|step/i)
})

test('an ask step refuses without the human words, and nothing changes on disk', async () => {
  const before = readFileSync(path, 'utf8')
  const task = (await list())[0]
  const res = await tool('den_task_advance').execute({ taskId: task.id })
  assert.equal(res.ok, false)
  assert.match(res.error, /ask/)
  assert.equal(readFileSync(path, 'utf8'), before)
})

test('with the human words that same step goes through, and the words are recorded', async () => {
  const task = (await list())[0]
  const res = await tool('den_task_advance').execute({ taskId: task.id, approval: '好，发吧', note: '查完了' })
  assert.equal(res.ok, true)
  assert.equal(res.state, 'active')
  const after = (await list())[0]
  assert.equal(after.steps[0].state, 'done')
  assert.match(after.steps[0].note, /好，发吧/)
})

test('an auto step needs no words, so the level actually means something', async () => {
  const created = await tool('den_task_create').execute({ goal: '自动那步', steps: [{ title: '跑测试', mode: 'auto' }] })
  const res = await tool('den_task_advance').execute({ taskId: created.taskId })
  assert.equal(res.ok, true)
  assert.equal(res.state, 'done')
})

test('blocking keeps the reason and offers no steps; resuming clears it', async () => {
  const created = await tool('den_task_create').execute({ goal: '等回复', steps: [{ title: 'a' }] })
  const blocked = await tool('den_task_block').execute({ taskId: created.taskId, reason: '等对方回复' })
  assert.equal(blocked.state, 'blocked')
  assert.equal(blocked.blockedReason, '等对方回复')
  const advanced = await tool('den_task_advance').execute({ taskId: created.taskId })
  assert.equal(advanced.ok, false)
  const resumed = await tool('den_task_block').execute({ taskId: created.taskId, reason: '', resume: true })
  assert.equal(resumed.state, 'active')
})

test('an unknown task id is a caller error and throws', async () => {
  await assert.rejects(() => tool('den_task_advance').execute({ taskId: 'nope' }), TypeError)
  await assert.rejects(() => tool('den_task_block').execute({ taskId: 'nope', reason: 'x' }), TypeError)
})