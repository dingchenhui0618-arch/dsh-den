/**
 * Does the panel payload carry what the service reports?
 *
 * `statusSnapshot` builds its payload field by field on purpose — a panel payload is an
 * allow-list, and that is the right shape. The trap is that adding a field to `status()` is
 * a two-file change where only one of them fails loudly: the tests pass, the route works,
 * and the new value is simply absent from the answer, which then reads as "the running Host
 * is a stale build" when the build is current. That happened twice in this repository, and
 * the second time is what this file exists to stop.
 *
 * The check is structural rather than a list of names, so it needs the *real* status shape:
 * a service would otherwise only ever report the fields its own stub happened to have.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// Its own den home: a real service must never be constructed against the live one.
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-den-payload-'))
process.env.DSH_HOME = sandbox

const { DenService } = await import('../src/index.js')
const { statusSnapshot } = await import('../src/panel-api.js')

test.after(() => rmSync(sandbox, { recursive: true, force: true }))

/**
 * Fields `status()` reports that the payload deliberately withholds, each with its reason.
 * Every entry is a decision someone has to make on the record; an unexplained field fails
 * the check above. Empty is not the healthy state — an explained list is.
 */
const WITHHELD = new Map([
  ['stateFile', 'the payload already carries `home`; which file holds the state is an implementation detail'],
  ['quietHours', 'the panel states the quiet-hours rule in prose; the window itself is configuration, not status'],
  ['dailyTurnBudget', 'same: the budget rule is explained to the human, the number is re-read from the gate when it acts'],
  ['cooldownSeconds', 'same: a pacing input, not an observation about this instance'],
  ['tickSeconds', 'the heartbeat row says whether it is running and when it last ticked, which is the observable part'],
  ['grants', 'grant records are per conversation; the payload carries the one for the asking conversation as `autonomy`'],
  ['sessionEvents', 'unbounded per-session grant history; the payload carries the den-level `recentEvents` instead'],
  ['statusRoute', 'transformed rather than withheld: it becomes `route` and `transport.claimedMounted`'],
])

/** Fields the payload does not carry and that nobody has explained. */
function unforwarded(raw, snapshot, withheld) {
  return Object.keys(raw).filter((key) => !(key in snapshot) && !withheld.has(key))
}

test('every withheld field is withheld for a stated reason', () => {
  // A map is only a decision record if the reasons are actually there; an empty string is
  // how a dumping ground starts.
  for (const [field, reason] of WITHHELD) {
    assert.equal(typeof reason, 'string', `${field} carries a reason`)
    assert.ok(reason.length > 20, `${field}'s reason says something (got: ${reason})`)
  }
})

test('every field status() reports reaches the panel payload or is named as withheld', () => {
  const service = new DenService({ effect: (fn) => fn() })
  const raw = service.status()
  assert.ok(Object.keys(raw).length > 10, 'the service still reports a full status to compare against')
  assert.deepEqual(
    unforwarded(raw, statusSnapshot(service, {}), WITHHELD),
    [],
    'carry the field through statusSnapshot, or add it to WITHHELD with the reason it is withheld',
  )
})

test('that check can fail, which is the only reason it is worth having', () => {
  // The control. Without it this file would pass if `unforwarded` were a stub returning [],
  // and a coverage check that cannot fail is exactly the shape of the trap it is here to close.
  const snapshot = { name: 'x', freshness: {} }
  assert.deepEqual(
    unforwarded({ name: 'x', freshness: {}, notForwarded: 1 }, snapshot, new Map()),
    ['notForwarded'],
    'a field nobody forwarded is reported',
  )
  assert.deepEqual(
    unforwarded({ name: 'x', freshness: {} }, snapshot, new Map([['freshness', 'carried elsewhere']])),
    [],
    'and a field with a stated reason is not',
  )
})

test('freshness is carried, because a stale instance is exactly what a human must be told', () => {
  const service = new DenService({ effect: (fn) => fn() })
  const snapshot = statusSnapshot(service, {})
  assert.ok(snapshot.freshness, 'the payload carries a freshness verdict')
  assert.equal(typeof snapshot.freshness.known, 'boolean', 'and says whether it could be judged at all')
  // This test runs inside the repository, so the tree beside the module is this tree and the
  // instance was constructed a moment ago: whatever the verdict, it must be a real one.
  assert.equal(snapshot.freshness.stale, false, 'a service built from the current tree is not stale')
  assert.ok(snapshot.freshness.newestSourceFile, 'and it names the file it judged')
})
