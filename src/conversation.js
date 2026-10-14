/**
 * The den's own standing conversation.
 *
 * A conversation of its own, not a view of yours: den wakes, works and speaks here whether or not
 * anybody is looking, and the human can open the window and talk into it directly.
 *
 * ## What this module is careful about
 *
 * **It is created through the agent lifecycle.** The host says of `sessions` that a session
 * published outside the lifecycle "persists nothing", and `agents.create` is documented as the call
 * that "constructs the agent and its session". So the standing conversation is born as an agent, and
 * the id is generated once and written to den's own home, so the same conversation is resumed rather
 * than recreated after a restart.
 *
 * **Reading never creates anything.** Opening the window must not charge a turn, so
 * `readStandingConversation` only ever reads: a live agent if there is one, the persisted session
 * otherwise, and nothing at all if the conversation has never existed.
 *
 * **The context is finite and this module never claims otherwise.** DSH compacts a long
 * conversation; what accumulates without bound is the stored transcript, which this module reads and
 * never deletes. `truncated` in the read result is the honest signal that it is showing a tail.
 */

import { randomUUID } from 'node:crypto'
import { denPath, readJson, writeJsonAtomic } from './atom.js'
import { sessionEvents } from './grant.js'

/** How many messages the window is handed by default. The transcript itself keeps everything. */
export const DEFAULT_READ_LIMIT = 40

/** den's own home, where the id of the standing conversation is kept. */
export function conversationPath() {
  return denPath('conversation.json')
}

/**
 * The id of the standing conversation, if one has ever been created.
 *
 * Returns `null` rather than inventing one: an id that was never published names nothing.
 */
export function readConversationRecord(path = conversationPath()) {
  const record = readJson(path)
  if (!record || typeof record.sessionId !== 'string' || !record.sessionId) return null
  return record
}

