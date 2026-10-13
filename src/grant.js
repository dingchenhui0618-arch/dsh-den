/**
 * Human authorization for dsh-den.
 *
 * Core rule: autonomy is only ever granted by a **direct human request**, and the
 * grant is bound to the *host-attested* session event that carried it. A timer,
 * an automatic continuation round, a subagent, or a script can never confer or
 * revoke authority — such an attempt fails the authentication check below.
 *
 * Failure policy is deliberate: a missing, stale, foreign, or corrupt record
 * degrades to "not authorized" instead of throwing. Throwing would turn one bad
 * file into a denial of service; trusting it would turn one bad file into a
 * privilege escalation. Degrading is the only option that is both safe and
 * recoverable.
 */

import { denPath, digest, readJsonChecked, writeJsonAtomic } from './atom.js'

const SCHEMA_VERSION = 1

function grantPath(sessionId) {
  return denPath('grants', `${digest(sessionId)}.json`)
}

/**
 * Read the complete immutable session log through whichever surface this DSH
 * build exposes. Installed hosts may offer `snapshotEvents()`; a source checkout
 * exposes the `events` getter. Both preserve their receiver when called.
 */
export function sessionEvents(session) {
  if (!session) return []
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents() ?? []
  return session.events ?? []
}

function isValidRecord(value) {
  return (
    !!value &&
    value.version === SCHEMA_VERSION &&
    typeof value.sessionId === 'string' &&
    typeof value.autonomy === 'boolean' &&
    typeof value.humanMessageId === 'string' &&
    Number.isSafeInteger(value.humanSeq) &&
    Number.isSafeInteger(value.recordedAfterSeq)
  )
}

/**
 * Every human message in the *current turn*.
 *
 * The turn boundary matters: a grant must be justified by a message in the turn that is
 * asking for it, not by some earlier message that happened to have a matching id.
 */
function currentTurnHumanMessages(agent) {
  const events = sessionEvents(agent.session)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/end') break
    if (event?.type === 'turn/start') {
      return events
        .slice(index + 1)
        .filter((item) => item?.type === 'user/message' && item.data?.source?.kind === 'user')
    }
  }
  return []
}

/** The message the caller cites by id, if the current turn contains it. */
function citedHumanMessage(agent, messageId) {
  if (typeof messageId !== 'string' || !messageId) return undefined
  return currentTurnHumanMessages(agent).find((item) => item.data?.id === messageId)
}

/**
 * Every text fragment a message carries, whatever block shape this Host uses.
 *
 * Deliberately permissive about the envelope and strict about the claim: the caller is
 * asking "did a human type this token", and a Host that wraps text in a block, a string, or
 * a nested structure should still be readable rather than silently unreadable. An unreadable
 * message fails the grant, which is the safe direction.
 */
