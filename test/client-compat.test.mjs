/**
 * The client half against a runtime that is older than the harnesses assume.
 *
 * Where the check lives, and why it is written this way.
 *
 * `call()` built its abort signal by guarding on `AbortSignal.timeout` and then calling
 * `AbortSignal.any` unconditionally. Those are separate APIs with separate availability:
 * `timeout` shipped in Chrome 103, `any` not until 116. On a shell in between, every
 * request threw a `TypeError` before `fetch` was reached.
 *
 * No existing harness could see it. `check-client-bundle.mjs`, `check-client-interaction.mjs`
 * and `roundtrip.test.mjs` all inject the host's own `AbortSignal`, where both methods
 * exist — the fixture stood in for a *runtime* with capabilities the runtime does not
 * promise. That is the same mistake as the rest of this file's history, with a new face:
 * before it was a fake service with the wrong shape, now a fake realm with the wrong
 * feature set.
 *
 * **What this test does, and what it deliberately does not.** It extracts the real
 * signalling expression out of `src/client/client.js` and evaluates that exact source
 * under two `AbortSignal` shapes. It does not re-implement the expression, so it cannot
 * agree with the code by construction — which is the failure mode of every harness that
 * missed this.
 *
 * It stops short of driving the whole bundle. Doing that needs React hooks, an `apply`,
 * a slots registry and a session service stood up faithfully enough that a failure means
 * something about the bundle rather than about the harness, and a half-faithful version
 * reports the harness's gaps as the product's. The expression is the part that was
 * wrong, so the expression is the part under test.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const bundle = readFileSync(join(root, 'src', 'client', 'client.js'), 'utf8')

/**
 * Pull the signalling expression out of the bundle's `call()`.
 *
 * Recognises both spellings on purpose. If it only matched the fixed one, a regression
 * would fail at *import* with "the signal is not where I expected" — which proves the
 * code changed but not that it broke. Matching the old shape too means the failing
 * assertion is the one about the degraded runtime, which is the claim being made.
 */
function extractSignallingSource() {
  const fetchAt = bundle.indexOf('return fetch(API, {')
  assert.ok(fetchAt > 0, 'the bundle must still issue its request from a recognisable place')

  const starts = ['var signal = null', 'var signal ='].map((needle) => bundle.indexOf(needle))
  const start = starts.filter((index) => index >= 0 && index < fetchAt).sort((a, b) => a - b)[0]
  assert.ok(
    start !== undefined,
    'the bundle must build its abort signal before the request, in a recognisable place',
  )
  return bundle.slice(start, fetchAt)
}

const SIGNALLING_SOURCE = extractSignallingSource()

/**
 * Evaluate the real expression against a given `AbortSignal`, returning the signal that
 * would be handed to `fetch`.
 *
 * `lifetime` mirrors what `apply` passes in (`{signal}` from an `AbortController`), and
 * is left undefined in the degraded case so the optional composition is not what is
 * under test.
 */
function signalFor(AbortSignal, lifetime = new AbortController()) {
  const sandbox = { AbortSignal, AbortController, lifetime, result: undefined }
  vm.createContext(sandbox)
  vm.runInContext(`var signal = null\n${SIGNALLING_SOURCE}result = signal`, sandbox)
  return sandbox.result
}

test('the expression under test is the one the bundle actually runs', () => {
  // If this stops being true, the two tests below are measuring a copy.
  assert.match(SIGNALLING_SOURCE, /AbortSignal\.timeout\(/)
  assert.ok(SIGNALLING_SOURCE.length > 0)
  assert.ok(
    !SIGNALLING_SOURCE.includes('return fetch('),
    'the extraction must stop before the request, so nothing is issued here',
  )
})

test('a runtime with `timeout` but no `any` still gets a usable signal', () => {
  // The exact shape that broke: Chrome 103..115.
  const timeoutSignal = { kind: 'timeout', ms: null }
  const AbortSignal = {
    timeout(ms) {
      timeoutSignal.ms = ms
      return timeoutSignal
    },
    // `any` is deliberately absent, which is the whole point.
  }

  const signal = signalFor(AbortSignal)

  assert.ok(signal, 'a signal must be produced, not undefined and not a throw')
  assert.equal(signal.kind, 'timeout', 'the timeout is the requirement, so it must survive')
  assert.equal(timeoutSignal.ms, 15000, 'with its budget intact')
})

test('a runtime with `any` composes the unmount signal and the timeout', () => {
  // The other half: the degradation must not cost the composed behaviour where the API
  // exists. Two signals reaching `any` proves it composed rather than silently dropped
  // one.
  const composed = []
  const AbortSignal = {
    timeout: (ms) => ({ kind: 'timeout', ms }),
    any(signals) {
      composed.push(signals)
      return { kind: 'composed', signals }
    },
  }

  const lifetime = { signal: { kind: 'unmount' } }
  const signal = signalFor(AbortSignal, lifetime)

  assert.equal(signal.kind, 'composed')
  assert.equal(composed.length, 1, '`any` must be called exactly once')
  // Spread into this realm before comparing: the array `any` received was built inside
  // the vm context, and `deepEqual` is realm-sensitive even when the contents match.
  const kinds = [...composed[0]].map((s) => s.kind)
  assert.deepEqual(kinds, ['unmount', 'timeout'], 'both signals belong in the race')
})

test('an environment without AbortSignal at all is left alone', () => {
  // `typeof AbortSignal !== 'undefined'` is the outer guard, and it must not be traded
  // away for the inner one: a sandbox with no AbortSignal gets `undefined`, which
  // `fetch` accepts, rather than a ReferenceError.
  const signal = signalFor(undefined)
  assert.equal(signal, null, 'no AbortSignal means no signal, not a crash')
})
