import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { createDeliver } = await import('../src/index.js')

/** A host with agents, and a wake whose own conversation no longer exists. */
function hostWithStanding({ events, sent, created, conversationPath, createFails = false }) {
  return {
    ctx: {
      get: (name) =>
        name === 'sessions' ? { get: () => ({ snapshotEvents: () => events }) } : undefined,
      agents: {
        get: () => undefined,
        create: async (options) => {
          if (createFails) throw new Error('this host refuses to create a conversation')
          created.push(options.sessionId)
          return {
            agent: {
              id: options.sessionId,
              session: { snapshotEvents: () => events },
              followup: (message) => {
                sent.push(message)
                // The wake's own reply, landing in the transcript after the splice — which is the
                // only place the delivery path can read it back from.
                events.push({
                  type: 'assistant/message',
                  seq: 1,
                  time: Date.now(),
                  data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'nothing is on fire' }] } },
                })
              },
            },
          }
        },
      },
    },
    service: { noteEvent: () => {}, conversationPath },
  }
}

test("a wake whose own conversation is gone runs in den's standing conversation", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-den-wake-'))
  const conversationPath = join(dir, 'conversation.json')
  const events = []
  const sent = []
  const created = []
  const notes = []
  const { ctx, service } = hostWithStanding({ events, sent, created, conversationPath })
  service.noteEvent = (event) => notes.push(event)

  const reply = await createDeliver(ctx, service)({
    trigger: { id: 't1', sessionId: 'session-gone', title: 'check', prompt: 'look' },
    instruction: 'go',
    agent: null,
  })

  assert.equal(reply, 'nothing is on fire', 'the reply was read from the standing conversation')
  assert.equal(created.length, 1, 'the standing conversation was created through the agent lifecycle')
  assert.equal(sent.length, 1, 'exactly one turn was queued')
  assert.match(sent[0].id, /^den-wake-t1-/, 'and it is identifiable as this wake')
  assert.ok(
    notes.some((event) => event.type === 'wake-standing'),
    'that the check ran somewhere else is recorded, not silent',
  )
  assert.ok(!notes.some((event) => event.type === 'wake-unavailable'), 'and it is not reported as unreachable')
  assert.equal(
    JSON.parse(readFileSync(conversationPath, 'utf8')).sessionId,
    created[0],
    'the conversation the host accepted is the one kept on disk',
  )
  rmSync(dir, { recursive: true, force: true })
})

test('a host that cannot create one still reports the wake as unreachable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-den-wake-'))
  const notes = []
  const { ctx, service } = hostWithStanding({
    events: [],
    sent: [],
    created: [],
    conversationPath: join(dir, 'conversation.json'),
    createFails: true,
  })
  service.noteEvent = (event) => notes.push(event)

  await assert.rejects(
    createDeliver(ctx, service)({
      trigger: { id: 't2', sessionId: 'session-gone', title: 'check', prompt: 'look' },
      instruction: 'go',
      agent: null,
    }),
    /no delivery path/,
    'the fallback must not turn a failure into a reported success',
  )
  assert.ok(notes.some((event) => event.type === 'wake-unavailable'))
  rmSync(dir, { recursive: true, force: true })
})
