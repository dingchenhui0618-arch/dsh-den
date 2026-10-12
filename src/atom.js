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
