import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addEntry,
  forgetEntry,
  listEntries,
  loadProfile,
  makeEntry,
  saveProfile,
  updateEntry,
  PROFILE_FILE,
} from '../src/profile.js'

const NOW = 1_700_000_000_000
const path = join(mkdtempSync(join(tmpdir(), 'den-profile-')), PROFILE_FILE)

test('an entry that cannot name a source is refused, and nothing reaches disk', () => {
  assert.throws(() => makeEntry({ text: '喜欢简短回答' }), /source/)
  assert.throws(() => makeEntry({ text: 'x', source: 'guessed' }), /unknown source/)
  assert.equal(loadProfile(path).entries.length, 0)
})

test('an entry with no text is refused too', () => {
  assert.throws(() => makeEntry({ text: '   ', source: 'user' }), /text/)
})

test('entries round-trip with their provenance and survive a reload', () => {
  let profile = loadProfile(path)
  profile = addEntry(profile, { text: '做的是中文 Windows 上的项目', kind: 'work', source: 'memories' }, NOW)
  profile = addEntry(profile, { text: '不要猜授权', kind: 'boundary', source: 'user' }, NOW + 1000)
  saveProfile(path, profile)
  const reread = loadProfile(path)
  assert.equal(reread.entries.length, 2)
  assert.equal(reread.entries[0].source, 'memories')
  assert.equal(reread.entries[1].kind, 'boundary')
})

test('listEntries answers newest first, and can filter one kind', () => {
  const profile = loadProfile(path)
  assert.equal(listEntries(profile)[0].text, '不要猜授权')
  assert.equal(listEntries(profile, { kind: 'work' }).length, 1)
  assert.equal(listEntries(profile, { kind: 'nope' }).length, 0)
})

test('editing the wording keeps the source, so provenance cannot be laundered', () => {
  const profile = loadProfile(path)
  const target = profile.entries.find((entry) => entry.source === 'user')
  const edited = updateEntry(profile, { id: target.id, text: '不要替用户猜授权', now: NOW + 2000 })
  const editedEntry = edited.entries.find((entry) => entry.id === target.id)
  assert.equal(editedEntry.text, '不要替用户猜授权')
  assert.equal(editedEntry.source, 'user')
})

test('forgetting removes it; forgetting something absent is a caller error', () => {
  const profile = loadProfile(path)
  const gone = forgetEntry(profile, { id: profile.entries[0].id })
  assert.equal(gone.entries.length, 1)
  assert.throws(() => forgetEntry(profile, { id: 'nope' }), TypeError)
})

test('a corrupt file is an empty profile and is left exactly as it is', () => {
  const broken = join(mkdtempSync(join(tmpdir(), 'den-profile-')), PROFILE_FILE)
  writeFileSync(broken, '{ not json', 'utf8')
  assert.deepEqual(loadProfile(broken).entries, [])
  assert.equal(readFileSync(broken, 'utf8'), '{ not json')
})