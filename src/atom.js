/**
 * Atomic, crash-safe JSON persistence for dsh-den.
 *
 * Design rules (inherited from a documented real-world incident in a reference
 * implementation): every write is published atomically with an fsync barrier,
 * and the containing directory is fsynced too, so a power loss can never leave
 * a half-written state file that the next boot would parse as authoritative.
 *
 * Directory layout is intentionally self-contained under `$DSH_HOME/den/` so the
 * whole assistant state can be packed and moved to another machine (or a cloud
 * host) without hunting through unrelated DSH storage.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Root of all dsh-den state. Self-contained by design; safe to move wholesale. */
export function denHome() {
  const base = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(base, 'den')
}

/**
 * Normalise a value so it survives a lossless JSON round trip.
 *
 * The Host validates a tool's return value and rejects anything it cannot
 * round-trip, and `undefined` is the trap: `JSON.stringify` DROPS a key whose value
 * is undefined, so the object's shape changes and the call fails with
 * "value is not lossless JSON". That shipped, and it took down `den_status`
 * entirely while every other tool kept working.
 *
 * The underlying values are fixed at their source — this is the boundary guard so
 * that one forgotten field can never again make a whole tool unreachable. Rules:
 *   undefined -> null, functions and symbols -> dropped, bigint -> string,
 *   non-finite numbers -> null, and anything non-plain is copied by own enumerable
 *   values rather than passed through with its prototype.
 *
 * Cycles are handled by tracking the **current path** rather than a visited set: an
 * object is removed from `seen` once its own subtree is finished, so a value
 * referenced twice as siblings is copied twice instead of being mislabelled as
 * circular. (Tracking "seen ever" instead would corrupt exactly that shape — the
 * `{from, to}` patch object in `den_configure` was the first real casualty.)
 */
export function toLosslessJson(value, seen = new WeakSet()) {
  if (value === undefined || value === null) return null

  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') return Number.isFinite(value) ? value : null
  if (type === 'bigint') return value.toString()
  if (type === 'function' || type === 'symbol') return undefined

  if (seen.has(value)) return '[circular]'
  seen.add(value)

  try {
    if (Array.isArray(value)) {
      return value.map((item) => {
        const normalised = toLosslessJson(item, seen)
        return normalised === undefined ? null : normalised
      })
    }

    const out = {}
    for (const key of Object.keys(value)) {
      const normalised = toLosslessJson(value[key], seen)
      // A dropped key would change the shape, which is the failure being prevented,
      // so an unserialisable value becomes null while keeping its key.
      out[key] = normalised === undefined ? null : normalised
    }
    return out
  } finally {
    // Leave the path: siblings may legitimately share this same object.
    seen.delete(value)
  }
}

export function denPath(...segments) {
  return join(denHome(), ...segments)
}

/** Stable, filesystem-safe name for an arbitrary id. */
export function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

/**
 * fsync a directory so a rename in it survives a crash.
 *
 * POSIX allows opening a directory for this; Windows does not, and the syscall
 * fails with EPERM/EINVAL/EACCES there. Directory durability is a hardening
 * measure, not a correctness requirement — the rename itself is atomic on both
 * platforms — so an unsupported platform degrades to a normal write instead of
 * failing the caller. Failing here would make the assistant unusable on Windows
 * for no safety gain.
 */
function fsyncDirectory(directory) {
  let descriptor
  try {
    descriptor = openSync(directory, 'r')
  } catch (error) {
    if (['EPERM', 'EACCES', 'EINVAL', 'EISDIR', 'ENOTSUP'].includes(error?.code)) return
    throw error
  }
  try {
    fsyncSync(descriptor)
  } catch (error) {
    if (!['EPERM', 'EACCES', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EBADF'].includes(error?.code)) throw error
  } finally {
    closeSync(descriptor)
  }
}

/**
 * How long an abandoned temp file must sit before it is reclaimed.
 *
 * A hard kill between `openSync(temporary,'wx')` and `renameSync` leaves the
 * temp file behind forever — measured at 39 of 40 kills. Atomicity guarantees the
 * *document* is never torn, but it does nothing about this litter, and a resident
 * assistant that writes every heartbeat would accumulate unbounded junk.
 *
 * The grace period is what makes the sweep safe: a temp file younger than this
 * may belong to a write another process is performing right now, and reaping that
 * would break a legitimate concurrent write. Only genuinely abandoned files are
 * removed.
 */
export const STALE_TEMP_MS = 5 * 60 * 1000

/**
 * Remove temp files abandoned by an earlier crash.
 *
 * Best-effort by design: housekeeping must never fail a write or a boot, so every
 * error is swallowed. Returns the number of files reclaimed.
 *
 * @param {string} directory directory to sweep
 * @param {number} [now] current epoch ms, injectable for tests
 */
export function reapStaleTempFiles(directory, now = Date.now()) {
  let reclaimed = 0
  let names
  try {
    names = readdirSync(directory)
  } catch {
    return 0
  }
  for (const name of names) {
    // Only ever touch our own temp shapes, never a user file.
    if (!name.endsWith('.tmp') && !name.endsWith('.pending')) continue
    const candidate = join(directory, name)
    try {
      if (now - statSync(candidate).mtimeMs < STALE_TEMP_MS) continue
      unlinkSync(candidate)
      reclaimed += 1
    } catch {
      /* someone else reaped it, or it is locked; both are fine */
    }
  }
  return reclaimed
}

/**
 * Write JSON so that readers observe either the previous complete document or
 * the new complete document, never a partial one.
 *
 * @param {string} path destination file
 * @param {unknown} value JSON-serialisable value
 */
export function writeJsonAtomic(path, value) {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  const descriptor = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`)
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  renameSync(temporary, path)
  fsyncDirectory(directory)
  // Opportunistic sweep so a long-running host reclaims its own crash litter.
  // Deliberately after the rename: a failure here cannot lose the document.
  reapStaleTempFiles(directory)
}

/**
 * Publish content only if no file exists at `path` yet, without ever replacing
 * an existing record. Used for content-addressed records (notifications), where
 * losing a race must mean "someone else already stored identical content",
 * never "we overwrote an acknowledgement".
 *
 * @returns true when this call created the file.
 */
export function publishIfAbsent(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const prepared = `${path}.${randomUUID()}.pending`
  writeJsonAtomic(prepared, value)
  let created = false
  try {
    linkSync(prepared, path)
    created = true
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  } finally {
    try {
      unlinkSync(prepared)
    } catch {
      /* the pending file is already gone */
    }
  }
  if (created) {
    fsyncDirectory(dirname(path))
  }
  return created
}

/** Read JSON, or `undefined` when the file does not exist. */
export function readJson(path) {
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * Read JSON and validate its shape. A record that fails validation is treated as
 * absent and reported, never as authoritative: a corrupt file must degrade the
 * assistant to a safe state instead of granting it stale authority.
 *
 * @param {string} path file to read
 * @param {(value: any) => boolean} validate shape check
 * @returns {{ ok: true, value: any } | { ok: false, reason: string }}
 */
export function readJsonChecked(path, validate) {
  if (!existsSync(path)) return { ok: false, reason: 'absent' }
  let value
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { ok: false, reason: `unparseable: ${error.message}` }
  }
  if (!validate(value)) return { ok: false, reason: 'invalid-shape' }
  return { ok: true, value }
}

/** List every `.json` file in a directory, tolerating a missing directory. */
export function listJsonFiles(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => join(directory, name))
}
