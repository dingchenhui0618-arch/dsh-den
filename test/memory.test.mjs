/**
 * Tests for scenario-isolated long-term memory.
 *
 * The load-bearing test here is isolation. If a personal-context memory can
 * surface while the den is working on a repository, the "per-scenario" claim is
 * false and the feature is worse than having no memory at all, because the human
 * would have been told the boundary exists.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-den-memory-'))
process.env.DSH_HOME = sandbox

/** The memory directory the module writes into. */
const memoryDir = () => join(sandbox, 'den', 'memory')

const {
  MAX_ENTRY_CHARS,
  MAX_ENTRIES_PER_SCENARIO,
  entriesFor,
  forget,
  readScenario,
  recall,
  remember,
  renderRecall,
  scenarios,
  tokenize,
} = await import('../src/memory.js')
const { digest } = await import('../src/atom.js')

test.beforeEach(() => {
  rmSync(memoryDir(), { recursive: true, force: true })
  // Corruption tests write by hand and run first, so the directory must exist
  // independently of any successful `remember` call.
  mkdirSync(memoryDir(), { recursive: true })
})
test.after(() => rmSync(sandbox, { recursive: true, force: true }))

test('a scenario name is required', () => {
  assert.throws(() => remember('', 'x'), { message: /needs a scenario name/ })
  assert.throws(() => remember('   ', 'x'), { message: /needs a scenario name/ })
})

test('an entry round-trips', () => {
  const result = remember('personal', 'The human prefers morning meetings before 10:00.', 'preference')
  assert.equal(result.ok, true)
  assert.equal(result.created, true)

  const entries = entriesFor('personal')
  assert.equal(entries.length, 1)
  assert.equal(entries[0].kind, 'preference')
  assert.match(entries[0].text, /morning meetings/)
})

test('re-learning the same fact refreshes instead of duplicating', () => {
  const first = remember('personal', 'Allergic to shellfish.')
  const second = remember('personal', 'Allergic to shellfish.')
  assert.equal(first.id, second.id)
  assert.equal(second.created, false)
  assert.equal(entriesFor('personal').length, 1, 'a repeated fact must not accumulate')
})

test('the same fact in a different kind is a different memory', () => {
  remember('personal', 'Ship on Friday.', 'fact')
  remember('personal', 'Ship on Friday.', 'decision')
  assert.equal(entriesFor('personal').length, 2)
})

test('an invalid kind and oversized text are refused', () => {
  assert.throws(() => remember('personal', 'x', 'gossip'), { message: /invalid memory kind/ })
  assert.throws(() => remember('personal', 'x'.repeat(MAX_ENTRY_CHARS + 1)), { message: /exceeds/ })
  assert.throws(() => remember('personal', '   '), { message: /empty/ })
})

// ------------------------------------------------------------- ISOLATION

test('recall never crosses scenarios', () => {
  remember('personal', 'The human is allergic to shellfish.')
  remember('work', 'The staging database password rotates every 30 days.')
  remember('content', 'The audience prefers short posts.')

  const personal = recall('personal', 'shellfish')
  assert.equal(personal.entries.length, 1)
  assert.match(personal.entries[0].text, /shellfish/)

  // The decisive assertion: a memory stored elsewhere does not appear here, even
  // when the query matches it strongly.
  const work = recall('work', 'shellfish')
  assert.equal(work.entries.length, 0, 'a personal fact must not surface in the work scenario')

  const content = recall('content', 'database password')
  assert.equal(content.entries.length, 0, 'a work fact must not surface in the content scenario')
})

test('an empty scenario recalls nothing and does not fall back to another', () => {
  remember('personal', 'Something private.')
  const result = recall('a-scenario-that-was-never-used', 'private')
  assert.equal(result.entries.length, 0)
})

test('scenario listing reports only scenarios that were written', () => {
  remember('alpha', 'one')
  remember('beta', 'two')
  const names = scenarios().map((item) => item.scenario).sort()
  assert.deepEqual(names, ['alpha', 'beta'])
})

test('each scenario is a separate file, so isolation is structural', () => {
  remember('one-scenario', 'x')
  remember('another-scenario', 'y')
  const first = readScenario('one-scenario')
  const second = readScenario('another-scenario')
  assert.equal(first.store.scenario, 'one-scenario')
  assert.equal(second.store.scenario, 'another-scenario')
  assert.equal(first.store.entries.length, 1)
  assert.equal(second.store.entries.length, 1)
})

// -------------------------------------------------------------- CORRUPTION

