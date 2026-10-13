/**
 * Whether a running instance loaded the code it is being asked about.
 *
 * A long-lived process has one failure mode no test can see from outside: it can be
 * running yesterday's modules while every check that talks to it reports the health of
 * the code on disk. `startedAt` is when this instance was constructed — the moment the
 * process last read these files — so a source file whose mtime is *newer* than that was
 * not loaded by this process, however healthy its status looks.
 *
 * The judgement has to be made at *request* time, not at construction: files can be
 * edited after the instance loaded, and that is exactly the case being asked about. And
 * the answer has to be able to say "I do not know": an instance that cannot date itself
 * must never read as fresh, because "no evidence of staleness" and "evidence of
 * freshness" are different claims and only one of them is safe to act on.
 *
 * Only the arithmetic lives here; the filesystem walk is `collectSourceEdits`.
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * How far past `startedAt` an mtime must be before it counts as "not loaded by me".
 *
 * Not zero, because the timestamp is not that precise: filesystems report coarse
 * times (1s on FAT, 1s granularity historically on ext3) and the modules are read a
 * moment *before* the constructor records `startedAt`. An edit in that same window is
 * not evidence of a stale process. One second matches the grace the residency lease
 * already uses; it cannot hide an edit a human just made, because they would have to
 * make it and ask within the same second.
 */
export const FRESHNESS_TOLERANCE_MS = 1000

/**
 * The newest edit among `entries`, as `{ file, mtimeMs }`.
 *
 * Entries without a usable `mtimeMs` are skipped rather than treated as newest: a
 * record whose date is missing is not evidence of anything, and letting it win would
 * make every instance look freshly loaded.
 */
export function newestSourceEdit(entries) {
  let best = null
  for (const entry of entries ?? []) {
    const mtimeMs = Number(entry?.mtimeMs)
    if (!Number.isFinite(mtimeMs)) continue
    if (best === null || mtimeMs > best.mtimeMs) best = { file: String(entry?.file ?? ''), mtimeMs }
  }
  return best
}

/**
 * Judge an instance against the newest source edit beside it.
 *
 * Returns `{ known, stale, toleranceMs, detail }`. `known: false` means the question
 * could not be answered — callers must treat that as *not* a pass.
 */
export function judgeFreshness({ startedAt, newestSourceAt, newestSourceFile = null, toleranceMs = FRESHNESS_TOLERANCE_MS } = {}) {
  const startedMs = Date.parse(String(startedAt ?? ''))
  if (!Number.isFinite(startedMs)) {
    return { known: false, stale: null, toleranceMs, detail: 'this instance did not say when it loaded' }
  }
  const newestMs = newestSourceAt === null || newestSourceAt === undefined ? Number.NaN : Number(newestSourceAt)
  if (!Number.isFinite(newestMs)) {
    return { known: false, stale: null, toleranceMs, detail: 'no dated source file was found beside this instance' }
  }
  const ageMs = newestMs - startedMs
  const stale = ageMs > toleranceMs
  const seconds = Math.round(Math.abs(ageMs) / 1000)
  return {
    known: true,
    stale,
    ageMs,
    toleranceMs,
    detail: stale
      ? `${newestSourceFile ?? 'a source file'} was edited ${seconds}s after this instance loaded, so this process is running older code`
      : `the newest edit to ${newestSourceFile ?? 'any source file'} is ${seconds}s older than this instance's start`,
  }
}

/**
 * Walk `root` for the files whose mtime decides the answer.
 *
 * Recursive and unfiltered by extension: the client half of this plugin is as much a
 * part of what a restart must pick up as the host half, and a build artefact written
 * into `src/` would still be a reason the running copy differs from the tree.
 */
export function collectSourceEdits(root) {
  const out = []
  for (const entry of readdirSync(root, { recursive: true })) {
    const name = String(entry)
    let info
    try {
      info = statSync(join(root, name))
    } catch {
      // A file removed between the listing and the stat is not evidence of anything.
      continue
    }
    if (!info.isFile()) continue
    out.push({ file: name, mtimeMs: info.mtimeMs })
  }
  return out
}
