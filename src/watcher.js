/**
 * den watches the other conversations, without becoming one of them.
 *
 * The point of a resident assistant is that nobody has to tell it what happened: the session store
 * already holds every conversation on this machine, and a heartbeat that never looks at it is a
 * heartbeat that can only wait to be spoken to. So this reads the logs — but carefully:
 *
 *  - **cheaply.** The biggest log on this machine is 32 MB. Nothing here decompresses a whole log: the
 *    change signal is `size + mtimeMs` from `statSync`, and only a changed log is read, and only its
 *    tail, through one `readSync` into a fixed buffer.
 *  - **silently at first.** A session den has never seen is *adopted*, not accused. Otherwise the first
 *    scan would report every historical failure on the machine as news, which is the definition of noise.
 *  - **without intruding.** den never writes into another session. What it finds is turned into a wake in
 *    *its own* conversation, which then passes the same four gates as every other autonomous wake: the
 *    daily budget, quiet hours, pacing, and the human's standing grant.
 */
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { denPath } from './atom.js'
import { decodeLog } from './session-log.js'

export const WATCH_SEEN_FILE = 'sessions-seen.json'
export const LOG_NAME = 'session.v4.jsonl.zstd'
export const DEFAULT_TAIL_BYTES = 262144
export const DEFAULT_MAX_SESSIONS = 300

export function watcherSeenPath() {
  return denPath(WATCH_SEEN_FILE)
}

export function watcherSessionsRoot() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')
}

/** Every session log on disk, newest first, by `stat` alone. */
export function scanSessionLogs({ root = watcherSessionsRoot(), exclude = [], maxSessions = DEFAULT_MAX_SESSIONS } = {}) {
  const found = []
  let buckets = []
  try {
    buckets = readdirSync(root, { withFileTypes: true })
  } catch (error) {
    return found
  }
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue
    let sessions = []
    try {
      sessions = readdirSync(join(root, bucket.name), { withFileTypes: true })
    } catch (error) {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory() || exclude.includes(session.name)) continue
      const path = join(root, bucket.name, session.name, LOG_NAME)
      try {
        const info = statSync(path)
        if (!info.isFile()) continue
        found.push({ sessionId: session.name, bucket: bucket.name, path, size: info.size, mtimeMs: info.mtimeMs })
      } catch (error) {
        /* a session directory with no log is not a session to watch */
      }
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return found.slice(0, maxSessions)
}

/**
 * The last events of a log, read from its tail.
 *
 * One `readSync` into a buffer of at most `tailBytes`. A frame can straddle the start of that window, and
 * `decodeLog` already skips a candidate that will not decompress, so a partial leading frame costs
 * nothing but is never trusted.
 */
export function tailEvents(path, size, { tailBytes = DEFAULT_TAIL_BYTES, keep = 24 } = {}) {
  if (!Number.isFinite(size) || size <= 0) return []
  const length = Math.min(tailBytes, size)
  const buffer = Buffer.alloc(length)
  let fd = null
  try {
    fd = openSync(path, 'r')
    const read = readSync(fd, buffer, 0, length, size - length)
    return decodeLog(buffer.subarray(0, read)).slice(-keep)
  } catch (error) {
    return []
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch (error) {
        /* closing a read-only descriptor is best effort */
      }
    }
  }
}

/** What the tail says about a session, in the few fields a decision needs. */
export function summariseTail(events) {
  const types = new Map()
  let error = ''
  let lastAt = 0
  let spoke = false
  for (const event of events || []) {
    const type = event?.type || 'unknown'
    types.set(type, (types.get(type) || 0) + 1)
    const at = Number(event?.time) || 0
    if (at > lastAt) lastAt = at
    if (type === 'assistant/message') spoke = true
    if (type === 'turn/end') {
      const reason = event.data?.reason
      error = reason?.kind === 'error' && typeof reason.error?.message === 'string' ? reason.error.message.slice(0, 200) : ''
    }
  }
  return { types, lastAt, error, spoke }
}

/** One `stat` fingerprint per session, plus what the tail said when it changed. */
export function observeSessionActivity({
  root = watcherSessionsRoot(),
  seen = {},
  exclude = [],
  now = Date.now(),
  tailBytes = DEFAULT_TAIL_BYTES,
  maxSessions = DEFAULT_MAX_SESSIONS,
} = {}) {
  const logs = scanSessionLogs({ root, exclude, maxSessions })
  const next = {}
  const changes = []
  let adopted = 0
  for (const log of logs) {
    const prior = seen[log.sessionId]
    next[log.sessionId] = { size: log.size, mtimeMs: log.mtimeMs, at: now }
    if (prior && prior.size === log.size && prior.mtimeMs === log.mtimeMs) continue
    const isNew = !prior
    if (isNew) adopted += 1
    // A first sighting is a baseline, not news: the alternative is reporting every failure in the
    // machine's history the moment den starts watching.
    const recent = isNew ? [] : tailEvents(log.path, log.size, { tailBytes })
    const summary = summariseTail(recent)
    changes.push({
      sessionId: log.sessionId,
      path: log.path,
      size: log.size,
      mtimeMs: log.mtimeMs,
      grew: prior ? log.size - prior.size : log.size,
      rewritten: Boolean(prior) && log.size < prior.size,
      adopted: isNew,
      error: summary.error,
      spoke: summary.spoke,
      lastAt: summary.lastAt,
    })
  }
  const attention = changes.filter((change) => !change.adopted && change.error)
  return { seen: next, changes, attention, adopted, watched: logs.length }
}

/** Whether this sighting is worth waking for, given what has already been alerted. */
export function alertKey(item) {
  return `${item.sessionId}:${item.size}`
}

export function shouldAlert(item, alerted = {}) {
  if (!item || item.adopted || !item.error) return false
  return !Object.prototype.hasOwnProperty.call(alerted, alertKey(item))
}

/**
 * The wake this sighting becomes.
 *
 * It is scheduled for den's *own* conversation, never the watched one: the watched session belongs to
 * somebody else, and authority in this plugin is per conversation. The facts go in `prompt`, which is what
 * the wake actually carries, and in the title, which is what a human reading the trigger list sees. A wake
 * that says "something happened" without saying what is a wake that has to go and look again.
 *
 * `prompt` is required by the trigger schema — and finding that out cost nothing, because the test asserts
 * the host accepts this shape rather than assuming it.
 */
export function watchWakeFor(item, { sessionId, now = Date.now() } = {}) {
  const short = String(item.sessionId).slice(0, 8)
  const facts =
    'another conversation (session ' +
    short +
    ') ended a turn with an error at ' +
    new Date(Number(item.mtimeMs) || now).toISOString() +
    ': ' +
    String(item.error).slice(0, 200) +
    '. Read that session log, decide whether anything here needs doing, and say what you found in this ' +
    'conversation. Do not write into the other session: it belongs to somebody else.'
  return {
    sessionId,
    title: `another conversation ended a turn in an error (${short})`,
    prompt: facts,
    kind: 'once',
    /**
     * A `once` trigger defaults to `maySpeak: false`. For a scheduled check-in that is the right
     * default — it is a reminder, not a message. This one is the opposite: den was woken because
     * something in another conversation needs a decision, and a wake forbidden to say what it found is
     * a wake that did nothing. Measured, not assumed: `normalizeTrigger` filled in `false` and the
     * integration test asserted the value the wake actually has.
     */
    maySpeak: true,
    at: now,
    maxRuns: 1,
  }
}
