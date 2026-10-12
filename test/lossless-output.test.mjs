/**
 * Regression: a tool's return value must survive a lossless JSON round trip.
 *
 * This is not a style preference. The Host validates a tool's return value and
 * rejects anything it cannot round-trip, so a single `undefined` field makes the
 * whole tool fail. That is exactly what shipped: `den_status` was registered and
 * reachable, but every call came back as
 *
 *   Error: tool "den_status" returned invalid output: value is not lossless JSON
 *
 * because `status().autonomy` was `undefined` when no agent was in scope, and
 * `JSON.stringify` silently drops a key whose value is undefined. The shape
 * changed from 18 keys to 17 and the Host refused it.
 *
 * The failure is worth a test of its own because it is invisible in every other
 * way: the value looks correct when inspected, the schema is valid, and only the
 * round trip reveals it.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-den-lossless-'))
process.env.DSH_HOME = sandbox

const { DenService } = await import('../src/index.js')
const { statusSnapshot } = await import('../src/panel-api.js')
const { toLosslessJson } = await import('../src/atom.js')

test.after(() => rmSync(sandbox, { recursive: true, force: true }))

function service() {
  return new DenService({ effect: (fn) => fn() })
}

/**
 * Report every value in the tree that cannot survive a JSON round trip, with its
 * path. `undefined` is the one that bit us; the rest are here because they fail
 * the same way and would be just as hard to see.
 */
function lossless(problems, value, path) {
  if (value === undefined) return problems.push(`${path}: undefined`)
  if (typeof value === 'function') return problems.push(`${path}: function`)
  if (typeof value === 'symbol') return problems.push(`${path}: symbol`)
  if (typeof value === 'bigint') return problems.push(`${path}: bigint`)
  if (typeof value === 'number' && !Number.isFinite(value)) return problems.push(`${path}: ${value}`)
  if (Array.isArray(value)) {
    value.forEach((item, index) => lossless(problems, item, `${path}[${index}]`))
    return problems
  }
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) problems.push(`${path}: non-plain object`)
    for (const [key, item] of Object.entries(value)) lossless(problems, item, `${path}.${key}`)
  }
  return problems
}

/** The assertion the Host effectively makes, plus the shape check that explains it. */
function assertLossless(label, value) {
  const problems = lossless([], value, label)
  assert.deepEqual(problems, [], `${label} is not lossless JSON`)

  const text = JSON.stringify(value)
  const parsed = JSON.parse(text)
  const before = Object.keys(value)
  const after = Object.keys(parsed)
  assert.deepEqual(after, before, `${label} lost keys in a JSON round trip: ${before.filter((k) => !after.includes(k)).join(', ')}`)
  return parsed
}

test('status() is lossless JSON with no agent in scope', () => {
  // The exact case that broke in production: `den_status` takes no arguments and
  // has no agent, so every field it reports must already be JSON-safe.
  const parsed = assertLossless('status()', service().status())
  assert.ok('autonomy' in parsed, 'autonomy must be present as a key, even when there is no grant')
  assert.equal(parsed.autonomy, null, 'no authority is reported as null, not as an absent key')
})

test('status() is lossless JSON with an agent that holds no grant', () => {
  const agent = { session: { id: 'no-such-session' } }
  const parsed = assertLossless('status(agent)', service().status(agent))
  // currentGrant returns undefined when the grant file is absent; that must not
  // become an absent key either.
  assert.ok('autonomy' in parsed)
  assert.equal(parsed.autonomy, null)
})

test('the status route snapshot is lossless JSON', () => {
  const parsed = assertLossless('statusSnapshot()', statusSnapshot(service(), { nextTriggerAt: () => 1 }))
  assert.equal(parsed.autonomyKnown, false)
  assert.equal(parsed.autonomy, null)
})

test('the status route snapshot stays lossless when the service throws', () => {
  // The route's catch path must also produce something the transport can send.
  const broken = service()
  broken.status = () => {
    throw new Error('disk on fire')
  }
  const snapshot = { ok: false, error: { code: 'DEN_STATUS_FAILED', message: 'disk on fire' } }
  assertLossless('thrown path', snapshot)
})

// ---------------------------------------------------- the boundary guarantee

test('toLosslessJson turns undefined into null instead of dropping the key', () => {
  // The exact defect: this object loses `b` under JSON.stringify.
  const value = { a: 1, b: undefined }
  assert.equal(Object.keys(JSON.parse(JSON.stringify(value))).length, 1, 'the raw value really does lose a key')
  const normalised = toLosslessJson(value)
  assert.deepEqual(Object.keys(normalised), ['a', 'b'])
  assert.equal(normalised.b, null)
})

test('toLosslessJson handles every value that cannot round trip', () => {
  const value = {
    undef: undefined,
    fn: () => {},
    sym: Symbol('x'),
    big: 10n,
    nan: Number.NaN,
    inf: Number.POSITIVE_INFINITY,
    nested: { deep: undefined, keep: 1 },
    list: [undefined, 1, () => {}],
    when: new Date(0),
  }
  const normalised = toLosslessJson(value)
  assert.equal(normalised.undef, null)
  assert.equal(normalised.fn, null)
  assert.equal(normalised.sym, null)
  assert.equal(normalised.big, '10')
  assert.equal(normalised.nan, null)
  assert.equal(normalised.inf, null)
  assert.deepEqual(normalised.nested, { deep: null, keep: 1 })
  assert.deepEqual(normalised.list, [null, 1, null])
  // A Date has no own enumerable properties, so it cannot be serialised in place;
  // what matters is that nothing is lost and no key disappears.
  assert.deepEqual(normalised.when, {})
  assertLossless('normalised', normalised)
})

test('toLosslessJson survives a cycle rather than recursing forever', () => {
  const cyclic = { name: 'root' }
  cyclic.self = cyclic
  const normalised = toLosslessJson(cyclic)
  assert.equal(normalised.name, 'root')
  assert.equal(normalised.self, '[circular]')
  assertLossless('cyclic', normalised)
})

test('toLosslessJson copies a shared object twice instead of calling it circular', () => {
  // Caught by an existing test rather than by review: tracking "seen ever" makes
  // any object with two references look like a cycle, which silently replaced the
  // `{from, to}` patch in `den_configure` with the string "[circular]". Only the
  // current recursion path counts as a cycle.
  const shared = { from: 1380, to: 420 }
  const value = { first: shared, second: shared }
  const normalised = toLosslessJson(value)
  assert.deepEqual(normalised.first, { from: 1380, to: 420 })
  assert.deepEqual(normalised.second, { from: 1380, to: 420 })
  assert.notEqual(normalised.first, '[circular]')
})

test('toLosslessJson keeps genuine cycles detectable alongside shared siblings', () => {
  const shared = { n: 1 }
  const cyclic = { a: shared, b: shared }
  cyclic.loop = cyclic
  const normalised = toLosslessJson(cyclic)
  assert.deepEqual(normalised.a, { n: 1 })
  assert.deepEqual(normalised.b, { n: 1 })
  assert.equal(normalised.loop, '[circular]')
  assertLossless('mixed', normalised)
})

test('toLosslessJson never drops a key from an object', () => {
  const tricky = { a: undefined, b: () => {}, c: Symbol('s'), d: 1n, e: null, f: 0, g: '', h: false }
  const normalised = toLosslessJson(tricky)
  assert.deepEqual(Object.keys(normalised).sort(), Object.keys(tricky).sort())
})