test('a corrupt store degrades to no memory rather than partial memory', () => {
  const path = join(sandbox, 'den', 'memory', `${digest('broken')}.json`)
  writeFileSync(path, '{ not json at all')
  const { store, recovered } = readScenario('broken')
  assert.equal(store.entries.length, 0)
  assert.ok(recovered)
  assert.equal(recall('broken', 'anything').entries.length, 0)
})

test('a store claiming another scenario is rejected', () => {
  const path = join(sandbox, 'den', 'memory', `${digest('expected')}.json`)
  writeFileSync(path, JSON.stringify({ version: 1, scenario: 'something-else', updatedAt: 1, entries: [] }))
  const { store, recovered } = readScenario('expected')
  assert.equal(store.entries.length, 0)
  assert.equal(recovered, 'scenario-mismatch')
})

test('a store with malformed entries is rejected whole', () => {
  const path = join(sandbox, 'den', 'memory', `${digest('partial')}.json`)
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      scenario: 'partial',
      updatedAt: 1,
      entries: [{ id: 'a', text: 'good', kind: 'fact', createdAt: 1 }, { id: 'b' }],
    }),
  )
  assert.equal(readScenario('partial').store.entries.length, 0)
})

// ---------------------------------------------------------------- RECALL

test('recall ranks the more relevant entry first', () => {
  remember('work', 'The CI pipeline runs on every push to main.')
  remember('work', 'Lunch is at noon.')
  remember('work', 'Deploys are manual and require the release checklist.')

  const result = recall('work', 'when do deploys happen')
  assert.ok(result.entries.length >= 1)
  assert.match(result.entries[0].text, /Deploys/i)
})

test('recall returns nothing for a query that matches nothing', () => {
  remember('work', 'The build is green.')
  const result = recall('work', 'quantum chromodynamics')
  assert.equal(result.entries.length, 0)
})

test('a query with no signal at all still returns recent memory', () => {
  remember('work', 'Something to fall back on.')
  const result = recall('work', '')
  assert.equal(result.entries.length, 1, 'an empty query should fall back to recency, not to nothing')
})

test('recall respects the entry limit', () => {
  for (let index = 0; index < 20; index += 1) {
    remember('many', `Fact number ${index} about the deploy process.`)
  }
  const result = recall('many', 'deploy process', { limit: 3 })
  assert.ok(result.entries.length <= 3)
  assert.equal(result.truncated, true)
})

test('recall respects the character budget', () => {
  for (let index = 0; index < 10; index += 1) {
    remember('budget', `Deploy note ${index} ${'x'.repeat(900)}`)
  }
  const result = recall('budget', 'deploy note', { maxChars: 1200 })
  assert.ok(result.chars <= 1200, `chars ${result.chars} must stay within the budget`)
})

test('CJK text is recalled without a segmenter', () => {
  remember('personal', '他对花生过敏，点菜时要注意。')
  const result = recall('personal', '花生过敏')
  assert.equal(result.entries.length, 1)
  assert.match(result.entries[0].text, /花生/)
})

// ---------------------------------------------------------------- THE WINDOW

test('a memory re-learned after the scenario outgrew the window is still recalled', () => {
  // The defect this pins, measured: `remember` refreshes a re-learned fact's `createdAt` *in place*,
  // and recall used to score `entries.slice(-200)` - the last two hundred in file order. So the one
  // memory that was reinforced most recently kept its original position, fell out of the window, and
  // became unreachable: `entriesFor()[0]` said it was the newest thing in the scenario while
  // `recall` returned nothing. The entries most likely to be lost that way are exactly the ones a
  // human bothered to say twice.
  const needle = remember('window', 'the zephyrine departure gate is the one nearest the annex')
  // A control that lives *outside* the window once the scenario grows, and matches its query on a
  // token no filler shares - so its absence can only be explained by the window, not by scoring.
  const oldest = remember('window', 'the retired quokka marker is documented in the annex')
  for (let index = 0; index < 250; index += 1) {
    remember('window', `filler entry ${index} about unrelated widget calibration`)
  }
  const relearned = remember('window', 'the zephyrine departure gate is the one nearest the annex')

  assert.equal(relearned.created, false, 'the same text must refresh rather than duplicate')
  assert.equal(entriesFor('window')[0].id, needle.id, 'it is the newest entry by createdAt')

  const found = recall('window', 'zephyrine departure gate annex')
  assert.ok(
    found.entries.some((entry) => entry.id === needle.id),
    `the newest memory in the scenario must be reachable, got ${JSON.stringify(found.entries.map((e) => e.id))}`,
  )

  // The reverse control: the window still bounds the work. `oldest` matches its query perfectly and
  // is now the oldest by createdAt, so "consider every entry" would also pass this test without it.
  const outside = recall('window', 'retired quokka marker annex')
  assert.ok(
    !outside.entries.some((entry) => entry.id === oldest.id),
    'an entry older than the whole window is not scored, and that bound must still hold',
  )
})

