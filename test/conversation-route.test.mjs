import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { invokeAction } = await import('../src/panel-api.js')

/**
 * A conversation file of its own per test, handed to the action the same way the grants directory is
 * handed in. An environment variable would not do: `denPath()` resolves den's home once when the
 * module is imported, so redirecting `DSH_HOME` afterwards still reads the real home.
 */
function tempConversation(run) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-den-route-'))
  const path = join(dir, 'conversation.json')
  try {
    return run({ dir, path })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The smallest service these two actions touch: everything else would only be dead weight. */
function serviceWith(ctx, path, counters = {}) {
  const count = (name) => () => {
    counters[name] = (counters[name] || 0) + 1
    return undefined
  }
  return {
    ctx,
    conversationPath: path,
    listTriggers: count('listTriggers'),
    dueTriggers: count('dueTriggers'),
    listScenarios: count('listScenarios'),
    gateAudit: count('gateAudit'),
    noteEvent: count('noteEvent'),
  }
}

test('reading the window does not create a conversation or touch the host', async () => {
  await tempConversation(async ({ path }) => {
    const counters = {}
    const ctx = {
      agents: {
        get: () => { counters.get = (counters.get || 0) + 1; return undefined },
        create: () => { counters.create = (counters.create || 0) + 1; throw new Error('must not create') },
        resume: () => { counters.resume = (counters.resume || 0) + 1; throw new Error('must not resume') },
      },
      sessions: { get: () => { counters.sessions = (counters.sessions || 0) + 1; return null } },
    }
    const outcome = await invokeAction(serviceWith(ctx, path), 'conversation/read', {}, {})
    assert.equal(outcome.ok, true)
    assert.equal(outcome.value.state, 'absent')
    assert.deepEqual(outcome.value.messages, [])
    assert.deepEqual(counters, {}, 'no lookup, no creation, and therefore no charged turn')
  })
})

test('saying nothing is refused before anything is woken', async () => {
  await tempConversation(async ({ path }) => {
    const counters = {}
    const ctx = {
      agents: {
        get: () => { counters.get = (counters.get || 0) + 1; return undefined },
        create: () => { counters.create = (counters.create || 0) + 1; throw new Error('must not create') },
      },
    }
    for (const text of ['', '   ', undefined]) {
      const outcome = await invokeAction(serviceWith(ctx, path), 'conversation/say', { text }, {})
      assert.equal(outcome.ok, false, `text ${JSON.stringify(text)} must not be sent`)
      assert.match(outcome.error, /nothing to say/)
    }
    assert.deepEqual(counters, {}, 'an empty message must not even look for the conversation')
  })
})

test('a first message creates the conversation, delivers it, and writes the id down', async () => {
  await tempConversation(async ({ path }) => {
    const sent = []
    const created = []
    const ctx = {
      agents: {
        get: () => undefined,
        create: async (options) => {
          created.push(options.sessionId)
          return {
            agent: { id: options.sessionId, followup: (message) => sent.push(message) },
            dispose: async () => {},
          }
        },
      },
      sessions: { get: () => null },
    }
    const outcome = await invokeAction(serviceWith(ctx, path), 'conversation/say', { text: ' are you awake? ' }, {})
    assert.equal(outcome.ok, true, JSON.stringify(outcome))
    assert.equal(outcome.value.state, 'created')
    assert.deepEqual(created, [outcome.value.sessionId])
    assert.equal(sent.length, 1, 'exactly one turn was queued')
    assert.equal(sent[0].content[0].text, 'are you awake?')
    assert.equal(sent[0].role, 'user')
    assert.match(outcome.value.messageId, /^den-say-/)
    const written = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(written.sessionId, outcome.value.sessionId, 'the id the host accepted is the one kept on disk')
  })
})

test('a conversation that exists but cannot be read is reported as such, not as empty', async () => {
  await tempConversation(async ({ path }) => {
    writeFileSync(path, JSON.stringify({ sessionId: 'sess-gone' }))
    const ctx = { agents: { get: () => undefined }, sessions: { get: () => null } }
    const outcome = await invokeAction(serviceWith(ctx, path), 'conversation/read', {}, {})
    assert.equal(outcome.ok, true)
    assert.equal(outcome.value.state, 'unreadable')
    assert.equal(outcome.value.sessionId, 'sess-gone')
    assert.deepEqual(outcome.value.messages, [], 'nothing is invented to fill the gap')
  })
})

test('when the host has a live conversation, its transcript comes back as messages', async () => {
  await tempConversation(async ({ path }) => {
    writeFileSync(path, JSON.stringify({ sessionId: 'sess-live' }))
    const events = [
      { type: 'user/message', seq: 1, time: 10, data: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
      {
        type: 'assistant/message',
        seq: 2,
        time: 11,
        data: { message: { role: 'assistant', content: [{ type: 'text', text: 'awake' }] } },
      },
    ]
    const ctx = {
      agents: { get: (id) => (id === 'sess-live' ? { id, session: { snapshotEvents: () => events } } : undefined) },
    }
    const outcome = await invokeAction(serviceWith(ctx, path), 'conversation/read', { limit: 1 }, {})
    assert.equal(outcome.value.state, 'live')
    assert.deepEqual(outcome.value.messages.map((message) => message.text), ['awake'], 'the limit is honoured')
    assert.equal(outcome.value.total, 2)
    assert.equal(outcome.value.truncated, true, 'and the window is told it is looking at a tail')
  })
})

test('a conversation recorded somewhere else is not silently adopted', async () => {
  await tempConversation(async ({ dir, path }) => {
    const ctx = { agents: { get: () => undefined }, sessions: { get: () => null } }
    writeFileSync(join(dir, 'somewhere-else.json'), JSON.stringify({ sessionId: 'sess-elsewhere' }))
    const outcome = await invokeAction(serviceWith(ctx, path), 'conversation/read', {}, {})
    assert.equal(outcome.value.state, 'absent', 'only the file it was pointed at counts')
    assert.equal(outcome.value.sessionId, null)
  })
})
