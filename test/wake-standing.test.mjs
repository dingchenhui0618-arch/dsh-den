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

test('a wake is admitted through the host session controller, with no agent handle at all', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-den-wake-'))
  const conversationPath = join(dir, 'conversation.json')
  const events = []
  const prompts = []
  const created = []
  const ctx = {
    get: (name) => (name === 'sessions' ? { get: () => ({ snapshotEvents: () => events }) } : undefined),
    sessionController: {
      async prompt(request) {
        prompts.push(request)
        // The host owns this write: the message becomes an event and the turn starts from it.
        events.push({
          type: 'user/message',
          seq: 1,
          time: Date.now(),
          data: { role: 'user', content: [{ type: 'text', text: request.content[0].text }] },
        })
        events.push({
          type: 'assistant/message',
          seq: 2,
          time: Date.now(),
          data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'all clear' }] } },
        })
        return { accepted: true }
      },
    },
    agents: {
      get: () => undefined,
      // Not one method beyond the contract: `Agent` declares only `id`, and this proves the
      // admission path never needed more.
      create: async (options) => {
        created.push(options.sessionId)
        return { agent: { id: options.sessionId } }
      },
    },
  }
  const notes = []
  const service = { noteEvent: (event) => notes.push(event), conversationPath }

  const reply = await createDeliver(ctx, service)({
    trigger: { id: 't3', sessionId: 'session-gone', title: 'check', prompt: 'look' },
    instruction: 'go',
    agent: null,
  })

  assert.equal(reply, 'all clear', 'the reply was read back from the transcript the host wrote')
  assert.equal(prompts.length, 1, 'the wake went in through the host, not through an agent handle')
  assert.equal(prompts[0].mode, 'queue')
  assert.equal(prompts[0].sessionId, created[0], 'and into the conversation the host accepted')
  assert.match(prompts[0].content[0].text, /## Scheduled check/, 'with the check the trigger asked for')
  assert.ok(!notes.some((event) => event.type === 'wake-unavailable'))
  rmSync(dir, { recursive: true, force: true })
})

test('a refused admission is recorded, and the agent fallback still delivers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-den-wake-'))
  const events = []
  const sent = []
  const notes = []
  const driver = {
    id: 'session-live',
    session: { snapshotEvents: () => events },
    followup: (message) => {
      sent.push(message)
      events.push({
        type: 'assistant/message',
        seq: 1,
        time: Date.now(),
        data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'fallback spoke' }] } },
      })
    },
  }
  const ctx = {
    get: (name) => (name === 'sessions' ? { get: () => ({ snapshotEvents: () => events }) } : undefined),
    sessionController: {
      prompt: async () => {
        throw new Error('this host will not take a prompt')
      },
    },
    agents: {
      get: () => driver,
      create: async () => {
        throw new Error('not used')
      },
    },
  }
  const service = { noteEvent: (event) => notes.push(event) }

  const reply = await createDeliver(ctx, service)({
    trigger: { id: 't4', sessionId: 'session-live', title: 'check', prompt: 'look' },
    instruction: 'go',
    agent: driver,
  })

  assert.equal(reply, 'fallback spoke')
  const refused = notes.find((event) => event.type === 'wake-admit-failed')
  assert.ok(refused, 'a host that refuses the prompt is recorded, not silently skipped')
  assert.equal(refused.triggerId, 't4')
  assert.match(refused.error, /will not take a prompt/)
  assert.equal(sent.length, 1, 'and the fallback delivered the same wake')
  rmSync(dir, { recursive: true, force: true })
})
