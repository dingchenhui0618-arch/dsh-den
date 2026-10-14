import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { ensureConversation, resolveAgentPreset } = await import('../src/conversation.js')

/** A conversation file of its own per test. */
async function tempPath(run) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-den-preset-'))
  try {
    return await run(join(dir, 'conversation.json'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function fakeCtx({ presets = [{ id: 'cordis', isDefault: true }], live = undefined, dir } = {}) {
  const calls = { create: [], resume: [] }
  return {
    calls,
    agentPresets: presets === null ? undefined : { list: async () => presets },
    agents: {
      get: () => live,
      create: async (options) => {
        calls.create.push(options)
        if (dir) writeFileSync(join(dir, 'created.txt'), 'yes')
        return { agent: { id: options.sessionId }, dispose: async () => {} }
      },
      resume: async (options) => {
        calls.resume.push(options)
        return { agent: { id: options.resumeSessionId }, dispose: async () => {} }
      },
    },
  }
}

test('the preset is the host default, and a broken one is never chosen', async () => {
  const ctx = fakeCtx({ presets: [{ id: 'other' }, { id: 'cordis', isDefault: true }, { id: 'broken', broken: 'failed to load' }] })
  assert.equal(await resolveAgentPreset(ctx), 'cordis')
  const noDefault = fakeCtx({ presets: [{ id: 'first' }, { id: 'second' }] })
  assert.equal(await resolveAgentPreset(noDefault), 'first')
  const onlyBroken = fakeCtx({ presets: [{ id: 'broken', broken: 'nope' }] })
  assert.equal(await resolveAgentPreset(onlyBroken), '', 'a broken preset is not a preset')
})

test('a relative cwd from configuration is dropped, not sent to a store that would throw', async () => {
  await tempPath(async (path) => {
    const ctx = fakeCtx()
    const result = await ensureConversation(ctx, { cwd: 'relative/project', path })
    assert.equal(ctx.calls.create[0].meta.cwd, undefined, 'the store rejects a non-absolute cwd')
    assert.equal(ctx.calls.create[0].meta.agentPreset, 'cordis', 'and the preset still goes')
    assert.equal(result.agentPreset, 'cordis')
  })
})

test('a host with no preset service is not an error, it is an empty answer', async () => {
  assert.equal(await resolveAgentPreset(fakeCtx({ presets: null })), '')
  assert.equal(await resolveAgentPreset({}), '')
  assert.equal(await resolveAgentPreset(undefined), '')
  const throwing = { agentPresets: { list: async () => { throw new Error('no') } } }
  assert.equal(await resolveAgentPreset(throwing), '')
})

test('creating the conversation carries the preset, which is what gives it a model', async () => {
  await tempPath(async (path) => {
    const ctx = fakeCtx()
    const result = await ensureConversation(ctx, { cwd: 'D:/Projects', path })
    assert.equal(result.state, 'created')
    assert.equal(ctx.calls.create.length, 1)
    assert.equal(ctx.calls.create[0].meta.agentPreset, 'cordis')
    assert.equal(ctx.calls.create[0].meta.cwd, 'D:/Projects')
    assert.equal(result.agentPreset, 'cordis')
    const record = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(record.agentPreset, 'cordis', 'and the record remembers it, so the next start can tell')
    assert.equal(record.sessionId, result.sessionId)
  })
})

test('a record from before presets is replaced, not resumed into the same failure', async () => {
  await tempPath(async (path) => {
    writeFileSync(path, JSON.stringify({ sessionId: 'old-session', createdAt: 1 }))
    const ctx = fakeCtx()
    const result = await ensureConversation(ctx, { path })
    assert.equal(ctx.calls.resume.length, 0, 'resuming it would reproduce the dead turn forever')
    assert.equal(ctx.calls.create.length, 1)
    assert.notEqual(result.sessionId, 'old-session')
    assert.equal(result.replaced, 'old-session')
    const record = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(record.replacedSessionId, 'old-session', 'the old id is kept, so its transcript is not lost')
    assert.equal(record.agentPreset, 'cordis')
  })
})

test('a record that already names a preset is resumed, and nothing is created', async () => {
  await tempPath(async (path) => {
    writeFileSync(path, JSON.stringify({ sessionId: 'good-session', createdAt: 1, agentPreset: 'cordis' }))
    const ctx = fakeCtx()
    const result = await ensureConversation(ctx, { path })
    assert.equal(result.state, 'resumed')
    assert.equal(ctx.calls.create.length, 0)
    assert.deepEqual(ctx.calls.resume, [{ resumeSessionId: 'good-session' }])
    assert.equal(result.replaced, null)
  })
})

test('with no preset on offer, a preset-less record is resumed rather than replaced in a loop', async () => {
  await tempPath(async (path) => {
    writeFileSync(path, JSON.stringify({ sessionId: 'old-session', createdAt: 1 }))
    const ctx = fakeCtx({ presets: null })
    const result = await ensureConversation(ctx, { path })
    assert.equal(result.state, 'resumed', 'a recreate would be just as dead, and would happen every call')
    assert.equal(ctx.calls.create.length, 0)
  })
})

test('a live agent is used whatever the record says', async () => {
  await tempPath(async (path) => {
    writeFileSync(path, JSON.stringify({ sessionId: 'old-session', createdAt: 1 }))
    const ctx = fakeCtx({ live: { id: 'old-session' } })
    const result = await ensureConversation(ctx, { path })
    assert.equal(result.state, 'live')
    assert.equal(result.agent.id, 'old-session')
    assert.equal(ctx.calls.create.length + ctx.calls.resume.length, 0)
  })
})
