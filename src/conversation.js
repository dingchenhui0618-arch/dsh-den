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
import { serviceOf, sessionEvents } from './grant.js'
import { readTranscriptFromLog } from './session-log.js'

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
export function readStandingConversation(
  ctx,
  { limit = DEFAULT_READ_LIMIT, path = conversationPath(), sessionsRoot } = {},
) {
  const record = readConversationRecord(path)
  if (!record) return { sessionId: null, state: 'absent', messages: [], total: 0, truncated: false, lastError: '' }
  const agents = serviceOf(ctx, 'agents')
  const sessions = serviceOf(ctx, 'sessions')
  const live = typeof agents?.get === 'function' ? agents.get(record.sessionId) : undefined
  const session = live?.session ?? (typeof sessions?.get === 'function' ? sessions.get(record.sessionId) : null)
  if (session) {
    const read = readConversation(session, { limit })
    return Object.assign({ sessionId: record.sessionId, state: live ? 'live' : 'stored', readFrom: 'store' }, read)
  }
  // The Host does not publish a session it has not resumed, so an agent that has finished leaves
  // `sessions.get` answering nothing while the whole conversation sits in the log on disk. Measured:
  // the window read `unreadable`, `messages: []`, while the log held two completed turns and both
  // answers. Reading the log is what makes the window show the conversation instead of a blank.
  const fromLog = readTranscriptFromLog(record.sessionId, { cwd: record.cwd, limit, sessionsRoot })
  if (fromLog) {
    return Object.assign({ sessionId: record.sessionId, state: 'stored', readFrom: 'log' }, fromLog)
  }
  return {
    sessionId: record.sessionId,
    state: 'unreadable',
    readFrom: 'none',
    messages: [],
    total: 0,
    truncated: false,
    lastError: '',
  }
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
  // `serviceOf`, not a dot access: this very guard threw on a Cordis context whose controller is not
  // injected, so the honest "this host cannot admit prompts" answer never got a chance to be given.
  const controller = serviceOf(ctx, 'sessionController')
  if (typeof controller?.prompt !== 'function') return null
  if (!sessionId) throw new Error('dsh-den: the standing conversation has no id to speak into')
  const abort = signal || (typeof AbortController === 'function' ? new AbortController().signal : undefined)
  await controller.prompt(
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
  if (!agent) throw new Error('dsh-den: the standing conversation has no live agent to speak into')
  const message = {
    id: id || `den-say-${now}-${randomUUID().slice(0, 8)}`,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: body }],
  }
  // The transcript first. Whatever happens after this, what the human said is part of the
  // conversation: this is the log the window reads, the log that survives a restart, the log ④
  // promises accumulates. Without it a real message once left a live agent, a stored id and an empty
  // transcript.
  const written = appendToSession(agent.session, message)
  // Then the wake-up, and here the declaration is blunt: `Agent` is `{ readonly id }`. There is no
  // documented way for a plugin to hand a message to a live agent, so if this host happens to expose
  // a followup it is used, and if it does not, that is said out loud rather than dressed up as
  // delivery. `ctx.subagents.sendMessage` is not the answer either: it steers only to a direct parent
  // or a direct continuable child and rejects any other target, and the standing conversation is
  // neither. The admitted path above is the one the host documents for this — the call the human's own
  // composer makes.
  if (typeof agent.followup === 'function') {
    agent.followup(message)
    return message.id
  }
  throw new Error(
    written
      ? 'dsh-den: the message is in the transcript, but this host exposes no way to wake the standing conversation'
      : 'dsh-den: this host exposes no way to wake the standing conversation',
  )
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
  const service = serviceOf(ctx, 'agentDefaultModel')
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
  const service = serviceOf(ctx, 'agentPresets')
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
 * Where the standing conversation works.
 *
 * The deployment persona is a template — "You are a coding agent powered by the {{model}} model." and
 * "Your working directory is {{cwd}}." — and the host resolves it strictly against registered prompt
 * variables, so a session with no cwd cannot assemble a prompt at all: the turn dies before the model
 * is called. That is measured, not theoretical: with the model supplied, the next failure on this host
 * was 'prompt variable "{{cwd}}" has no value for this assembly (section "deployment:persona-suffix")'.
 *
 * The human's own session is the honest source, because den should work where they work. That session
 * may not be published in the store yet, so `sessionQuery.observeSession` is the second attempt — it is
 * how the host itself reads a header, down to `observation.header.cwd`. Den's own home is the last
 * resort: any absolute directory is better than a conversation that can never answer, and which source
 * was used is written into the record so it is never a mystery.
 */
