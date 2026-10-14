import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ensureConversation,
  readConversation,
  readConversationRecord,
  readStandingConversation,
  appendToSession,
  sayInConversation,
  textOfMessage,
} from '../src/conversation.js'

function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-den-conversation-'))
  return { dir, path: join(dir, 'conversation.json'), clean: () => rmSync(dir, { recursive: true, force: true }) }
}

/** A session stand-in shaped like the one the host hands back: events carrying seq, time and data. */
function fakeSession(events) {
  return { snapshotEvents: () => events }
}

const said = (seq, text) => ({
  type: 'user/message',
  seq,
  time: 1000 + seq,
  data: { role: 'user', content: [{ type: 'text', text }] },
})

const answered = (seq, text) => ({
  type: 'assistant/message',
  seq,
  time: 1000 + seq,
  data: { role: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } },
})

test('the conversation is only what was said, not the machinery of the turn', () => {
  const read = readConversation(
    fakeSession([
      said(1, 'hello'),
      { type: 'tool/call', seq: 2, time: 3, data: { name: 'read', arguments: '{}' } },
      answered(3, 'hi'),
      {
        type: 'assistant/message',
        seq: 4,
        time: 5,
        data: { message: { content: [{ type: 'reasoning', text: 'hm' }] } },
      },
      { type: 'turn/end', seq: 5, time: 6, data: {} },
    ]),
  )
  assert.deepEqual(
    read.messages.map((message) => `${message.role}:${message.text}`),
    ['user:hello', 'assistant:hi'],
    'tool traffic and reasoning must not read as conversation',
  )
  assert.equal(read.total, 2)
  assert.equal(read.truncated, false)
})

test('a read shows a tail and says so, rather than pretending it is everything', () => {
  const events = []
  for (let i = 1; i <= 10; i += 1) events.push(said(i, 'line ' + i))
  const read = readConversation(fakeSession(events), { limit: 3 })
  assert.deepEqual(read.messages.map((message) => message.text), ['line 8', 'line 9', 'line 10'])
  assert.equal(read.total, 10)
  assert.equal(read.truncated, true, 'the transcript keeps everything; the window shows a tail and admits it')
})

test('reading a conversation that was never created does not create one', () => {
  const home = tempHome()
  try {
    let touched = 0
    const ctx = {
      agents: {
        get: () => undefined,
        create: () => { touched += 1; throw new Error('must not be called') },
        resume: () => { touched += 1; throw new Error('must not be called') },
      },
      sessions: { get: () => { touched += 1; return null } },
    }
    const read = readStandingConversation(ctx, { path: home.path })
    assert.equal(read.state, 'absent')
    assert.deepEqual(read.messages, [])
    assert.equal(touched, 0, 'opening the window must not charge a turn')
  } finally {
    home.clean()
  }
})

test('a stored conversation is read without a live agent', () => {
  const home = tempHome()
  try {
    writeFileSync(home.path, JSON.stringify({ sessionId: 'sess-stored' }))
    const ctx = {
      agents: { get: () => undefined },
      sessions: { get: (id) => (id === 'sess-stored' ? fakeSession([said(1, 'earlier')]) : null) },
    }
    const read = readStandingConversation(ctx, { path: home.path })
    assert.equal(read.state, 'stored')
    assert.equal(read.sessionId, 'sess-stored')
    assert.deepEqual(read.messages.map((message) => message.text), ['earlier'])
  } finally {
    home.clean()
  }
})

test('a live conversation is reported as live', () => {
  const home = tempHome()
  try {
    writeFileSync(home.path, JSON.stringify({ sessionId: 'sess-live' }))
    const ctx = {
      agents: { get: (id) => (id === 'sess-live' ? { id, session: fakeSession([answered(1, 'awake')]) } : undefined) },
    }
    const read = readStandingConversation(ctx, { path: home.path })
    assert.equal(read.state, 'live')
    assert.deepEqual(read.messages.map((message) => message.text), ['awake'])
  } finally {
    home.clean()
  }
})

