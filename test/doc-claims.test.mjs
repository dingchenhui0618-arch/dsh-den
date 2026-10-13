/**
 * Public claims that a reader could check in a minute, checked here instead.
 *
 * This repository keeps finding "a public claim with no command under it" — a README count edited
 * by hand while the thing it counted had moved on. The numbers below are all cheaply measurable,
 * so they are measured rather than maintained: the README says eleven model-facing tools and six
 * panel actions and no dependencies at all, and each of those is compared against the code.
 *
 * The suite's own count is deliberately **not** here. A test cannot count the tests it is part of
 * without counting itself, so that number stays what it always was: a transcript of a real run,
 * re-run rather than edited.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const { registerTools } = await import('../src/index.js')
const { PANEL_ACTIONS } = await import('../src/panel-api.js')

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** The number words the README actually uses, so a claim is not skipped for being spelled out. */
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 }

/** Every number a README sentence claims for `thing`, e.g. "11 model-facing tools" / "six …". */
function claimedCounts(thing) {
  const found = []
  const pattern = new RegExp(`([a-z]+|\\d+)((?:\\s+[a-z-]+){0,2}\\s+)${thing}\\b`, 'gi')
  let match
  while ((match = pattern.exec(readme)) !== null) {
    const raw = match[1].toLowerCase()
    const value = /^\d+$/.test(raw) ? Number(raw) : WORDS[raw]
    if (Number.isFinite(value)) {
      found.push(value)
    } else {
      // A capture that is not a number must not swallow the phrase. In "the six named actions" the
      // first match starts at "and", spans "the six", and captures "and" — so the number the
      // sentence actually claims is consumed by a failed attempt and never examined. That failure
      // reads exactly like the README not making the claim at all, which is how this test first
      // reported a sentence that was right there.
      pattern.lastIndex = match.index + 1
    }
  }
  return found
}

test('the README count of model-facing tools matches what activation registers', () => {
  const registered = []
  registerTools({ register: (definition) => registered.push(definition) }, {})
  assert.equal(registered.length, 11, 'activation registers eleven tools')
  const claimed = claimedCounts('model-facing tools')
  assert.ok(claimed.length >= 1, 'the README still makes the claim (it is in the Status line)')
  assert.deepEqual(
    [...new Set(claimed)],
    [11],
    `the README claims ${claimed.join('/')} model-facing tools and the plugin registers ${registered.length}`,
  )
})

test('the README count of panel actions matches the action list', () => {
  // The README's own words are "the six named actions", so the claim is looked for as written
  // rather than as I remembered writing it — the first version searched for "panel actions" and
  // failed on a claim that was there all along.
  const claimed = claimedCounts('named actions')
  assert.ok(claimed.length >= 1, 'the README still makes the claim')
  assert.deepEqual([...new Set(claimed)], [6], 'the panel exposes six actions')
  assert.equal(PANEL_ACTIONS.length, 6, 'and the exported list agrees')
  assert.equal(new Set(PANEL_ACTIONS).size, 6, 'with no duplicates hiding a missing one')
})

test('"no dependencies at all" is a claim about a file anyone can read', () => {
  // The strongest public claim the README makes: a fresh clone runs the suite with only a Node
  // binary. It stops being true the first time someone adds a dependency and forgets this line.
  assert.equal(pkg.dependencies, undefined, 'the package declares no runtime dependencies')
  assert.equal(pkg.peerDependencies, undefined, 'and none are pushed onto the profile either')
  assert.equal(pkg.devDependencies, undefined, 'and the suite needs no test framework installed')
  assert.match(readme, /no dependencies at all/, 'the README still makes the claim')
})
