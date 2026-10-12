/**
 * Durable notices (things the assistant wants to say) and the expiry rule.
 *
 * Two hard-won rules are encoded here:
 *
 * 1. **A notice has a shelf life.** Observation and reminder notices expire; an
 *    outdated reminder delivered late is worse than one never delivered. A
 *    recorded field incident had calendar reminders queueing for 37–80 hours
 *    while the target session was offline, then firing long after they mattered.
 *    Ideas are exempt: an idea does not go stale.
 *
 * 2. **Identical content is one notice.** The id is a content hash, so a
 *    repeatedly rediscovered observation cannot pile up into a queue of
 *    duplicates that the human must wade through.
 */

import { denPath, digest, listJsonFiles, publishIfAbsent, readJson } from './atom.js'

/** How long an observation-style notice stays deliverable. */
export const NOTICE_TTL_MS = 12 * 60 * 60 * 1000

export const NOTICE_KINDS = ['notice', 'idea']

function noticeDirectory() {
  return denPath('notices')
}

function normalize(text) {
  return String(text).trim()
}

/**
 * Content-addressed notice id. Same session + kind + text always yields the same
 * id, which is what makes duplicate suppression possible without a scan.
 */
export function noticeId(sessionId, kind, text) {
  return digest(JSON.stringify([sessionId, kind, normalize(text)]))
}

function isValidNotice(value) {
  return (
    !!value &&
    value.version === 1 &&
    typeof value.id === 'string' &&
    typeof value.sessionId === 'string' &&
    NOTICE_KINDS.includes(value.kind) &&
    typeof value.text === 'string' &&
    Number.isFinite(value.createdAt)
  )
}

/**
 * Queue a notice for a session.
 *
 * @returns {{ id: string, queued: boolean }} `queued: false` means an identical
 * notice already exists and was left untouched.
 */
export function queueNotice(sessionId, text, kind = 'notice') {
  const body = normalize(text)
  if (!sessionId || !body) throw new Error('dsh-den: notice needs a session and non-empty text')
  if (body.length > 12000) throw new Error('dsh-den: notice text exceeds 12000 characters')
  if (!NOTICE_KINDS.includes(kind)) throw new Error(`dsh-den: invalid notice kind ${kind}`)

  const id = noticeId(sessionId, kind, body)
  const notice = { version: 1, id, sessionId, kind, text: body, createdAt: Date.now() }
  const queued = publishIfAbsent(denPath('notices', `${id}.json`), notice)
  return { id, queued }
}

/** Ideas never expire; observation notices do. */
export function isExpired(notice, now = Date.now()) {
  if (notice?.kind !== 'notice') return false
  return now - notice.createdAt > NOTICE_TTL_MS
}

/**
 * Read the deliverable notices for one session.
 *
 * Expired observation notices are reported separately rather than silently
 * dropped, so the caller can log that a reminder was deliberately not delivered
 * and the reason is auditable.
 *
 * @returns {{ deliverable: object[], expired: object[], invalid: string[] }}
 */
export function pendingNotices(sessionId, now = Date.now()) {
  const deliverable = []
  const expired = []
  const invalid = []

  for (const path of listJsonFiles(noticeDirectory())) {
    let notice
    try {
      notice = readJson(path)
    } catch {
      invalid.push(path)
      continue
    }
    if (!isValidNotice(notice)) {
      invalid.push(path)
      continue
    }
    if (notice.sessionId !== sessionId) continue
    if (isExpired(notice, now)) expired.push(notice)
    else deliverable.push(notice)
  }

  deliverable.sort((a, b) => a.createdAt - b.createdAt)
  return { deliverable, expired, invalid }
}

/** Notices for every session, used by the status surface. */
export function allNotices() {
  const notices = []
  for (const path of listJsonFiles(noticeDirectory())) {
    try {
      const notice = readJson(path)
      if (isValidNotice(notice)) notices.push(notice)
    } catch {
      /* unreadable records are surfaced by pendingNotices() instead */
    }
  }
  return notices.sort((a, b) => a.createdAt - b.createdAt)
}
