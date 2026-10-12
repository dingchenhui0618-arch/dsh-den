/**
 * Reproduce the live tool-output failure: `den_status` ran but the Host rejected
 * its return value as "not lossless JSON".
 *
 * The Host validates a tool's return value and refuses anything it cannot
 * round-trip. So the question is narrow: which field of `status()` is not plain
 * JSON? Rather than guessing, this walks the real object and reports every value
 * whose type cannot survive a JSON round trip, then does the round-trip check the
 * Host does.
 *
 * Run: node tools/diagnose-status-output.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-den-diag-'))
process.env.DSH_HOME = sandbox

const { DenService } = await import('../src/index.js')

/** Minimal context: enough for the service constructor, which is all status() needs. */
const ctx = { effect: (fn) => fn() }

const service = new DenService(ctx)
const status = service.status()

console.log('=== top-level keys and their typeof ===')
for (const [key, value] of Object.entries(status)) {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  const bad = value === undefined ? '   <-- undefined: dropped by JSON.stringify' : ''
  console.log(`  ${key.padEnd(22)} ${type}${bad}`)
}

/**
 * Which values cannot survive a JSON round trip?
 *
 * `undefined` disappears (lossy), functions and symbols vanish, BigInt throws,
 * NaN/Infinity become null, and a class instance loses its prototype. The Host's
 * "lossless" check is stricter than JSON.stringify, so all of these are suspects.
 */
const problems = []
function walk(value, path) {
  if (value === undefined) {
    problems.push(`${path}: undefined`)
    return
  }
  if (typeof value === 'function') {
    problems.push(`${path}: function`)
    return
  }
  if (typeof value === 'symbol') {
    problems.push(`${path}: symbol`)
    return
  }
  if (typeof value === 'bigint') {
    problems.push(`${path}: bigint`)
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) problems.push(`${path}: non-finite number ${value}`)
    return
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`))
    return
  }
  // A plain object is required; a class instance would lose its prototype.
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    problems.push(`${path}: non-plain object (${value.constructor?.name ?? 'null-proto'})`)
  }
  for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`)
}

walk(status, 'status')

console.log('\n=== values that cannot survive a lossless JSON round trip ===')
if (problems.length === 0) console.log('  none found')
for (const problem of problems) console.log(`  ${problem}`)

console.log('\n=== JSON.stringify round trip ===')
let text
try {
  text = JSON.stringify(status)
  console.log(`  stringify ok, ${text.length} chars`)
} catch (error) {
  console.log(`  stringify threw: ${error.message}`)
}
if (text) {
  const parsed = JSON.parse(text)
  const before = Object.keys(status).length
  const after = Object.keys(parsed).length
  console.log(`  top-level keys before ${before}, after ${after}${before === after ? '' : '  <-- KEYS LOST, this is the lossiness'}`)
  for (const key of Object.keys(status)) {
    if (!(key in parsed)) console.log(`    lost: ${key} (was ${JSON.stringify(status[key])})`)
  }
}

rmSync(sandbox, { recursive: true, force: true })