export async function resolveWorkspaceCwd(ctx, { configured = '', sessionId = '' } = {}) {
  if (typeof configured === 'string' && configured && isAbsolute(configured)) {
    return { cwd: configured, source: 'config' }
  }
  const sessions = serviceOf(ctx, 'sessions')
  const published = sessionId && typeof sessions?.get === 'function' ? sessions.get(sessionId) : null
  for (const candidate of [published?.header?.cwd, published?.meta?.cwd, published?.cwd]) {
    if (typeof candidate === 'string' && candidate && isAbsolute(candidate)) {
      return { cwd: candidate, source: 'session' }
    }
  }
  const query = serviceOf(ctx, 'sessionQuery')
  if (sessionId && query && typeof query.observeSession === 'function') {
    let observation = null
    try {
      observation = await query.observeSession(sessionId)
      const cwd = observation?.header?.cwd
      if (typeof cwd === 'string' && cwd && isAbsolute(cwd)) return { cwd, source: 'session' }
    } catch (error) {
      /* an observation this host will not make is not a workspace */
    } finally {
      try {
        if (typeof observation?.dispose === 'function') await observation.dispose()
        else if (typeof observation?.[Symbol.dispose] === 'function') observation[Symbol.dispose]()
      } catch (error) {
        /* releasing is best effort */
      }
    }
  }
  return { cwd: denPath(), source: 'den-home' }
}

/**
 * Get the standing conversation, creating it on first use.
 *
 * `state` reports which of them happened, because they are not the same event: `live` (already
 * running), `resumed` (loaded from disk by the host), `created` (born now, possibly replacing a
 * record that could never work — see `replaced`).
 */
export async function ensureConversation(ctx, { cwd = '', sessionId = '', path = conversationPath() } = {}) {
  const preset = await resolveAgentPreset(ctx)
  const agentOptions = resolveAgentOptions(ctx)
  const agents = serviceOf(ctx, 'agents')
  const workspace = await resolveWorkspaceCwd(ctx, { configured: cwd, sessionId })
  const record = readConversationRecord(path)
  // A session created before this plugin knew about presets cannot assemble a prompt at all: the host
  // ends every turn with 'prompt variable "{{model}}" has no value for this assembly'. One created
  // without a cwd cannot either: 'prompt variable "{{cwd}}" has no value … (deployment:persona-suffix)'.
  // A session header is immutable, so resuming either one reproduces its failure forever; they are
  // replaced instead — but only when this host offers a preset, otherwise a recreate would produce an
  // equally dead session on every single call.
  const unusable = Boolean(record && preset && (!record.agentPreset || !record.cwd))
  if (record) {
    const live = typeof agents?.get === 'function' ? agents.get(record.sessionId) : undefined
    // A live agent is proof enough, whatever the record says about presets.
    if (live) {
      return { agent: live, sessionId: record.sessionId, state: 'live', handle: null, agentPreset: record.agentPreset || preset || null, replaced: null }
    }
    if (unusable) {
      // Fall through to creation below.
    } else {
      if (typeof agents?.resume !== 'function') {
        throw new Error('dsh-den: this host cannot resume the standing conversation')
      }
      // Carried on resume too: a resumed session assembles prompts like any other, and the options
      // are the host's current selection, so a model change is picked up on the next start.
      const handle = await agents.resume({
        resumeSessionId: record.sessionId,
        ...(agentOptions ? { agentOptions } : {}),
      })
      return { agent: handle.agent, sessionId: record.sessionId, state: 'resumed', handle, agentPreset: record.agentPreset || preset || null, replaced: null }
    }
  }

  if (typeof agents?.create !== 'function') {
    throw new Error('dsh-den: this host cannot create the standing conversation')
  }
  // The id is generated here and written before the turn is used, so a crash between the two leaves
  // either no conversation or one that is resumed — never a second, silently different one.
  const newSessionId = randomUUID()
  const meta = {}
  // The session store validates meta.cwd and throws on a non-absolute path, and the prompt needs it:
  // `resolveWorkspaceCwd` therefore always returns an absolute directory, and which source it came from
  // is recorded below. The preset is what makes the conversation able to answer; the cwd is where.
  meta.cwd = workspace.cwd
  if (preset) meta.agentPreset = preset
  const handle = await agents.create({
    sessionId: newSessionId,
    ...(agentOptions ? { agentOptions } : {}),
    meta: Object.keys(meta).length ? meta : undefined,
  })
  writeJsonAtomic(path, {
    sessionId: newSessionId,
    createdAt: Date.now(),
    agentPreset: preset || null,
    cwd: workspace.cwd,
    cwdSource: workspace.source,
    replacedSessionId: unusable ? record.sessionId : undefined,
  })
  return {
    agent: handle.agent,
    sessionId: newSessionId,
    state: 'created',
    handle,
    agentPreset: preset || null,
    cwd: workspace.cwd,
    replaced: unusable ? record.sessionId : null,
  }
}
