/**
 * Trigger definitions: what the den intends to check, and when it is next due.
 *
 * A trigger is **never** a permission. It only answers "is it time to look?"
 * Whether the den may then *act* is decided by the kernel against live
 * authority, budget, and quiet hours. Keeping the two separate is what makes it
 * safe to hand a durable timer to an assistant with real credentials.
 *
 * Triggers are stored one file each, so a corrupt or hand-edited definition
 * degrades that single trigger instead of the whole schedule.
 */

import { unlinkSync } from 'node:fs'
import { denPath, digest, listJsonFiles, readJson, writeJsonAtomic } from './atom.js'

export const TRIGGER_KINDS = ['once', 'interval', 'daily', 'weekly']

/**
 * Interval triggers may not fire more often than this. A resident assistant that
 * wakes every few seconds is indistinguishable from a runaway loop, and a tight
 * poll is the most reliable way to burn a token budget without producing value.
 */
export const MIN_INTERVAL_SECONDS = 300

/** A bounded prompt keeps one malformed trigger from becoming an unbounded turn. */
export const MAX_PROMPT_CHARS = 8000

export function initTriggerDirectory() {
  return denPath('triggers')
}

function triggerPath(id) {
  return denPath('triggers', `${id}.json`)
}

/** Parse `HH:MM` into minutes since local midnight; `undefined` when malformed. */
export function parseClock(value) {
  if (typeof value !== 'string') return undefined
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return undefined
  return hours * 60 + minutes
}

function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes()
}

/** Local weekday with Monday = 1, matching the stored `weekday` field. */
function localWeekday(date) {
  const day = date.getDay()
  return day === 0 ? 7 : day
}

/**
 * Validate a trigger definition, returning a normalised copy or throwing with a
 * specific reason. Throwing on *creation* is right: a human is present and can
 * fix the input. Reading a stored trigger never throws (see `readTrigger`).
 */
export function normalizeTrigger(input) {
  const fail = (reason) => {
    throw new Error(`dsh-den: invalid trigger (${reason})`)
  }

  if (!input || typeof input !== 'object') fail('not an object')
  const kind = input.kind
  if (!TRIGGER_KINDS.includes(kind)) fail(`unknown kind ${JSON.stringify(kind)}`)

  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (!title) fail('title is required')
  if (title.length > 200) fail('title exceeds 200 characters')

  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  if (!prompt) fail('prompt is required')
  if (prompt.length > MAX_PROMPT_CHARS) fail(`prompt exceeds ${MAX_PROMPT_CHARS} characters`)

  const sessionId = typeof input.sessionId === 'string' ? input.sessionId : ''
  if (!sessionId) fail('sessionId is required: a trigger must know which conversation it belongs to')

  const normalized = {
    version: 1,
    id: typeof input.id === 'string' && input.id ? input.id : digest(`${sessionId}:${title}:${Date.now()}`),
    sessionId,
    kind,
    title,
    prompt,
    createdAt: Date.now(),
    enabled: input.enabled !== false,
    /** Whether a fired result may interrupt the human, or is recorded only. */
    maySpeak: input.maySpeak === true,
    lastFiredAt: null,
    /**
     * Last time a wake was *attempted* and failed to reach the conversation.
     *
     * Kept separate from `lastFiredAt` so a failed delivery can be retried
     * without re-dating the cadence, and so the catch-up step has something to
     * measure against. A trigger that never failed leaves this null.
     */
    lastAttemptAt: null,
    fireCount: 0,
  }

  if (Number.isSafeInteger(input.maxRuns) && input.maxRuns > 0) {
    if (input.maxRuns > 1000) fail('maxRuns exceeds 1000')
    normalized.maxRuns = input.maxRuns
  }

  if (kind === 'once') {
    const at = Number(input.at)
    if (!Number.isFinite(at)) fail('once requires a numeric `at` epoch-millisecond timestamp')
    normalized.at = at
  }

  if (kind === 'interval') {
    const seconds = Number(input.everySeconds)
    if (!Number.isSafeInteger(seconds)) fail('interval requires an integer `everySeconds`')
    if (seconds < MIN_INTERVAL_SECONDS) fail(`everySeconds must be at least ${MIN_INTERVAL_SECONDS}`)
    normalized.everySeconds = seconds
  }

  if (kind === 'daily' || kind === 'weekly') {
    const clock = parseClock(input.atTime)
    if (clock === undefined) fail('requires `atTime` in HH:MM form')
    normalized.atTime = clock
  }

  if (kind === 'weekly') {
    const weekday = Number(input.weekday)
    if (!Number.isSafeInteger(weekday) || weekday < 1 || weekday > 7) {
      fail('weekly requires `weekday` 1..7 (Monday = 1)')
    }
    normalized.weekday = weekday
  }

  return normalized
}

/** Stored triggers that fail validation are reported and skipped, never trusted. */
function isValidStored(value) {
  if (!value || value.version !== 1) return false
  if (typeof value.id !== 'string' || typeof value.sessionId !== 'string') return false
  if (!TRIGGER_KINDS.includes(value.kind)) return false
  if (typeof value.title !== 'string' || typeof value.prompt !== 'string') return false
  if (typeof value.enabled !== 'boolean') return false
  if (!Number.isSafeInteger(value.fireCount)) return false
  return true
}

