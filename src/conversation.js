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
import { isAbsolute } from 'node:path'
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
  let lastError = ''
  for (const event of events) {
    // A turn that ends in an error writes no message, so an empty window is otherwise
    // indistinguishable from a conversation that never ran. This is the host's own words, kept short.
    if (event?.type === 'turn/end') {
      const reason = event.data?.reason
      lastError =
        reason?.kind === 'error' && typeof reason.error?.message === 'string' ? reason.error.message.slice(0, 200) : ''
    }
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
  return { messages, total: all.length, truncated: messages.length < all.length, lastError }
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
  if (!record) return { sessionId: null, state: 'absent', messages: [], total: 0, truncated: false, lastError: '' }
  const live = typeof ctx?.agents?.get === 'function' ? ctx.agents.get(record.sessionId) : undefined
  const session = live?.session ?? (typeof ctx?.sessions?.get === 'function' ? ctx.sessions.get(record.sessionId) : null)
  if (!session) return { sessionId: record.sessionId, state: 'unreadable', messages: [], total: 0, truncated: false, lastError: '' }
  const read = readConversation(session, { limit })
  return Object.assign({ sessionId: record.sessionId, state: live ? 'live' : 'stored' }, read)
}

/**
 * Put a message in the standing conversation, and wake den to answer it.
 *
 * The delivery is the admission call below, not a per-agent followup: `Agent` declares only `id`.
 * An earlier comment here credited one anyway, and believing it cost an empty transcript.
 * This is a human turn, not a self-initiated one, so it is not charged against the daily budget —
 * the budget exists to ration what den starts by itself.
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
 * The model a standing conversation should run on: whatever the host is currently using.
 *
 * `agentPreset` alone is not enough, and this was learned by reading the host's own creation path,
 * which passes `agentOptions: { provider, model }` from `agentDefaultModel.currentSelection()` beside
 * `meta.agentPreset` and a preset `setup`. The `{{model}}` a prompt is assembled with comes from
 * those options: a session created with a preset and no options still has no model, and every turn
 * ends in 'prompt variable "{{model}}" has no value for this assembly'. Reading the current selection
 * rather than naming a model means den follows whatever the human has chosen, and follows it when
 * they change it.
 */
export function resolveAgentOptions(ctx) {
  const service = ctx && ctx.agentDefaultModel
  if (!service || typeof service.currentSelection !== 'function') return undefined
  let selection
  try {
    selection = service.currentSelection()
  } catch (error) {
    return undefined
  }
  if (!selection || typeof selection.provider !== 'string' || typeof selection.model !== 'string') return undefined
  if (!selection.provider || !selection.model) return undefined
  return { provider: selection.provider, model: selection.model }
}

/**
 * The preset a standing conversation should be created with: the host's own default.
 *
 * Not a hardcoded name. A session created without a preset has no model to assemble a prompt with —
 * the host ends each turn with 'prompt variable "{{model}}" has no value for this assembly' — so the
 * preset is what makes the conversation capable of answering at all. `agentPresets.list()` is read
 * here, the default is preferred, activation failures are skipped, and an empty string is returned
 * when this host offers no preset service, so the caller can tell no-preset from preset-named-empty.
 */
export async function resolveAgentPreset(ctx) {
  const service = ctx && ctx.agentPresets
  if (!service || typeof service.list !== 'function') return ''
  let presets
  try {
    presets = await service.list()
  } catch (error) {
    return ''
  }
  if (!Array.isArray(presets)) return ''
  const usable = presets.filter((preset) => preset && typeof preset.id === 'string' && preset.id && !preset.broken)
  const chosen = usable.find((preset) => preset.isDefault) || usable[0]
  return chosen ? chosen.id : ''
}

/**
 * Get the standing conversation, creating it on first use.
 *
 * `state` reports which of them happened, because they are not the same event: `live` (already
 * running), `resumed` (loaded from disk by the host), `created` (born now, possibly replacing a
 * record that could never work — see `replaced`).
 */
export async function ensureConversation(ctx, { cwd = '', path = conversationPath() } = {}) {
  const preset = await resolveAgentPreset(ctx)
  const agentOptions = resolveAgentOptions(ctx)
  const record = readConversationRecord(path)
  // A session created before this plugin knew about presets cannot assemble a prompt at all: the host
  // ends every turn with 'prompt variable "{{model}}" has no value for this assembly'. Resuming it
  // reproduces that failure forever, so it is replaced — but only when this host offers a preset,
  // otherwise a recreate would produce an equally dead session on every single call.
  const unusable = Boolean(record && preset && !record.agentPreset)
  if (record) {
    const live = typeof ctx?.agents?.get === 'function' ? ctx.agents.get(record.sessionId) : undefined
    // A live agent is proof enough, whatever the record says about presets.
    if (live) {
      return { agent: live, sessionId: record.sessionId, state: 'live', handle: null, agentPreset: record.agentPreset || preset || null, replaced: null }
    }
    if (unusable) {
      // Fall through to creation below.
    } else {
      if (typeof ctx?.agents?.resume !== 'function') {
        throw new Error('dsh-den: this host cannot resume the standing conversation')
      }
      // Carried on resume too: a resumed session assembles prompts like any other, and the options
      // are the host's current selection, so a model change is picked up on the next start.
      const handle = await ctx.agents.resume({
        resumeSessionId: record.sessionId,
        ...(agentOptions ? { agentOptions } : {}),
      })
      return { agent: handle.agent, sessionId: record.sessionId, state: 'resumed', handle, agentPreset: record.agentPreset || preset || null, replaced: null }
    }
  }

  if (typeof ctx?.agents?.create !== 'function') {
    throw new Error('dsh-den: this host cannot create the standing conversation')
  }
  // The id is generated here and written before the turn is used, so a crash between the two leaves
  // either no conversation or one that is resumed — never a second, silently different one.
  const sessionId = randomUUID()
  const meta = {}
  // The session store validates meta.cwd and throws on a non-absolute path — it keys storage
  // directories off it — so a relative one from configuration is dropped here rather than turning
  // every creation into a host error. The preset is what makes the conversation able to answer at
  // all; the cwd is only where it does it.
  if (cwd && isAbsolute(cwd)) meta.cwd = cwd
  if (preset) meta.agentPreset = preset
  const handle = await ctx.agents.create({
    sessionId,
    ...(agentOptions ? { agentOptions } : {}),
    meta: Object.keys(meta).length ? meta : undefined,
  })
  writeJsonAtomic(path, {
    sessionId,
    createdAt: Date.now(),
    agentPreset: preset || null,
    replacedSessionId: unusable ? record.sessionId : undefined,
  })
  return {
    agent: handle.agent,
    sessionId,
    state: 'created',
    handle,
    agentPreset: preset || null,
    replaced: unusable ? record.sessionId : null,
  }
}
