/**
 * The freshness judgement: can a long-lived process tell a human that it is running
 * older code than the tree beside it?
 *
 * These are the arithmetic and the honesty rules. What they cannot test is the thing
 * that matters most — whether the *running* instance loaded the code that answers the
 * question — so every case below is paired with a live claim in
 * `tools/check-deployment.mjs`, which asks the real host and compares its answer against
 * an independent walk of this repo.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  FRESHNESS_TOLERANCE_MS,
  collectSourceEdits,
  judgeFreshness,
  newestSourceEdit,
} from '../src/freshness.js'

const START = '2026-10-13T08:43:05.676Z'
const START_MS = Date.parse(START)

test('the newest edit is picked by time, not by position in the listing', () => {
  // The listing order is whatever the filesystem says, and the defect this module exists
  // to catch is exactly "the newest thing is not where you looked".
  const newest = newestSourceEdit([
    { file: 'src/client/client.js', mtimeMs: START_MS - 60_000 },
    { file: 'src/index.js', mtimeMs: START_MS + 2_400_000 },
    { file: 'src/atom.js', mtimeMs: START_MS - 90_000 },
  ])
  assert.equal(newest.file, 'src/index.js')
  assert.equal(newest.mtimeMs, START_MS + 2_400_000)
})

test('an entry without a date never wins, because a missing date is not evidence', () => {
  // If a record with no mtime took part in the comparison, every instance would look
  // freshly loaded for the wrong reason — and a check that passes for the wrong reason
  // is the failure mode this whole repository is built around.
  const newest = newestSourceEdit([
    { file: 'src/undated.js' },
    { file: 'src/dated.js', mtimeMs: START_MS - 1000 },
    { file: 'src/also-undated.js', mtimeMs: 'not a number' },
  ])
  assert.equal(newest.file, 'src/dated.js')
  assert.equal(newestSourceEdit([]), null, 'nothing to compare is null, not a winner')
})

test('a source file edited after the instance loaded makes it stale', () => {
  const verdict = judgeFreshness({
    startedAt: START,
    newestSourceAt: START_MS + 2_460_000,
    newestSourceFile: 'client\\client.js',
  })
  assert.equal(verdict.known, true)
  assert.equal(verdict.stale, true)
  assert.match(verdict.detail, /client\\client\.js was edited 2460s after/)
  assert.match(verdict.detail, /running older code/)
})

test('a source file edited before the instance loaded does not', () => {
  const verdict = judgeFreshness({
    startedAt: START,
    newestSourceAt: START_MS - 240_000,
    newestSourceFile: 'src/triggers.js',
  })
  assert.equal(verdict.known, true)
  assert.equal(verdict.stale, false)
  assert.match(verdict.detail, /240s older/)
})

test('an edit inside the tolerance window is not evidence of a stale process', () => {
  // Both boundaries, because "grace" is the kind of rule that silently grows.
  assert.equal(
    judgeFreshness({ startedAt: START, newestSourceAt: START_MS + FRESHNESS_TOLERANCE_MS }).stale,
    false,
    'exactly the tolerance still counts as loaded',
  )
  assert.equal(
    judgeFreshness({ startedAt: START, newestSourceAt: START_MS + FRESHNESS_TOLERANCE_MS + 1 }).stale,
    true,
    'one millisecond past it does not',
  )
})

test('not knowing is reported as not knowing, never as fresh', () => {
  // The point of the module in one assertion: an instance that cannot date itself must
  // not be rounded to "fine". `stale: false` and `known: false` are different answers.
  const undated = judgeFreshness({ startedAt: null, newestSourceAt: START_MS })
  assert.equal(undated.known, false)
  assert.equal(undated.stale, null)
  assert.notEqual(undated.stale, false)
  assert.match(undated.detail, /did not say when it loaded/)

  const undatedTree = judgeFreshness({ startedAt: START, newestSourceAt: null })
  assert.equal(undatedTree.known, false)
  assert.equal(undatedTree.stale, null)
  assert.match(undatedTree.detail, /no dated source file/)
})

test('the walk finds nested files, including the client half', () => {
  // A restart has to pick up both halves, and the client half is the one that is easy to
  // forget: it is not imported by the host, so nothing else in this repo would notice.
  const root = mkdtempSync(join(tmpdir(), 'den-freshness-'))
  try {
    mkdirSync(join(root, 'client'))
    writeFileSync(join(root, 'index.js'), '// host half\n')
    writeFileSync(join(root, 'client', 'client.js'), '// client half\n')
    const entries = collectSourceEdits(root)
    const files = entries.map((entry) => entry.file.replace(/\\/g, '/')).sort()
    assert.deepEqual(files, ['client/client.js', 'index.js'])
    for (const entry of entries) {
      assert.ok(Number.isFinite(entry.mtimeMs), `${entry.file} carries a usable mtime`)
    }
    const newest = newestSourceEdit(entries)
    assert.ok(files.includes(newest.file.replace(/\\/g, '/')), 'the winner is one of the files found')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
