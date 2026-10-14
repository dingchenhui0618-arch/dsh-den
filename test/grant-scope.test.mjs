import test from 'node:test'// A record the validator accepts: `isValidRecord` in src/grant.js requires every field below.
const record = (sessionId) =>
  JSON.stringify({
    version: 1,
    sessionId,
    autonomy: true,
    humanMessageId: 'm1',
    humanSeq: 1,
    recordedAfterSeq: 0,
  })

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasAnyGrant } from '../src/grant.js'

test('a grant proved somewhere wakes the den, instead of only that one conversation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'den-grants-'))
  assert.equal(hasAnyGrant('', dir), false, 'an empty grants directory grants nothing')
  writeFileSync(join(dir, 'a-conversation.json'), record('session-a'))
  assert.equal(hasAnyGrant('session-b', dir), true)
})

test('a grants directory that does not exist yet grants nothing, and does not throw', () => {
  assert.equal(hasAnyGrant('', join(tmpdir(), 'den-grants-absent-xyz')), false)
})

test('the default is the real den, so the caller cannot forget to pass one', () => {
  assert.equal(typeof hasAnyGrant(), 'boolean')
})
test('a record for the asking conversation is not laundered into authority', () => {
  const dir = mkdtempSync(join(tmpdir(), 'den-grants-'))
  writeFileSync(join(dir, 'a.json'), record('session-a'))
  assert.equal(hasAnyGrant('session-b', dir), true, 'another conversation may act on it')
  assert.equal(hasAnyGrant('session-a', dir), false, 'but the one whose grant failed attestation may not')
})
test('a conversation with no name of its own gets no grant from the directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'den-grants-'))
  writeFileSync(join(dir, 'a.json'), record('session-a'))
  assert.equal(hasAnyGrant('', dir), false, 'an unnamed caller stays unauthorised')
  assert.equal(hasAnyGrant(null, dir), true, 'but a wake with no conversation at all may act on one')
  assert.equal(hasAnyGrant('session-b', dir), true, 'while a named conversation still may act')
})

test('a revocation in one conversation does not authorize another', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { hasAnyGrant } = await import('../src/grant.js')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-den-revoked-'))
  try {
    writeFileSync(join(dir, 'revoked.json'), "{\"version\":1,\"sessionId\":\"session-a\",\"autonomy\":false,\"humanMessageId\":\"m1\",\"humanSeq\":1,\"recordedAfterSeq\":0}")
    assert.equal(hasAnyGrant('session-b', dir), false, 'a revocation is not a grant to lend out')
    writeFileSync(join(dir, 'granted.json'), "{\"version\":1,\"sessionId\":\"session-c\",\"autonomy\":true,\"humanMessageId\":\"m2\",\"humanSeq\":2,\"recordedAfterSeq\":0}")
    assert.equal(hasAnyGrant('session-b', dir), true, 'but a real grant elsewhere still counts')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