/**
 * Compute the next instant this trigger is due strictly after `after`.
 *
 * @returns {number|undefined} epoch milliseconds, or `undefined` when the trigger
 * is spent (a `once` in the past, or a trigger that reached `maxRuns`).
 */
export function nextTriggerAt(trigger, after = Date.now()) {
  if (!trigger?.enabled) return undefined
  if (Number.isSafeInteger(trigger.maxRuns) && trigger.fireCount >= trigger.maxRuns) return undefined

  if (trigger.kind === 'once') {
    return trigger.at > after ? trigger.at : undefined
  }

  if (trigger.kind === 'interval') {
    const step = trigger.everySeconds * 1000
    const base = Number.isFinite(trigger.lastFiredAt) ? trigger.lastFiredAt : trigger.createdAt
    // Catch up in whole steps so a host that was down for a while resumes on the
    // original cadence instead of firing a storm of missed occurrences.
    if (base + step > after) return base + step
    const missed = Math.ceil((after - base) / step)
    return base + missed * step
  }

  const step = 24 * 60 * 60 * 1000
  const cursor = new Date(after)
  cursor.setHours(0, 0, 0, 0)

  for (let dayOffset = 0; dayOffset <= 8; dayOffset += 1) {
    const candidate = new Date(cursor.getTime() + dayOffset * step)
    candidate.setMinutes(trigger.atTime)
    if (trigger.kind === 'weekly' && localWeekday(candidate) !== trigger.weekday) continue
    if (candidate.getTime() > after) return candidate.getTime()
  }
  return undefined
}

/** Read one stored trigger; `undefined` when absent or invalid. */
export function readTrigger(id) {
  const value = readJson(triggerPath(id))
  return isValidStored(value) ? value : undefined
}

/** Every valid stored trigger, plus the ids that failed validation. */
export function listTriggers() {
  const valid = []
  const invalid = []
  for (const path of listJsonFiles(initTriggerDirectory())) {
    let value
    try {
      value = readJson(path)
    } catch {
      invalid.push(path)
      continue
    }
    if (isValidStored(value)) valid.push(value)
    else invalid.push(path)
  }
  return { valid, invalid }
}

export function saveTrigger(trigger) {
  writeJsonAtomic(triggerPath(trigger.id), trigger)
  return trigger
}

/** Delete a trigger. Returns whether a file was actually removed. */
export function deleteTrigger(id) {
  if (!readTrigger(id)) return false
  try {
    unlinkSync(triggerPath(id))
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

/**
 * Triggers that are due now, oldest-due first.
 *
 * `due` means the next scheduled instant has already passed, so a host that was
 * shut down overnight still delivers the morning check-in on the next heartbeat
 * rather than skipping it.
 */
export function dueTriggers(now = Date.now()) {
  const { valid } = listTriggers()
  const due = []
  for (const trigger of valid) {
    if (!trigger.enabled) continue
    if (Number.isSafeInteger(trigger.maxRuns) && trigger.fireCount >= trigger.maxRuns) continue
    // An earlier failed attempt deliberately does not advance `lastFiredAt`, so
    // the original cadence stays intact; the retry throttle is applied here so a
    // dead conversation cannot be hammered once per heartbeat.
    if (retryTooSoon(trigger, now)) continue
    const next = nextTriggerAt(trigger, trigger.lastFiredAt ?? 0)
    if (next !== undefined && next <= now) {
      due.push({ trigger, dueAt: next })
    }
  }
  due.sort((a, b) => a.dueAt - b.dueAt)
  return due
}

/**
 * How long to wait before retrying a wake that failed to reach the conversation.
 *
 * Long enough that a broken adapter is not polled every heartbeat, short enough
 * that a transient failure inside a 24h schedule is still retried same-day.
 */
export const FAILED_WAKE_RETRY_MS = 15 * 60 * 1000

/** Whether a failed wake for this trigger is still inside its retry cool-down. */
export function retryTooSoon(trigger, now = Date.now()) {
  if (!Number.isFinite(trigger?.lastAttemptAt)) return false
  // Only throttle when the failure is newer than the last success: a `lastFiredAt`
  // after `lastAttemptAt` means the cadence has moved on and this is a fresh due.
  if (Number.isFinite(trigger.lastFiredAt) && trigger.lastFiredAt > trigger.lastAttemptAt) return false
  return now - trigger.lastAttemptAt < FAILED_WAKE_RETRY_MS
}

/**
 * Record that a trigger fired, advancing its cadence and run count.
 *
 * @param {object} trigger stored trigger
 * @param {number} [at] when the wake was admitted
 */
export function markFired(trigger, at = Date.now()) {
  const next = { ...trigger, lastFiredAt: at, fireCount: trigger.fireCount + 1 }
  // A `once` trigger has served its purpose; disabling it keeps it visible in
  // listings as history instead of silently deleting the human's intent.
  if (next.kind === 'once') next.enabled = false
  if (Number.isSafeInteger(next.maxRuns) && next.fireCount >= next.maxRuns) next.enabled = false
  return saveTrigger(next)
}

/**
 * Record a wake that was admitted but never reached the conversation.
 *
 * Deliberately does **not** touch `lastFiredAt` or `fireCount`: the run did not
 * happen, so charging it would silently drop the check-in and re-date the
 * cadence. Only the retry throttle advances.
 */
export function markAttemptFailed(trigger, at = Date.now()) {
  return saveTrigger({ ...trigger, lastAttemptAt: at })
}
