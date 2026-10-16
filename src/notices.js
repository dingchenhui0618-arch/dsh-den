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

import { unlinkSync } from 'node:fs'

import { denPath, digest, listJsonFiles, publishIfAbsent, readJson, writeJsonAtomic } from './atom.js'

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
 * Duplicate suppression is decided by whether an identical notice is still **deliverable**, not by
 * whether a file with that name exists. The id is content-addressed, so the file from a notice that
 * expired hours ago is still sitting there, and suppressing against it silences the content
 * permanently: measured, the same observation made thirteen hours apart came back `queued: false`
 * while `pendingNotices` kept reporting `deliverable: 0, expired: 1`, forever. A record that could
 * never be delivered — expired, or unreadable — is not a duplicate, it is a dead one.
 *
 * @returns {{ id: string, queued: boolean }} `queued: false` means an identical notice is already
 *   queued and still deliverable, and was left untouched.
 */
export function queueNotice(sessionId, text, kind = 'notice', now = Date.now()) {
  const body = normalize(text)
  if (!sessionId || !body) throw new Error('dsh-den: notice needs a session and non-empty text')
  if (body.length > 12000) throw new Error('dsh-den: notice text exceeds 12000 characters')
  if (!NOTICE_KINDS.includes(kind)) throw new Error(`dsh-den: invalid notice kind ${kind}`)

  const id = noticeId(sessionId, kind, body)
  const notice = { version: 1, id, sessionId, kind, text: body, createdAt: now }
  const path = denPath('notices', `${id}.json`)

  const existing = readExisting(path)
  if (existing && isValidNotice(existing) && !isExpired(existing, now)) {
    return { id, queued: false }
  }
  if (existing) {
    // Replace the dead record in place. The id, session, kind and text are identical by
    // construction, so the only field that moves is the one that was wrong: `createdAt`.
    writeJsonAtomic(path, notice)
    return { id, queued: true }
  }
  return { id, queued: publishIfAbsent(path, notice) }
}

/** Read a notice file, tolerating absence and damage. Absent and unreadable are both "not a duplicate". */
function readExisting(path) {
  try {
    return readJson(path)
  } catch {
    return null
  }
}

/**
 * Mark one notice as delivered to the human, because the human said so.
 *
 * Measured defect (2026-10-14, reported by the user looking at the panel): a wake spoke — the kernel
 * queued its text and charged the turn — and the page kept reporting `Pending notices 1 / 1` forever.
 * The cause was in this module: `pendingNotices` knew only "deliverable" and "expired", so a notice
 * that had been shown had no way to stop being pending, and a count that can never reach zero is a
 * count nobody should trust.
 *
 * Only an explicit acknowledgement marks it. Inferring delivery from a *read* would make the count
 * lie in the other direction: rendering a panel is not a human reading it.
 *
 * @returns {{ok: boolean, alreadyDelivered?: boolean, error?: string}}
 */
export function ackNotice(sessionId, id, now = Date.now()) {
  // Two different things can be missing and they are not the same problem, so they do not share a
  // sentence — a message that names both sends the reader looking in the wrong place. The id stays
  // strictly required: an acknowledgement with no record to point at would be a receipt for nothing,
  // and quietly succeeding would let a caller believe it marked something read.
  //
  // A missing conversation is a *caller* problem rather than a human's: this record is filed under
  // the conversation it was queued for, and the caller is expected to resolve one before asking. The
  // one human-facing caller does exactly that — `panel-api.js`'s `notices/ack` falls back to den's
  // standing conversation when the surface that drew the button has none of its own.
  if (!id) return { ok: false, error: 'acknowledging a notice needs the id of the notice' }
  if (!sessionId) return { ok: false, error: 'acknowledging a notice needs the conversation it was filed under' }
  const path = denPath('notices', `${id}.json`)
  let notice
  try {
    notice = readJson(path)
  } catch {
    return { ok: false, error: 'no such notice' }
  }
  if (!isValidNotice(notice) || notice.sessionId !== sessionId) return { ok: false, error: 'no such notice' }
  if (notice.deliveredAt) return { ok: true, alreadyDelivered: true }
  writeJsonAtomic(path, { ...notice, deliveredAt: now })
  return { ok: true, alreadyDelivered: false }
}

/**
 * Which conversation a notice is filed under, or `''` when there is no such notice.
 *
 * The record itself is the only authority on this — not the file name, not the caller's guess — and a
 * caller that has no conversation of its own needs the answer before it can file a read receipt: the
 * panel's console shows den's whole notice list (`status.notices.pending` is not scoped per
 * conversation), so the notice on screen may belong to the conversation that scheduled the check
 * rather than to den's standing one.
 *
 * Non-throwing and tolerant of damage, like every other reader here: an absent, unreadable or
 * half-written record is `''`, which its caller reads as "this id names nothing".
 */
export function noticeOwner(id) {
  if (!id) return ''
  try {
    const notice = readJson(denPath('notices', `${id}.json`))
    return isValidNotice(notice) ? String(notice.sessionId ?? '').trim() : ''
  } catch {
    return ''
  }
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
    // A notice the human has already acknowledged is neither deliverable nor expired. Without
    // this the count a human is looking at could never reach zero — see `ackNotice`.
    if (notice.deliveredAt) continue
    if (isExpired(notice, now)) expired.push(notice)
    else deliverable.push(notice)
  }

  deliverable.sort((a, b) => a.createdAt - b.createdAt)
  return { deliverable, expired, invalid }
}

/**
 * Remove observation notices that can no longer be delivered.
 *
 * Nothing used to delete a notice file, so the tree only grew: a resident assistant running for
 * months accumulates one file per distinct thing it ever said, and `allNotices()` reads every one of
 * them on every status call. The same reasoning that reaps abandoned temp files at boot applies.
 *
 * Unreadable records are left alone — `pendingNotices` reports those rather than deciding for itself
 * that a file it cannot parse is worthless.
 *
 * @returns {number} how many expired notices were reclaimed
 */
export function sweepExpiredNotices(now = Date.now()) {
  let reclaimed = 0
  for (const path of listJsonFiles(noticeDirectory())) {
    try {
      const notice = readJson(path)
      if (!isValidNotice(notice) || !isExpired(notice, now)) continue
      unlinkSync(path)
      reclaimed += 1
    } catch {
      /* someone else reclaimed it, or it is locked; both are fine */
    }
  }
  return reclaimed
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