function messageText(event) {
  const data = event?.data
  if (!data) return ''
  const parts = []
  if (typeof data.text === 'string') parts.push(data.text)
  const blocks = data.content
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      if (typeof block === 'string') parts.push(block)
      else if (block && typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/**
 * Authenticate that the calling context is a direct human driver of this agent.
 *
 * This is the gate every grant/revoke path must pass. It intentionally checks the
 * live registry and status rather than trusting the caller's own claim.
 */
export function isDirectHumanDriver(ctx, agent, messageId) {
  return driverIsLiveDirectHuman(ctx, agent) && citedHumanMessage(agent, messageId) !== undefined
}

/**
 * The half of the driver check that does not depend on which message is cited.
 *
 * Split out because the token path resolves its message *from the token* rather than from
 * an id, and it still has to clear every one of these checks.
 */
function driverIsLiveDirectHuman(ctx, agent) {
  const agents = ctx?.agents
  if (!agents || !agent?.session) return false
  if (typeof agents.get === 'function' && agents.get(agent.id) !== agent) return false
  if (typeof agents.currentInitiator === 'function' && agents.currentInitiator() !== agent) return false
  if (agent.status !== 'running') return false
  if (typeof agents.roots === 'function' && !agents.roots().includes(agent)) return false
  return true
}

/**
 * Which human message the caller means.
 *
 * A caller may cite an id, but a model driving a tool call has no reliable way to *know*
 * the id of the message it is answering — and requiring one made the flow impossible to
 * complete in practice even though every other part of it worked. So the token may stand in
 * for the id: it is a 32-character random string that only a human who read the panel can
 * type, which makes "the current turn contains a human message quoting this token" both
 * sufficient and unforgeable.
 */
function resolveCitedMessage(agent, humanMessageId, requireToken) {
  const byId = citedHumanMessage(agent, humanMessageId)
  if (byId) return byId
  if (typeof requireToken !== 'string' || !requireToken) return undefined
  return currentTurnHumanMessages(agent).find((item) => messageText(item).includes(requireToken))
}

/**
 * Record a grant or revocation, tying it to the human message that carried it.
 *
 * `requireToken` is the second factor the panel has always promised and never checked. The
 * panel's own copy reads *"paste this token to the assistant in the conversation; it will
 * grant access with this message as proof"*, while this function used to inspect only the
 * message **id** and never its content — so the token was decorative on every path that
 * could actually grant, and what really stood in the way was the approval gate. Passing the
 * outstanding token here makes the message's **text** part of the proof: an agent can mint a
 * token and can cite a message id, but it cannot author a `user/message`, so it cannot
 * manufacture the evidence this now requires.
 *
 * @throws when the caller is not an authenticated direct human driver, or when a token was
 * required and the cited message does not carry it. Grant and revocation are the only two
 * operations allowed to throw here, because a caller lying about authority is a programming
 * error, not a runtime condition.
 */
export function recordGrant(ctx, agent, autonomy, humanMessageId, { requireToken } = {}) {
  if (!driverIsLiveDirectHuman(ctx, agent)) {
    throw new Error('dsh-den: autonomy requires a direct human request')
  }

  const citedById = citedHumanMessage(agent, humanMessageId)
  // A cited id that is not a human message in this turn is a forgery, and saying so is more
  // useful than the generic refusal. Checked before the token so the two factors stay
  // independently diagnosable.
  if (!citedById && typeof humanMessageId === 'string' && humanMessageId) {
    throw new Error('dsh-den: autonomy requires a direct human request')
  }

  const tokenRequired = typeof requireToken === 'string' && requireToken
  if (citedById && tokenRequired && !messageText(citedById).includes(requireToken)) {
    throw new Error('dsh-den: the cited human message does not carry the panel token, so it is not the proof it claims to be')
  }

  const human = citedById ?? resolveCitedMessage(agent, humanMessageId, requireToken)
  if (!human) {
    throw new Error(
      tokenRequired
        ? 'dsh-den: no human message in this turn carries the panel token, so there is nothing to grant against'
        : 'dsh-den: autonomy requires a direct human request',
    )
  }
  const citedMessageId = human.data.id
  const record = {
    version: SCHEMA_VERSION,
    sessionId: agent.session.id,
    autonomy,
    humanMessageId: citedMessageId,
    humanSeq: human.seq,
    recordedAfterSeq: sessionEvents(agent.session).at(-1)?.seq ?? human.seq,
    updatedAt: Date.now(),
  }
  writeJsonAtomic(grantPath(record.sessionId), record)
  return record
}

/**
 * Resolve the current authority for a session, given its log.
 *
 * Authority is a property of the *conversation*, not of the process that happens to be
 * driving it: the grant names a session and a human message, and the transcript is the
 * proof. So the gate can answer the question from a session alone, without a live driver
 * — which matters, because the heartbeat has none, and cold-resuming a conversation
 * merely to discover that it was never authorized would spend a driver on every refusal.
 *
 * @returns {boolean|undefined} `true`/`false` from a verified record, or `undefined`
 * when nothing trustworthy is on file.
 */
export function currentGrantForSession(session) {
  const sessionId = session?.id
  if (!sessionId) return undefined

  const result = readJsonChecked(grantPath(sessionId), isValidRecord)
  if (!result.ok) return undefined

  const record = result.value
  if (record.sessionId !== sessionId) return undefined

  // The bound human message must still exist in the immutable log with the same
  // sequence and a human source. A record whose proof is gone is not authority.
  const events = sessionEvents(session)
  const attested = events.some(
    (event) =>
      event?.seq === record.humanSeq &&
      event?.type === 'user/message' &&
      event.data?.id === record.humanMessageId &&
      event.data?.source?.kind === 'user',
  )
  if (!attested) return false

  return record.autonomy
}

/** Convenience predicate; anything other than a verified `true` is not autonomy. */
export function hasAutonomyForSession(session) {
  return currentGrantForSession(session) === true
}

/**
 * Resolve the current authority for an agent.
 *
 * @returns {boolean|undefined} `true`/`false` from a verified record, or
 * `undefined` when nothing trustworthy is on file. Callers must treat
 * `undefined` as "not authorized".
 */
export function currentGrant(agent) {
  return currentGrantForSession(agent?.session)
}

/** Convenience predicate; anything other than a verified `true` is not autonomy. */
export function hasAutonomy(agent) {
  return currentGrant(agent) === true
}

/** Revocation must always win over any automated re-arming. */
export function revokeGrant(ctx, agent, humanMessageId) {
  return recordGrant(ctx, agent, false, humanMessageId)
}