test('recall reports how many entries it looked at, separately from how many matched', () => {
  // `considered` used to be `scored.length`: the number that *matched*, reported under a name that
  // promises the number *looked at*. A query sharing no tokens with most of a scenario printed
  // `considered: 0` while two hundred entries had in fact been scored, which is the opposite of what
  // a caller reads it for.
  for (let index = 0; index < 250; index += 1) {
    remember('accounting', `filler entry ${index} about unrelated widget calibration`)
  }
  const result = recall('accounting', 'zephyrine')
  assert.equal(result.considered, 200, 'the window, not the match count')
  assert.equal(result.stored, 250, 'and the scenario is bigger than the window, which is now visible')
  assert.equal(result.scored, 0, 'nothing matched, which is a different fact')

  const matched = recall('accounting', 'widget calibration')
  assert.equal(matched.considered, 200)
  assert.ok(matched.scored > 0, 'the match count is still reported, under its own name')
})

// ---------------------------------------------------------------- PRUNING

test('the entry cap holds and eviction is reported', () => {
  for (let index = 0; index < MAX_ENTRIES_PER_SCENARIO + 5; index += 1) {
    remember('capped', `Entry ${index}`)
  }
  const entries = entriesFor('capped')
  assert.ok(entries.length <= MAX_ENTRIES_PER_SCENARIO, `got ${entries.length}`)
})

test('a preference survives eviction pressure better than a fact', () => {
  // Fill past the cap with facts, then add a preference at the end.
  for (let index = 0; index < MAX_ENTRIES_PER_SCENARIO; index += 1) {
    remember('ranked', `Padding fact ${index}`)
  }
  remember('ranked', 'Always address the human formally.', 'preference')
  const kinds = entriesFor('ranked').map((entry) => entry.kind)
  assert.ok(kinds.includes('preference'), 'a preference must not be the first thing evicted')
})

test('forgetting removes exactly one entry and reports a miss', () => {
  const created = remember('forget-me', 'Temporary detail.')
  assert.equal(forget('forget-me', created.id).ok, true)
  assert.equal(entriesFor('forget-me').length, 0)
  assert.equal(forget('forget-me', created.id).ok, false)
  assert.equal(forget('forget-me', created.id).reason, 'not-found')
})

// --------------------------------------------------------------- RENDERING

test('rendering states the isolation boundary in the prompt', () => {
  remember('work', 'Deploys require the release checklist.')
  const { text, result } = renderRecall('work', 'deploy')
  assert.ok(result.entries.length > 0)
  assert.match(text, /scenario: work/)
  assert.match(text, /only from this scenario/i)
  assert.match(text, /release checklist/)
})

test('rendering an empty recall yields an empty string, not an empty header', () => {
  const { text, result } = renderRecall('nothing-here', 'anything')
  assert.equal(text, '', 'an empty section header must not be appended to every request')
  assert.equal(result.entries.length, 0)
})

// -------------------------------------------------------------- TOKENIZER

test('the tokenizer drops stopwords so common words cannot match everything', () => {
  const tokens = tokenize('the quick brown fox and the lazy dog')
  assert.ok(!tokens.includes('the'))
  assert.ok(!tokens.includes('and'))
  assert.ok(tokens.includes('quick'))
  assert.ok(tokens.includes('brown'))
})

test('the tokenizer emits CJK characters individually and handles mixed text', () => {
  const tokens = tokenize('部署 deploy 流程')
  assert.ok(tokens.includes('部'))
  assert.ok(tokens.includes('署'))
  assert.ok(tokens.includes('deploy'))
  assert.ok(!tokens.includes(' '))
})

test('the tokenizer survives non-string input', () => {
  assert.deepEqual(tokenize(null), [])
  assert.deepEqual(tokenize(undefined), [])
  // A number stringifies to searchable text rather than throwing; `42` is
  // legitimate content, so this asserts the coercion rather than an empty result.
  assert.deepEqual(tokenize(42), ['42'])
})
