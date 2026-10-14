/**
 * The drill's verdict, tested before it is ever read from a live host.
 *
 * `tools/drill-live-wake.mjs` is the last measurement of this project: two frames around the one
 * event no instance has shown. A verdict that had only ever been produced by a live run would be
 * a verdict nobody had checked, and this repository has already paid for that shape twice — a
 * check that reported PASS while the exit code said otherwise, and a live claim re-established
 * against a host running older code.
 *
 * Each case below is a way the drill could lie if the comparison were written carelessly.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { judgeWake } = await import('../tools/drill-live-wake.mjs')

/** A frame that would be recorded by `--before` on a healthy, authorized host with a due check. */
function beforeFrame(overrides = {}) {
  return {
    at: '2026-10-13T10:00:00.000Z',
    sessionId: 'session-drill',
    sessionFrom: 'argument',
    startedAt: '2026-10-13T09:50:07.589Z',
    autonomy: true,
    autonomyKnown: true,
    kernelRunning: true,
    residencyHeld: true,
    triggersTotal: 1,
    triggersDue: 0,
    turns: 0,
    spoken: 0,
    skipped: 0,
    refused: 0,
    ...overrides,
  }
}

/** The same host after a wake was delivered and spoken. */
function wokeFrame(overrides = {}) {
  return beforeFrame({ turns: 1, spoken: 1, ...overrides })
}

test('a delivered, spoken wake passes, and says what it saw', () => {
  const verdict = judgeWake(beforeFrame(), wokeFrame({ startedAt: '2026-10-13T11:00:00.000Z' }))
  assert.equal(verdict.pass, true, verdict.failures.join('; '))
  assert.deepEqual(verdict.failures, [])
  assert.ok(
    verdict.notes.some((note) => note.includes('restarted between the frames')),
    'a restart between the frames is allowed, and has to be stated rather than hidden',
  )
})

test('a spent turn with nothing spoken is a failure, not a pass', () => {
  // The distinction the whole ledger exists for: `turns` is bumped after delivery, `spoken` only
  // when the wake actually speaks. If this case passed, the drill would report success for a
  // check-in the assistant decided was not worth saying — which is not the capability being
  // claimed. It reads exactly like a wake and it is not one.
  const verdict = judgeWake(beforeFrame(), wokeFrame({ spoken: 0, skipped: 1 }))
  assert.equal(verdict.pass, false)
  assert.equal(verdict.failures.length, 1)
  assert.match(verdict.failures[0], /nothing was spoken/)
})

test('authority that is missing, unknown or untrue never passes', () => {
  for (const [label, patch] of [
    ['not granted', { autonomy: false }],
    ['unknown', { autonomy: null, autonomyKnown: false }],
  ]) {
    const verdict = judgeWake(beforeFrame(), wokeFrame(patch))
    assert.equal(verdict.pass, false, `${label} must not pass`)
    assert.ok(
      verdict.failures.some((failure) => /authority is recorded|standing autonomy/.test(failure)),
      `${label}: expected a failure naming the grant, got ${JSON.stringify(verdict.failures)}`,
    )
  }
})

test('a grant with nothing due explains itself instead of blaming the host', () => {
  // The trap for whoever follows a checklist: standing autonomy is permission, not a schedule. A
  // drill run with no self-check can wait forever and would otherwise report "no wake was
  // delivered" — true, and no help at all.
  const verdict = judgeWake(beforeFrame({ triggersTotal: 0 }), beforeFrame({ triggersTotal: 0 }))
  assert.equal(verdict.pass, false)
  assert.ok(
    verdict.failures.some((failure) => failure.includes('no self-check exists')),
    'the missing trigger must be named',
  )
})

test('a frame read without a conversation blames the instrument, not the grant', () => {
  // Measured on the first live run: `status` without a sessionId answers `autonomy: null,
  // autonomyKnown: false` on a host that has authority, because authority is recorded per
  // conversation. The verdict therefore has to tell "you did not say which conversation" apart
  // from "the grant never landed" — the first is the drill's own defect and the second is an
  // accusation against a host that may be perfectly fine.
  const noSession = { ...wokeFrame(), sessionId: null, sessionFrom: 'none', autonomy: null, autonomyKnown: false }
  const verdict = judgeWake(beforeFrame({ sessionId: null, sessionFrom: 'none' }), noSession)
  assert.equal(verdict.pass, false)
  assert.ok(
    verdict.failures.some((failure) => failure.includes('--session')),
    `the failure must name the missing conversation, got ${JSON.stringify(verdict.failures)}`,
  )
  assert.ok(
    !verdict.failures.some((failure) => failure.includes('grant never landed')),
    'and must not accuse the host of a missing grant',
  )
})

test('a host that stands down is reported as standing down', () => {
  const verdict = judgeWake(beforeFrame(), wokeFrame({ residencyHeld: false }))
  assert.equal(verdict.pass, false)
  assert.ok(verdict.failures.some((failure) => failure.includes('standing down')))
})

test('a stopped heartbeat cannot be a pass even if the counters moved', () => {
  const verdict = judgeWake(beforeFrame(), wokeFrame({ kernelRunning: false }))
  assert.equal(verdict.pass, false)
  assert.ok(verdict.failures.some((failure) => failure.includes('heartbeat is not running')))
})

test('counters that moved backwards or stood still are never a wake', () => {
  for (const patch of [{ turns: 0, spoken: 0 }, { turns: 0, spoken: 1 }]) {
    const verdict = judgeWake(beforeFrame(), wokeFrame(patch))
    assert.equal(verdict.pass, false, `${JSON.stringify(patch)} must not pass`)
  }
})