/** The text of one message, ignoring every block that is not text (tool traffic, reasoning). */
export function textOfMessage(message) {
  const content = message && Array.isArray(message.content) ? message.content : []
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * The conversation as messages, oldest first.
 *
 * Only what the human would call the conversation: what was said to den and what den said back. Tool
 * calls and results are deliberately left out — they are the machinery of a turn, not something to
 * read in a small window.
 */
export function readConversation(session, { limit = DEFAULT_READ_LIMIT } = {}) {
  const events = sessionEvents(session)
  const all = []
  for (const event of events) {
    const role =
      event?.type === 'user/message' ? 'user' : event?.type === 'assistant/message' ? 'assistant' : ''
    if (!role) continue
    const message = role === 'user' ? event.data : event.data && event.data.message
    const text = textOfMessage(message)
    if (!text) continue
    all.push({ role, text, seq: Number(event.seq) || 0, time: Number(event.time) || 0 })
  }
  const wanted = Math.max(1, Number(limit) || DEFAULT_READ_LIMIT)
  const messages = all.slice(-wanted)
  return { messages, total: all.length, truncated: messages.length < all.length }
}

/**
 * Read the standing conversation without creating one.
 *
 * `state` is one of:
 *   - `absent`   — it has never been created; the window should offer to start it;
 *   - `stored`   — the id exists and the transcript was read from the persisted session;
 *   - `live`     — an agent is running on it right now;
 *   - `unreadable` — the id exists but this host cannot hand back its events.
 */
export function readStandingConversation(ctx, { limit = DEFAULT_READ_LIMIT, path = conversationPath() } = {}) {
  const record = readConversationRecord(path)
  if (!record) return { sessionId: null, state: 'absent', messages: [], total: 0, truncated: false }
  const live = typeof ctx?.agents?.get === 'function' ? ctx.agents.get(record.sessionId) : undefined
  const session = live?.session ?? (typeof ctx?.sessions?.get === 'function' ? ctx.sessions.get(record.sessionId) : null)
  if (!session) return { sessionId: record.sessionId, state: 'unreadable', messages: [], total: 0, truncated: false }
  const read = readConversation(session, { limit })
  return Object.assign({ sessionId: record.sessionId, state: live ? 'live' : 'stored' }, read)
}

/**
 * Put a message in the standing conversation, and wake den to answer it.
 *
 * This is the mechanism the host documents for exactly this: "`followup()` queues an ordinary
 * next-turn prompt and wakes the driver". It is a human turn, not a self-initiated one, so it is not
 * charged against the daily budget — the budget exists to ration what den starts by itself.
 */
/**
 * Say something into the standing conversation the way the GUI says something into any session.
 *
 * `sessionController.prompt` is the host's admission path — "Admit one prompt after explicitly
 * resuming its Session" — and it is the same call the human's own composer makes, so the sentence
 * becomes a `user/message` event AND starts a turn. Returns the name of the path it used, or null
 * when this host has no session controller, so the caller can fall back deliberately.
 */
export async function promptConversation(ctx, sessionId, text, { requestId = '', now = Date.now(), signal = null } = {}) {
  const body = String(text ?? '').trim()
  if (!body) throw new Error('dsh-den: there is nothing to say')
  if (typeof ctx?.sessionController?.prompt !== 'function') return null
  if (!sessionId) throw new Error('dsh-den: the standing conversation has no id to speak into')
  const abort = signal || (typeof AbortController === 'function' ? new AbortController().signal : undefined)
  await ctx.sessionController.prompt(
    {
      requestId: requestId || `den-say-${now}-${randomUUID().slice(0, 8)}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: body }],
    },
    abort,
  )
  return 'prompt'
}

/**
 * The fallback: queue the turn on a live agent and write the event ourselves.
 *
 * Kept because it is the only delivery this plugin can attempt when the host exposes no session
 * controller, but it is NOT the documented path: `Agent` declares only `id`, so `followup` may not
 * exist at all, and a queued prompt writes no session event by itself. That is why the append is
 * here and not on the admitted path — there, the host owns the transcript write.
 */
export function sayInConversation(agent, text, { id = '', now = Date.now() } = {}) {
  const body = String(text ?? '').trim()
  if (!body) throw new Error('dsh-den: there is nothing to say')
  if (!agent || typeof agent.followup !== 'function') {
    throw new Error('dsh-den: the standing conversation has no live agent to speak into')
  }
  const message = {
    id: id || `den-say-${now}-${randomUUID().slice(0, 8)}`,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: body }],
  }
  // Both halves, and the order matters to nobody but the transcript does. `followup` queues an
  // ordinary next-turn prompt and wakes the driver; it does NOT write a session event. The append
  // is what makes the message part of the conversation at all — the log the window reads, the log
  // that survives a restart, the log ④ promises accumulates. Without it the first real message left
  // a live agent, a stored id and an empty transcript, which is exactly what 2026-10-14 produced.
  appendToSession(agent.session, message)
  agent.followup(message)
  return message.id
}

/**
 * Append one user message to the session log, when the host handed us a session that can take it.
 *
 * Deliberately tolerant: an older host, or a session stand-in, may have no `append`. Delivery must
 * not depend on it — a conversation with no transcript is still better than a human whose message
 * was silently dropped.
 */
export function appendToSession(session, message) {
  if (!session || typeof session.append !== 'function') return false
  session.append('user/message', message, { surfaceOp: 'append' })
  return true
}

/**
 * Get the standing conversation, creating it on first use.
 *
 * `state` reports which of the three things happened, because they are not the same event:
 * `live` (already running), `resumed` (loaded from disk by the host), `created` (born now).
 */
export async function ensureConversation(ctx, { cwd = '', path = conversationPath() } = {}) {
  const record = readConversationRecord(path)
  if (record) {
    const live = typeof ctx?.agents?.get === 'function' ? ctx.agents.get(record.sessionId) : undefined
    if (live) return { agent: live, sessionId: record.sessionId, state: 'live', handle: null }
    if (typeof ctx?.agents?.resume !== 'function') {
      throw new Error('dsh-den: this host cannot resume the standing conversation')
    }
    const handle = await ctx.agents.resume({ resumeSessionId: record.sessionId })
    return { agent: handle.agent, sessionId: record.sessionId, state: 'resumed', handle }
  }

  if (typeof ctx?.agents?.create !== 'function') {
    throw new Error('dsh-den: this host cannot create the standing conversation')
  }
  // The id is generated here and written before the turn is used, so a crash between the two leaves
  // either no conversation or one that is resumed — never a second, silently different one.
  const sessionId = randomUUID()
  const handle = await ctx.agents.create({ sessionId, meta: cwd ? { cwd } : undefined })
  writeJsonAtomic(path, { sessionId, createdAt: Date.now() })
  return { agent: handle.agent, sessionId, state: 'created', handle }
}
