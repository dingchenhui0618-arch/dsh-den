/**
 * Residency: one kernel per state tree, best effort.
 *
 * `~/.dsh/den` is keyed on `DSH_HOME`, not on the profile. Two profiles — or the desktop app
 * plus a `dsh` in a terminal — therefore load this plugin twice over one state tree, and both
 * start a heartbeat. Nothing stopped them, and the consequence was measured rather than
 * assumed: with the first kernel parked inside its delivery, the second admitted the same
 * check-in and the conversation received it twice.
 *
 * The reordering that would fix that is not available. `kernel.js` deliberately commits the
 * cadence *after* delivery, so a process that dies mid-wake leaves the check-in due instead of
 * eating it; claiming before delivery would buy back exactly the loss that comment refuses.
 * So the fix is exclusion, not ordering.
 *
 * Shaped to fail in the safe direction for a resident assistant:
 *
 * - **The kernel always runs.** A host that cannot take the lease stands down per tick and
 *   retries on the next one. There is no state in which every host declines to run, which is
 *   the failure mode that would kill capabilities 2 and 3 together — the reason this is not a
 *   start-time lock.
 * - **Ownership is an instance token, not a pid.** Two plugin instances can share a process,
 *   so comparing pids would make the second one believe the first record was its own.
 * - **A broken record is treated as ownership while it is fresh.** An unparseable lease is a
 *   crash between create and write; standing down for a few ticks costs a wake, delivering
 *   twice costs the user's trust.
 * - **Anything else is fail-open.** An unwritable home, a missing directory: deliver, and
 *   record why. A duplicate is recoverable and visible; a resident that silently stopped is
 *   neither.
 */
import { randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { denPath, writeJsonAtomic } from './atom.js'

export function leasePath() {
  return denPath('kernel-lease.json')
}

/**
 * How far into the future a stored record may look and still count as current.
 *
 * Two reasons, both real. Filesystem timestamps are rounded and the sampling clock is read after
 * the write, so a record written a moment ago can measure as slightly ahead — measured, and it
 * made the crash-window guard stop guarding. And two Hosts sharing one home can be two machines
 * over a network path whose clocks differ by seconds; a holder that looks slightly ahead of us is
 * far more likely to be a skewed clock than a corrupt record.
 *
 * Beyond this it is a broken clock or a corrupt record, and a record that can claim any future
 * timestamp could hold the tree forever with nobody delivering.
 */
export const CLOCK_SLACK_MS = 60_000

/**
 * Is this process still running?
 *
 * `EPERM` means the pid exists and belongs to someone else to signal, which is still alive.
 * Only `ESRCH` — or a nonsense pid — is a negative.
 */
export function defaultIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

export class KernelLease {
  /**
   * @param {object} [options]
   * @param {string} [options.path] lease file
   * @param {number} [options.staleMs] how long a record stays authoritative without renewal
   * @param {(pid: number) => boolean} [options.isAlive] injectable for tests
   * @param {string} [options.instance] this holder's identity; defaults to a fresh uuid
   */
  constructor({ path = leasePath(), staleMs = 180_000, isAlive = defaultIsAlive, instance = randomUUID() } = {}) {
    this.path = path
    this.staleMs = staleMs
    this.isAlive = isAlive
    this.instance = instance
    this.pid = typeof process !== 'undefined' && Number.isFinite(process.pid) ? process.pid : null
    this.startedAt = Date.now()
    this.held = false
    this.holder = null
    this.lastError = null
  }

  #record(now) {
    return { version: 1, pid: this.pid, instance: this.instance, startedAt: this.startedAt, renewedAt: now }
  }

  /**
   * The stored record, or `null` when there is no lease at all.
   *
   * A present-but-unparseable record falls back to the file's mtime, so a crash between the
   * atomic create and the write still ages out and can be reclaimed.
   */
  #read() {
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8'))
      if (value && typeof value === 'object') {
        return {
          pid: Number.isSafeInteger(value.pid) ? value.pid : null,
          instance: typeof value.instance === 'string' ? value.instance : null,
          renewedAt: Number.isFinite(value.renewedAt) ? value.renewedAt : 0,
        }
      }
      return { pid: null, instance: null, renewedAt: 0 }
    } catch {
      try {
        return { pid: null, instance: null, renewedAt: statSync(this.path).mtimeMs, unreadable: true }
      } catch {
        return null
      }
    }
  }

  #remove() {
    try {
      rmSync(this.path, { force: true })
    } catch {
      /* already gone, or not ours to remove; the next acquire decides again */
    }
  }

  /**
   * Take or keep the lease.
   *
   * @returns {boolean} whether this instance may deliver on this tick
   */
  acquire(now = Date.now()) {
    const existing = this.#read()
    if (existing) {
      if (existing.instance === this.instance) {
        this.held = true
        this.renew(now)
        return true
      }
      const age = now - existing.renewedAt
      // A record written microseconds ago can still look like it is in the future: filesystem
      // timestamps are rounded and `Date.now()` is sampled after the write. Measured — a
      // sub-millisecond overshoot made `age` negative, the record was judged "not fresh", and it
      // was reclaimed as though it were corrupt, which is precisely the crash window this check
      // exists to protect. So a little future is tolerance.
      //
      // A lot of future is a broken clock or a corrupt record, and must not hold the tree
      // forever, so the tolerance is bounded in both directions.
      const fresh = Number.isFinite(age) && age <= this.staleMs && age >= -CLOCK_SLACK_MS
      // An unknown owner counts as ownership while the record is fresh: an unreadable lease is
      // preferred over a second delivery.
      if (fresh && (existing.instance === null || this.isAlive(existing.pid))) {
        this.held = false
        this.holder = existing
        return false
      }
      this.#remove()
    }

    // Create-if-absent is the mutual exclusion. Two hosts reclaiming a stale lease at the same
    // instant both reach here; exactly one `open` succeeds and the loser gets EEXIST.
    //
    // Preparing the directory is a separate step on purpose. It used to share one `catch` with
    // the open, and `mkdirSync` also reports EEXIST when the parent path is a file rather than a
    // directory — so an unwritable home was misread as a lost race and the host stood down
    // permanently. That is the one outcome this module exists to prevent: every host declining,
    // and therefore no resident at all. Only the open can lose a race.
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    } catch (error) {
      this.held = true
      this.lastError = `cannot prepare the lease directory: ${error?.message ?? error}`
      return true
    }
    try {
      const descriptor = openSync(this.path, 'wx', 0o600)
      try {
        writeFileSync(descriptor, JSON.stringify(this.#record(now)))
      } finally {
        closeSync(descriptor)
      }
      this.held = true
      this.holder = this.#record(now)
      this.lastError = null
      return true
    } catch (error) {
      if (error?.code === 'EEXIST') {
        this.held = false
        this.holder = this.#read()
        return false
      }
      // Not a race: an unwritable home, a permission problem, a platform without `wx`. Deliver
      // rather than strand the resident, and say why.
      this.held = true
      this.lastError = String(error?.message ?? error)
      return true
    }
  }

  /** Refresh the record while we hold it. */
  renew(now = Date.now()) {
    if (!this.held) return false
    const record = this.#record(now)
    try {
      writeJsonAtomic(this.path, record)
      this.holder = record
      this.lastError = null
      return true
    } catch (error) {
      this.lastError = String(error?.message ?? error)
      return false
    }
  }

  /** Give the lease up, but only if it is still ours. */
  release() {
    if (!this.held) return false
    const existing = this.#read()
    if (existing && existing.instance !== this.instance) {
      this.held = false
      return false
    }
    this.#remove()
    this.held = false
    return true
  }

  /** A plain report for the status payload: what a reader needs to explain a standby kernel. */
  report() {
    const holder = this.held ? this.#record(Date.now()) : this.holder
    return {
      held: this.held,
      instance: this.instance,
      pid: this.pid,
      staleMs: this.staleMs,
      holderPid: holder?.pid ?? null,
      holderSince: holder?.renewedAt ?? null,
      lastError: this.lastError,
    }
  }
}
