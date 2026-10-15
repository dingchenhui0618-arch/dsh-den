/**
 * A standing conversation whose session the host has not published still has a transcript, and the
 * window has to be able to read it: an agent that has answered is then disposed, so `sessions.get`
 * answers nothing and the honest state would be `unreadable` forever.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const { encodeCwd, readTranscriptFromLog, transcriptFromEvents } = await import('../src/session-log.js')
const { readStandingConversation } = await import('../src/conversation.js')

function frame(events) {
  return zstdCompressSync(Buffer.from(events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8'))
}

/** A session store with one session in it, written the way the host writes it. */
function withLog(run, { turns = [] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-den-log-'))
  try {
    const cwd = 'C:\\Users\\someone\\project'
    const sessionId = 'sess-log-1'
    const dir = join(home, 'sessions', encodeCwd(cwd), sessionId)
    mkdirSync(dir, { recursive: true })
    const header = [{ type: 'session', seq: 0, cwd, agentPreset: 'cordis' }]
    const body = turns.flatMap((turn, index) => [
      { type: 'user/message', seq: index * 3 + 1, data: { content: [{ type: 'text', text: turn.ask }] } },
      { type: 'assistant/message', seq: index * 3 + 2, data: { message: { content: [{ type: 'text', text: turn.answer }] } } },
      { type: 'turn/end', seq: index * 3 + 3, data: { reason: turn.reason || { kind: 'completed' } } },
    ])
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([frame(header), frame(body)]))
    return run({ home, cwd, sessionId, dir })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('the cwd encoding is the one the store uses, dots and all', () => {
  assert.equal(encodeCwd('C:\\Users\\123\\.dsh\\den'), '--C-Users-123-.dsh-den--')
})

test('a transcript is read out of a log the host never published', () => {
  withLog(({ home, cwd, sessionId }) => {
    const read = readTranscriptFromLog(sessionId, { cwd, sessionsRoot: join(home, 'sessions') })
    assert.deepEqual(read.messages.map((m) => m.role + ':' + m.text), ['user:你好', 'assistant:你好。'])
    assert.equal(read.lastError, '')
  }, { turns: [{ ask: '你好', answer: '你好。' }] })
})

test('two frames are two writes, and both are read', () => {
  withLog(({ home, cwd, sessionId }) => {
    const read = readTranscriptFromLog(sessionId, { cwd, sessionsRoot: join(home, 'sessions') })
    assert.equal(read.total, 4, 'a one-frame reader would see half of this')
  }, { turns: [{ ask: 'one', answer: 'first' }, { ask: 'two', answer: 'second' }] })
})

test('a turn that ended in an error is still explained, even with no message of its own', () => {
  const events = [
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'hello' }] } },
    { type: 'turn/end', seq: 2, data: { reason: { kind: 'error', error: { message: 'prompt variable "{{cwd}}" has no value' } } } },
  ]
  const read = transcriptFromEvents(events)
  assert.match(read.lastError, /prompt variable/)
  assert.equal(read.messages.length, 1)
})

test('the window reads that log when the store has nothing, and says where it read it', () => {
  withLog(({ home, cwd, sessionId }) => {
    const recordPath = join(home, 'conversation.json')
    writeFileSync(recordPath, JSON.stringify({ sessionId, createdAt: 1, agentPreset: 'cordis', cwd }))
    const ctx = { sessions: { get: () => undefined }, agents: { get: () => undefined } }
    const state = readStandingConversation(ctx, { path: recordPath, sessionsRoot: join(home, 'sessions') })
    assert.equal(state.state, 'stored')
    assert.equal(state.readFrom, 'log')
    assert.deepEqual(state.messages.map((m) => m.text), ['你好', '你好。'])
  }, { turns: [{ ask: '你好', answer: '你好。' }] })
})

test('with no log and no store, it is unreadable rather than an empty conversation', () => {
  withLog(({ home, sessionId }) => {
    const recordPath = join(home, 'conversation.json')
    writeFileSync(recordPath, JSON.stringify({ sessionId: 'never-written', createdAt: 1, agentPreset: 'cordis' }))
    const ctx = { sessions: { get: () => undefined } }
    const state = readStandingConversation(ctx, { path: recordPath })
    assert.equal(state.state, 'unreadable')
    assert.equal(state.readFrom, 'none')
  })
})
