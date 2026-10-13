/**
 * Residency on its own.
 *
 * The kernel-level behaviour is covered in kernel.test.mjs, where a lease is attached to two
 * kernels over one home. This file covers the module directly, because src/resident.js makes
 * claims in its header — about which direction each failure falls — and a claim about a failure
 * direction is exactly the kind that never gets tested by accident. Each one below corresponds
 * to a sentence in that header.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const { KernelLease } = await import('../src/resident.js')

test.beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'dsh-den-resident-'))
})

test.afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

let sandbox = ''

const leaseAt = (name = 'kernel-lease.json') => join(sandbox, name)
const read = (path) => JSON.parse(readFileSync(path, 'utf8'))

test('an absent lease is taken', () => {
  const path = leaseAt()
  const lease = new KernelLease({ path, isAlive: () => true })
  assert.equal(lease.acquire(1000), true)
  const written = read(path)
  assert.equal(written.pid, process.pid)
  assert.equal(written.renewedAt, 1000)
  assert.equal(lease.report().held, true)
})

test('a fresh lease held by a live owner is respected, and the holder is named', () => {
  const path = leaseAt()
  const holder = new KernelLease({ path, staleMs: 5000, isAlive: () => true })
  assert.equal(holder.acquire(1000), true)

  const standby = new KernelLease({ path, staleMs: 5000, isAlive: () => true })
  assert.equal(standby.acquire(2000), false)
  const report = standby.report()
  assert.equal(report.held, false)
  assert.equal(report.holderPid, holder.pid, 'a standby host has to be able to say who holds it')
})

test('a lease that is a different instance in the same process is still someone else', () => {
  // Two plugin instances can share a process. Comparing pids would make the second one treat the
  // first one's record as its own and deliver alongside it, which is the bug this guards.
  const path = leaseAt()
  const first = new KernelLease({ path, isAlive: () => true })
  const second = new KernelLease({ path, isAlive: () => true })
  assert.equal(first.pid, second.pid, 'both are this process')
  assert.notEqual(first.instance, second.instance)
  assert.equal(first.acquire(1000), true)
  assert.equal(second.acquire(1000), false)
})

test('a broken record counts as ownership while it is fresh, and ages out after', () => {
  // A crash between the atomic create and the write leaves an unreadable file with a fresh
  // mtime. Delivering twice is worse than a few ticks of silence, so this stands down — but only
  // until the record is old enough to be a crash rather than a live holder.
  const path = leaseAt()
  writeFileSync(path, '{ not json')
  const writtenAt = Date.now()

  const fresh = new KernelLease({ path, staleMs: 10_000, isAlive: () => true })
  assert.equal(fresh.acquire(writtenAt), false, 'a fresh unscannable record must not be raced over')

  const later = new KernelLease({ path, staleMs: 10_000, isAlive: () => true })
  assert.equal(later.acquire(writtenAt + 120_000), true, 'and must be reclaimable once it is stale')
})

test('a record a hair in the future is still fresh, a wildly future one is not', () => {
  // Measured while writing this: the mtime of a file written microseconds ago can round ahead of
  // `Date.now()`, which made the record look like it came from the future and get reclaimed —
  // the crash-window guard silently not guarding. Both bounds are pinned so neither direction
  // can drift back. The generous bound is deliberate: two Hosts sharing one home may be two
  // machines whose clocks differ by seconds, and a holder that looks slightly ahead of us is
  // more likely skewed than corrupt.
  const path = leaseAt()
  const now = Date.now()
  writeFileSync(path, JSON.stringify({ version: 1, pid: process.pid + 1, instance: 'other', renewedAt: now + 500 }))
  const tolerant = new KernelLease({ path, staleMs: 10_000, isAlive: () => true })
  assert.equal(tolerant.acquire(now), false, 'half a millisecond of rounding is tolerance, not corruption')

  // An hour ahead is not a skewed clock. If this were respected, a corrupt record could hold the
  // tree forever while nobody delivered — the one outcome worse than a duplicate.
  writeFileSync(
    path,
    JSON.stringify({ version: 1, pid: process.pid + 1, instance: 'other', renewedAt: now + 3_600_000 }),
  )
  const corrupt = new KernelLease({ path, staleMs: 10_000, isAlive: () => true })
  assert.equal(
    corrupt.acquire(now),
    true,
    'but a timestamp far in the future must not be able to hold the tree forever',
  )
})

test('a stale record is reclaimed even though its owner is alive', () => {
  const path = leaseAt()
  const holder = new KernelLease({ path, staleMs: 1000 })
  assert.equal(holder.acquire(1000), true)

  const taker = new KernelLease({ path, staleMs: 1000, isAlive: () => true })
  assert.equal(taker.acquire(1500), false, 'inside the window the holder keeps it')
  assert.equal(taker.acquire(2500), true, 'past it, a holder that stopped renewing loses it')
})

test('renew keeps the record current so a working holder is never taken over', () => {
  const path = leaseAt()
  const lease = new KernelLease({ path, staleMs: 1000 })
  assert.equal(lease.acquire(1000), true)

  assert.equal(lease.renew(1900), true)
  assert.equal(read(path).renewedAt, 1900)

  const taker = new KernelLease({ path, staleMs: 1000, isAlive: () => true })
  assert.equal(taker.acquire(2500), false, 'renewal moved the window, so 2500 is still inside it')
})

test('release gives up only our own lease', () => {
  const path = leaseAt()
  const lease = new KernelLease({ path })
  assert.equal(lease.acquire(1000), true)
  assert.equal(lease.release(), true)
  assert.equal(lease.report().held, false)
  assert.throws(() => read(path), 'the file is gone')

  // Someone else's lease must survive us: a host that is shutting down cannot hand residency
  // away from the host that took it over while we were stopping.
  const holder = new KernelLease({ path })
  assert.equal(holder.acquire(2000), true)
  const stranger = new KernelLease({ path })
  assert.equal(stranger.release(), false, 'a lease we never held is not ours to release')
  assert.equal(read(path).instance, holder.instance, 'and the holder still owns it')
})

test('an unwritable home is fail-open: deliver, and say why', () => {
  // The deliberate asymmetry. A duplicate wake is recoverable and visible; a resident that
  // silently stopped is neither, so anything that is not a lost race has to keep delivering.
  const blocked = join(sandbox, 'not-a-directory')
  writeFileSync(blocked, 'this is a file, so it cannot hold a lease')
  const lease = new KernelLease({ path: join(blocked, 'kernel-lease.json') })
  assert.equal(lease.acquire(1000), true, 'a home we cannot write must not mute the assistant')
  assert.ok(lease.lastError, 'and the reason has to be recorded rather than swallowed')
})
