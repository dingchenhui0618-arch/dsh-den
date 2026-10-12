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
 * Authenticate that the calling context is a direct human driver of this agent.
 *
 * This is the gate every grant/revoke path must pass. It intentionally checks the
 * live registry and status rather than trusting the caller's own claim.
 */
export function isDirectHumanDriver(ctx, agent, messageId) {
  const agents = ctx?.agents
  if (!agents || !agent?.session) return false
  if (typeof agents.get === 'function' && agents.get(agent.id) !== agent) return false
  if (typeof agents.currentInitiator === 'function' && agents.currentInitiator() !== agent) return false
  if (agent.status !== 'running') return false
  if (typeof agents.roots === 'function' && !agents.roots().includes(agent)) return false
  if (typeof messageId !== 'string' || !messageId) return false

  const events = sessionEvents(agent.session)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/end') break
    if (event?.type === 'turn/start') {
      return events
        .slice(index + 1)
        .some(
          (item) =>
            item?.type === 'user/message' &&
            item.data?.id === messageId &&
            item.data?.source?.kind === 'user',
        )
    }
  }
  return false
}

/**
 * Record a grant or revocation, tying it to the human message that carried it.
 *
 * @throws when the caller is not an authenticated direct human driver. Grant and
 * revocation are the only two operations allowed to throw here, because a caller
 * lying about authority is a programming error, not a runtime condition.
 */
export function recordGrant(ctx, agent, autonomy, humanMessageId) {
  if (!isDirectHumanDriver(ctx, agent, humanMessageId)) {
    throw new Error('dsh-den: autonomy requires a direct human request')
  }
  const events = sessionEvents(agent.session)
  const human = events.find(
    (event) =>
      event?.type === 'user/message' &&
      event.data?.id === humanMessageId &&
      event.data?.source?.kind === 'user',
  )
  const record = {
    version: SCHEMA_VERSION,
    sessionId: agent.session.id,
    autonomy,
    humanMessageId,
    humanSeq: human.seq,
    recordedAfterSeq: events.at(-1)?.seq ?? human.seq,
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
