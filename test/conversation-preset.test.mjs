import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const { ensureConversation,
  resolveWorkspaceCwd, resolveAgentPreset } = await import('../src/conversation.js')

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
    agentDefaultModel: presets === null ? undefined : { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
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

test('the workspace is the human\'s, in that order of preference, and always absolute', async () => {
  const absolute = await resolveWorkspaceCwd({}, { configured: 'D:/Projects' })
  assert.deepEqual(absolute, { cwd: 'D:/Projects', source: 'config' }, 'an absolute configured cwd wins')
  const relative = await resolveWorkspaceCwd({}, { configured: 'relative/path' })
  assert.equal(relative.source, 'den-home', 'a relative one is not a workspace')
  assert.ok(isAbsolute(relative.cwd), 'and the fallback is still absolute')

  const published = { sessions: { get: () => ({ header: { cwd: 'D:/Projects/dsh-den' } }) } }
  assert.deepEqual(
    await resolveWorkspaceCwd(published, { sessionId: 'sess-1' }),
    { cwd: 'D:/Projects/dsh-den', source: 'session' },
    'den works where the human works',
  )

  const observed = {
    sessionQuery: { observeSession: async () => ({ header: { cwd: 'D:/Projects/elsewhere' }, dispose: async () => {} }) },
  }
  assert.deepEqual(
    await resolveWorkspaceCwd(observed, { sessionId: 'sess-2' }),
    { cwd: 'D:/Projects/elsewhere', source: 'session' },
    'or from the observation the host itself would read',
  )
})

test('a record with no cwd is replaced, because a session header cannot be changed', async () => {
  await tempPath(async (path) => {
    writeFileSync(path, JSON.stringify({ sessionId: 'preset-but-no-cwd', createdAt: 1, agentPreset: 'cordis' }))
    const ctx = fakeCtx()
    const result = await ensureConversation(ctx, { path })
    assert.equal(result.state, 'created')
    assert.equal(result.replaced, 'preset-but-no-cwd')
    assert.equal(ctx.calls.resume.length, 0, 'resuming it would reproduce the same failure forever')
    assert.ok(isAbsolute(ctx.calls.create[0].meta.cwd), 'the new one has a workspace')
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).cwdSource, 'den-home')
  })
})

test('the model comes from the host\'s current selection, which is what makes {{model}} resolve', async () => {
  await tempPath(async (path) => {
    const ctx = fakeCtx()
    const result = await ensureConversation(ctx, { path })
    assert.deepEqual(ctx.calls.create[0].agentOptions, { provider: 'deepseek', model: 'deepseek-chat' })
    assert.equal(result.state, 'created')
  })
})

test('a host with no current selection still creates, and says so by sending no options', async () => {
  await tempPath(async (path) => {
    const ctx = fakeCtx()
    delete ctx.agentDefaultModel
    await ensureConversation(ctx, { path })
    assert.equal(ctx.calls.create[0].agentOptions, undefined)
  })
})

test('a resumed conversation is given the selection too, so a model change is picked up', async () => {
  await tempPath(async (path) => {
    writeFileSync(path, JSON.stringify({ sessionId: 'good-session', createdAt: 1, agentPreset: 'cordis', cwd: 'D:/Projects' }))
    const ctx = fakeCtx()
    const result = await ensureConversation(ctx, { path })
    assert.equal(result.state, 'resumed')
    assert.deepEqual(ctx.calls.resume[0], {
      resumeSessionId: 'good-session',
      agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
    })
  })
})

test('a relative cwd from configuration falls back to an absolute workspace', async () => {
  await tempPath(async (path) => {
    const ctx = fakeCtx()
    const result = await ensureConversation(ctx, { cwd: 'relative/project', path })
    assert.ok(isAbsolute(ctx.calls.create[0].meta.cwd), 'the store receives an absolute fallback path')
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
    writeFileSync(path, JSON.stringify({ sessionId: 'good-session', createdAt: 1, agentPreset: 'cordis', cwd: 'D:/Projects' }))
    const ctx = fakeCtx()
    const result = await ensureConversation(ctx, { path })
    assert.equal(result.state, 'resumed')
    assert.equal(ctx.calls.create.length, 0)
    assert.deepEqual(ctx.calls.resume, [
      { resumeSessionId: 'good-session', agentOptions: { provider: 'deepseek', model: 'deepseek-chat' } },
    ])
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
