/**
 * The profile behind DESIGN §7.8: what the den knows about the person it works for.
 *
 * One rule shapes this whole file: **an entry that cannot name its source is refused.** §7.8's
 * acceptance test is "ask it what it remembers and every line points back to a source; a line that
 * cannot is invented". Enforcing that at write time is the only way it stays true a year later —
 * a profile is exactly the kind of store that quietly fills up with plausible inference, and once
 * one invented line is in there, the honest ones become unfalsifiable too.
 *
 * The three permitted sources are the ones the user authorised on 2026-10-14 (this DSH's session
 * history, `~/.codex/memories/`, repositories under `D:\Projects`), plus `user` for something the
 * person says directly. Nothing else may be recorded, because nothing else was authorised.
 *
 * Storage follows the task store: the caller passes the path, a missing or corrupt file is an empty
 * profile, and writes go through `atom.js`. Nothing here throws at start-up, and a corrupt file is
 * left exactly as it is rather than being overwritten.
 */

import { readJson, writeJsonAtomic } from './atom.js'

/** The three groupings §7.8 names, and nothing more: work in hand, how it is done, what not to do. */
export const KINDS = ['work', 'preference', 'boundary']

export const SOURCES = ['session', 'memories', 'repos', 'user']

export const PROFILE_FILE = 'profile.json'
export const PROFILE_VERSION = 1

function requireText(value, what) {
  const text = String(value ?? '').trim()
  if (!text) throw new TypeError(what)
  return text
}

/** Shape one entry, or refuse it. `source` is the load-bearing field, so it is checked hardest. */
export function makeEntry({ text, kind = 'work', source, at = Date.now(), id = '' } = {}) {
  const body = requireText(text, 'an entry needs text')
  const from = requireText(
    source,
    'an entry needs a source: a line that cannot name one is an invention, not a memory',
  )
  if (!SOURCES.includes(from)) {
    throw new TypeError(`unknown source ${JSON.stringify(from)}; expected one of ${SOURCES.join(', ')}`)
  }
  return {
    id: id || `e-${at.toString(36)}`,
    text: body,
    kind: KINDS.includes(kind) ? kind : 'work',
    source: from,
    at,
  }
}

export function loadProfile(path) {
  let raw = null
  try {
    raw = readJson(path)
  } catch {
    raw = null
  }
  const entries = Array.isArray(raw?.entries) ? raw.entries.filter((entry) => entry?.source) : []
  return { version: PROFILE_VERSION, entries }
}

export function saveProfile(path, profile) {
  const entries = Array.isArray(profile?.entries) ? profile.entries : []
  writeJsonAtomic(path, { version: PROFILE_VERSION, entries })
  return { version: PROFILE_VERSION, entries }
}

/** Add one entry to a list. Pure: the caller decides when it reaches disk. */
export function addEntry(profile, input, now = Date.now()) {
  const entries = Array.isArray(profile?.entries) ? profile.entries : []
  const entry = makeEntry({ ...input, at: now, id: `e${(entries.length + 1).toString(36)}-${now.toString(36)}` })
  return { ...profile, entries: [...entries, entry] }
}

/** Correct what an entry says. The source is kept: editing wording must not launder provenance. */
export function updateEntry(profile, { id, text, now = Date.now() } = {}) {
  const entries = Array.isArray(profile?.entries) ? profile.entries : []
  const target = entries.find((entry) => entry.id === id)
  if (!target) throw new TypeError(`no entry ${id || '(missing id)'}`)
  const body = requireText(text, 'an entry needs text')
  return {
    ...profile,
    entries: entries.map((entry) => (entry.id === id ? { ...entry, text: body, at: now } : entry)),
  }
}

/** Delete one entry. A profile the person cannot prune is not theirs. */
export function forgetEntry(profile, { id } = {}) {
  const entries = Array.isArray(profile?.entries) ? profile.entries : []
  if (!entries.some((entry) => entry.id === id)) throw new TypeError(`no entry ${id || '(missing id)'}`)
  return { ...profile, entries: entries.filter((entry) => entry.id !== id) }
}

/** What the den would answer to "你记得我什么": newest first, optionally one kind. */
export function listEntries(profile, { kind = '' } = {}) {
  const entries = Array.isArray(profile?.entries) ? profile.entries : []
  return entries
    .filter((entry) => !kind || entry.kind === kind)
    .slice()
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
}
