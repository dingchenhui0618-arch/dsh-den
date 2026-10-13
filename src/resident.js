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

/** How long to wait between liveness probes before believing a "no such process". */
export const LIVENESS_RETRY_MS = 5

/** The synchronous sleep used by the liveness retry. */
const LIVENESS_PARK = new Int32Array(new SharedArrayBuffer(4))

/**
 * How young a record may be, and still be protected from a liveness answer that says its owner is
 * gone.
 *
 * The staleness window is measured in heartbeats, and a restart must not wait for it. But a
 * *liveness probe* is not strong enough on its own to justify deleting a record that was written a
 * moment ago: measured, under load, `process.kill(pid, 0)` answered `ESRCH` for a process that was
 * alive and went on to deliver. A holder one millisecond old was declared gone, its record was
 * deleted, and a second owner was created.
 *
 * So a negative answer only authorises taking over a record that is at least this old. In the
 * field that costs nothing: a restart finds the previous holder's record at least one heartbeat
 * old, which is far beyond this. It is a bound on the damage one wrong answer can do, not a claim
 * that the probe is now trustworthy — see DESIGN 2.16.
 */
export const TAKEOVER_GRACE_MS = 1_000

/**
 * Is this process still running?
 *
 * `EPERM` means the pid exists and belongs to someone else to signal, which is still alive.
 * Only `ESRCH` — or a nonsense pid — is a negative.
 */
export function defaultIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  // Only a definite "no such process" is a negative — and even that is asked more than once.
  //
  // Measured: under load, `process.kill(pid, 0)` answered `ESRCH` for a process that was alive.
  // Four Hosts racing over one lease, and a holder one millisecond old was declared gone, its
  // record deleted, and a second owner created. Twenty-four thousand probes from an idle parent
  // never reproduced it, so it is a load-and-Windows effect rather than a plain bug in the API.
  //
  // A second look is cheap and a dead pid stays dead. The wait matters: three tight retries did not
  // clear it in the reproduction, but the wrong answer belongs to a transient state, so the retries
  // are spaced by a few milliseconds rather than by nothing. `Atomics.wait` is the synchronous sleep
  // available here; `acquire` is called once per heartbeat, so a few milliseconds is affordable.
  //
  // Note what this is: a mitigation, not a proof. The deletion that a wrong answer authorises is
  // what makes it worth more than nothing.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      // EPERM means the pid exists and belongs to someone else to signal, which is still alive.
      // Anything else is an answer we do not have, and an answer we do not have must not
      // authorise deleting a live holder's lease.
      if (error?.code !== 'ESRCH') return true
      if (attempt < 3) Atomics.wait(LIVENESS_PARK, 0, 0, LIVENESS_RETRY_MS)
    }
  }
  return false
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
   * Claim the right to take over one specific record.
   *
   * Deleting a record and creating a new one is not mutual exclusion, however atomic the create is.
   * Two hosts that judge the same record free both delete it, and the second delete removes the
   * record the first host has just created — leaving two, or three, hosts that each correctly
   * believe they created the lease. Measured, before this existed: four real processes over one
   * empty lease produced three simultaneous owners.
   *
   * So the right to take over is itself a create-if-absent, on a name derived from the record being
   * replaced. Every host that judged *that* record computes the same name, so exactly one proceeds
   * and the rest stand down against whatever the winner leaves behind.
   *
   * The marker is deliberately not cleaned up. A slow host can read a record, lose the race for the
   * marker, and still try to act on the record it read; the marker existing is what stops it. One
   * zero-byte file per takeover is a cheaper price than a second resident.
   *
   * @returns {boolean} whether this instance may take the record over
   */
  #claimTakeover(existing) {
    const marker = `${this.path}.reclaim-${existing.instance ?? 'unreadable'}.${existing.renewedAt}`
    try {
      closeSync(openSync(marker, 'wx', 0o600))
      return true
    } catch (error) {
      // Losing the claim is a race, and the only race here.
      if (error?.code === 'EEXIST') return false
      // Anything else is not a race, and the one outcome this module exists to prevent is every
      // host declining — so this proceeds, and says why.
      this.lastError = String(error?.message ?? error)
      return true
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
      const alive = existing.instance === null ? true : this.isAlive(existing.pid)
      // And a *negative* answer is not enough on its own while the record is young. The probe was
      // measured lying about a holder one millisecond old, so a young record is respected whether
      // or not the probe believes its owner is gone.
      const provablyAbandoned = !alive && age >= TAKEOVER_GRACE_MS
      if (fresh && !provablyAbandoned) {
        this.held = false
        this.holder = existing
        return false
      }

      // Taking over is the dangerous half, and a delete-then-create is not mutual exclusion: two
      // hosts that judge the same record free both delete, and the second delete removes the record
      // the first host just created. The right to take over is therefore itself a create-if-absent,
      // on a name derived from the record being replaced.
      if (!this.#claimTakeover(existing)) {
        this.held = false
        this.holder = this.#read()
        return false
      }
      // Between judging and claiming, someone may have replaced the record. If it is no longer the
      // one judged, its own answer stands and this host stands down.
      const current = this.#read()
      if (current && (current.instance !== existing.instance || current.renewedAt !== existing.renewedAt)) {
        this.held = false
        this.holder = current
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


