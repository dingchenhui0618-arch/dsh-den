import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeProfileTools } from '../src/profile-tools.js'
import { PROFILE_FILE } from '../src/profile.js'

const path = join(mkdtempSync(join(tmpdir(), 'den-prof-')), PROFILE_FILE)
const tool = () => {
  const found = makeProfileTools({ path }).find((entry) => entry.name === 'den_profile')
  assert.ok(found, 'den_profile must exist')
  return found
}

test('it is one tool named den_profile, not a second set of memory verbs', () => {
  const tools = makeProfileTools({ path })
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, 'den_profile')
})

test('list on an empty profile answers with the permitted vocabulary', async () => {
  const res = await tool().execute({ action: 'list' })
  assert.equal(res.ok, true)
  assert.equal(res.count, 0)
  assert.deepEqual(res.sources, ['session', 'memories', 'repos', 'user'])
})

test('remember without a source is refused, and nothing reaches disk', async () => {
  const res = await tool().execute({ action: 'remember', text: '喜欢简短回答' })
  assert.equal(res.ok, false)
  assert.match(res.error, /source/)
  assert.equal((await tool().execute({ action: 'list' })).count, 0)
})

test('remember with a source sticks, and list reads it back with its provenance', async () => {
  const res = await tool().execute({
    action: 'remember',
    text: '不要替用户猜授权',
    kind: 'boundary',
    source: 'user',
  })
  assert.equal(res.ok, true)
  assert.equal(res.count, 1)
  const listed = await tool().execute({ action: 'list' })
  assert.equal(listed.entries[0].text, '不要替用户猜授权')
  assert.equal(listed.entries[0].source, 'user')
  assert.equal(listed.entries[0].kind, 'boundary')
})

test('edit corrects the wording and keeps the source', async () => {
  const before = (await tool().execute({ action: 'list' })).entries[0]
  const res = await tool().execute({ action: 'edit', id: before.id, text: '不要猜授权' })
  assert.equal(res.ok, true)
  assert.equal(res.entries[0].text, '不要猜授权')
  assert.equal(res.entries[0].source, 'user')
})

test('forget removes it, and an unknown action is refused rather than guessed at', async () => {
  const target = (await tool().execute({ action: 'list' })).entries[0]
  assert.equal((await tool().execute({ action: 'forget', id: target.id })).count, 0)
  const res = await tool().execute({ action: 'recall' })
  assert.equal(res.ok, false)
  assert.match(res.error, /unknown action/)
})