test('the first use after a restart resumes the same conversation instead of making another', async () => {
  const home = tempHome()
  try {
    writeFileSync(home.path, JSON.stringify({ sessionId: 'sess-keep' }))
    const calls = []
    const ctx = {
      agents: {
        get: () => undefined,
        resume: async (options) => {
          calls.push(options.resumeSessionId)
          return { agent: { id: 'sess-keep', followup: () => {} }, dispose: async () => {} }
        },
        create: async () => { throw new Error('must not create a second conversation') },
      },
    }
    const got = await ensureConversation(ctx, { path: home.path })
    assert.equal(got.state, 'resumed')
    assert.equal(got.sessionId, 'sess-keep')
    assert.deepEqual(calls, ['sess-keep'])
  } finally {
    home.clean()
  }
})

test('a conversation is born once, and its id is written down before it is used', async () => {
  const home = tempHome()
  try {
    const seen = []
    const ctx = {
      agents: {
        get: () => undefined,
        create: async (options) => {
          seen.push(options)
          assert.equal(readConversationRecord(home.path), null, 'the id is written only after the host accepted it')
          return { agent: { id: options.sessionId, followup: () => {} }, dispose: async () => {} }
        },
      },
    }
    const got = await ensureConversation(ctx, { cwd: 'D:\\Projects', path: home.path })
    assert.equal(got.state, 'created')
    assert.match(got.sessionId, /^[0-9a-f-]{36}$/)
    assert.equal(seen.length, 1)
    assert.deepEqual(seen[0].meta, { cwd: 'D:\\Projects' })
    assert.equal(readConversationRecord(home.path).sessionId, got.sessionId, 'the same id is reused next time')
  } finally {
    home.clean()
  }
})

test('speaking into the conversation is a human turn, delivered through the agent it is spoken to', () => {
  const sent = []
  const agent = { id: 'sess-1', followup: (message) => sent.push(message) }
  const id = sayInConversation(agent, '  are you awake?  ', { now: 1234 })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].role, 'user')
  assert.deepEqual(sent[0].source, { kind: 'user' })
  assert.equal(sent[0].content[0].text, 'are you awake?', 'the message is trimmed, not sent with padding')
  assert.match(id, /^den-say-1234-/)

  assert.throws(() => sayInConversation(agent, '   '), /nothing to say/)
  assert.throws(() => sayInConversation(null, 'hello'), /no live agent/)
  assert.throws(() => sayInConversation({ id: 'x' }, 'hello'), /no live agent/)
})

test('a block that is not text contributes nothing, whatever shape it arrives in', () => {
  assert.equal(textOfMessage(null), '')
  assert.equal(textOfMessage({ content: 'not an array' }), '')
  assert.equal(textOfMessage({ content: [{ type: 'image' }, { type: 'text', text: 'kept' }] }), 'kept')
})

test('a message is appended to the session log, not only queued for the agent', () => {
  const appended = []
  const delivered = []
  const agent = {
    session: {
      append(type, data, opts) {
        appended.push({ type, data, opts })
      },
    },
    followup(message) {
      delivered.push(message)
    },
  }
  const id = sayInConversation(agent, '  hello  ', { id: 'm-1', now: 5 })
  assert.equal(id, 'm-1')
  assert.equal(appended.length, 1, 'the transcript is the log: a queued prompt writes no event')
  assert.equal(appended[0].type, 'user/message')
  assert.deepEqual(appended[0].opts, { surfaceOp: 'append' }, 'a surface event is appended, not replaced')
  assert.equal(appended[0].data.content[0].text, 'hello', 'trimmed, and this text is what den reads')
  assert.equal(appended[0].data.role, 'user')
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0], appended[0].data, 'one message, logged and queued — not two that can drift')
})

test('a session that cannot take an append still receives the turn', () => {
  const delivered = []
  const agent = { session: { snapshotEvents: () => [] }, followup: (message) => delivered.push(message) }
  sayInConversation(agent, 'hi')
  assert.equal(delivered.length, 1, 'delivery must not depend on the session shape')
  assert.equal(appendToSession(agent.session, {}), false, 'and it says so rather than pretending')
})

test('a conversation with no session at all is still spoken into', () => {
  const delivered = []
  sayInConversation({ followup: (message) => delivered.push(message) }, 'hi')
  assert.equal(delivered.length, 1)
})
