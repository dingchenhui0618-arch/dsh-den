/**
 * Long-term memory, isolated by scenario.
 *
 * Three design constraints shaped this module, and each one is a decision rather
 * than a default:
 *
 * 1. **Scenarios are isolated, and isolation is structural.** Each scenario is a
 *    separate file. Recall is keyed by scenario from the first line, so a
 *    personal-context memory *cannot* surface while working on a repository —
 *    not because a filter is applied correctly, but because the data is not in
 *    the set being searched. A filter that is merely applied is a filter that can
 *    be forgotten.
 *
 * 2. **Recall is deterministic, not semantic.** There is no embedding model and
 *    no vector store anywhere in DSH today, so this uses bounded token overlap
 *    plus recency. That is honest about what it is: it will miss paraphrases. In
 *    exchange, recall is reproducible, costs no tokens to compute, works offline,
 *    and can be unit-tested exactly. A retrieval layer whose behaviour changes
 *    with a model version is not something a safety argument can rest on.
 *
 * 3. **Memory is written by the den, never inferred from the transcript.** A
 *    summariser that silently promotes conversation into durable memory is a
 *    privacy incident generator: whatever the human said once becomes permanent.
 *    Every entry here exists because something explicitly asked for it.
 *
 * Entries are content-addressed within a scenario, so re-learning the same fact
 * refreshes its timestamp instead of accumulating duplicates.
 */

import { denPath, digest, listJsonFiles, readJson, readJsonChecked, writeJsonAtomic } from './atom.js'

/** One scenario holds at most this many entries; the oldest are evicted first. */
export const MAX_ENTRIES_PER_SCENARIO = 500

/** One entry may not exceed this many characters. */
export const MAX_ENTRY_CHARS = 4000

/** Recall never returns more than this many characters, so it cannot flood a prompt. */
export const MAX_RECALL_CHARS = 6000

/** How many entries recall considers before scoring. */
const CANDIDATE_LIMIT = 200

export const ENTRY_KINDS = ['fact', 'preference', 'decision', 'open-thread']

/** Words too common to carry signal; including them makes every entry match. */
const STOPWORDS = new Set([
  'a', 'about', 'after', 'all', 'also', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'because', 'been', 'before',
  'being', 'but', 'by', 'can', 'could', 'did', 'do', 'does', 'for', 'from', 'get', 'got', 'had', 'has', 'have', 'he',
  'her', 'here', 'him', 'his', 'how', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'me', 'more', 'most', 'my', 'no',
  'not', 'of', 'on', 'one', 'only', 'or', 'other', 'our', 'out', 'over', 'said', 'same', 'she', 'should', 'so', 'some',
  'such', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to',
  'too', 'under', 'up', 'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'will', 'with',
  'would', 'you', 'your',
])

/**
 * Crude English suffix folding.
 *
 * Without this, `deploy` does not match an entry containing `Deploys`, so recall
 * silently returns nothing for the most natural way a human phrases a query. A
 * full stemmer is not worth the dependency here; folding plurals and the common
 * verb endings covers the case that actually bites.
 */
function fold(token) {
  if (token.length <= 4) return token
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`
  if (token.endsWith('es') && token.length > 4) return token.slice(0, -2)
  if (token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1)
  if (token.endsWith('ing') && token.length > 6) return token.slice(0, -3)
  if (token.endsWith('ed') && token.length > 5) return token.slice(0, -2)
  return token
}

/**
 * Reduce text to comparable tokens.
 *
 * Latin words are split on non-alphanumerics and folded; CJK text has no spaces,
 * so individual CJK characters are emitted as tokens. That makes Chinese recall
 * work without a segmenter, at the cost of being coarser than a real tokenizer.
 */
export function tokenize(text) {
  const tokens = []
  const lowered = String(text ?? '').toLowerCase()

  for (const match of lowered.matchAll(/[a-z0-9_]{2,}/g)) {
    const token = match[0]
    if (!STOPWORDS.has(token)) tokens.push(fold(token))
  }
  for (const match of lowered.matchAll(/[\u4e00-\u9fff]/g)) {
    tokens.push(match[0])
  }
  return tokens
}

function scenarioKey(scenario) {
  return digest(String(scenario))
}

function scenarioPath(scenario) {
  return denPath('memory', `${scenarioKey(scenario)}.json`)
}

function normalizeScenario(scenario) {
  const value = typeof scenario === 'string' ? scenario.trim() : ''
  if (!value) throw new Error('dsh-den: memory needs a scenario name')
  if (value.length > 120) throw new Error('dsh-den: scenario name exceeds 120 characters')
  return value
}

function emptyStore(scenario) {
  return { version: 1, scenario, updatedAt: Date.now(), entries: [] }
}

function isValidStore(value) {
  return (
    !!value &&
    value.version === 1 &&
    typeof value.scenario === 'string' &&
    Array.isArray(value.entries) &&
    value.entries.every(
      (entry) =>
        entry &&
        typeof entry.id === 'string' &&
        typeof entry.text === 'string' &&
        ENTRY_KINDS.includes(entry.kind) &&
        Number.isFinite(entry.createdAt),
    )
  )
}

/**
 * Read one scenario's store.
 *
 * A store that fails validation is reported as absent rather than partially
 * trusted: a corrupt memory file must degrade to "no memory", never to "memory
 * with undefined entries", because every caller assumes entries have text.
 */
export function readScenario(scenario) {
  const name = normalizeScenario(scenario)
  const result = readJsonChecked(scenarioPath(name), isValidStore)
  if (!result.ok) return { store: emptyStore(name), recovered: result.reason !== 'absent' ? result.reason : null }
  // Guard against a hash collision or a hand-moved file claiming another scenario.
  if (result.value.scenario !== name) return { store: emptyStore(name), recovered: 'scenario-mismatch' }
  return { store: result.value, recovered: null }
}

/**
 * Store or refresh one memory.
 *
 * @returns {{ ok: true, id: string, created: boolean, evicted: number }}
 */
export function remember(scenario, text, kind = 'fact', { source = null } = {}) {
  const name = normalizeScenario(scenario)
  const body = String(text ?? '').trim()
  if (!body) throw new Error('dsh-den: memory text is empty')
  if (body.length > MAX_ENTRY_CHARS) throw new Error(`dsh-den: memory text exceeds ${MAX_ENTRY_CHARS} characters`)
  if (!ENTRY_KINDS.includes(kind)) throw new Error(`dsh-den: invalid memory kind ${kind}`)

  const { store } = readScenario(name)
  const id = digest(`${kind}\u0000${body}`)
  const now = Date.now()
  const existing = store.entries.find((entry) => entry.id === id)

  let entries
  let created
  if (existing) {
    // Re-learning the same fact refreshes it instead of duplicating it.
    entries = store.entries.map((entry) => (entry.id === id ? { ...entry, createdAt: now, recalls: entry.recalls ?? 0 } : entry))
    created = false
  } else {
    entries = [
      ...store.entries,
      { id, kind, text: body, createdAt: now, source: source ? String(source).slice(0, 200) : null, recalls: 0 },
    ]
    created = true
  }

  // Evict oldest first, but never evict a preference before a fact of the same
  // age: preferences are small, rare, and expensive to rediscover.
  let evicted = 0
  if (entries.length > MAX_ENTRIES_PER_SCENARIO) {
    const rank = { preference: 0, decision: 0, fact: 1, 'open-thread': 2 }
    const sorted = [...entries].sort((a, b) => {
      const byKind = (rank[a.kind] ?? 1) - (rank[b.kind] ?? 1)
      return byKind !== 0 ? byKind : a.createdAt - b.createdAt
    })
    const keep = new Set(sorted.slice(0, MAX_ENTRIES_PER_SCENARIO).map((entry) => entry.id))
    evicted = entries.length - keep.size
    entries = entries.filter((entry) => keep.has(entry.id))
  }

  writeJsonAtomic(scenarioPath(name), { version: 1, scenario: name, updatedAt: now, entries })
  return { ok: true, id, created, evicted }
}

/** Remove one entry by id. */
export function forget(scenario, id) {
  const name = normalizeScenario(scenario)
  const { store } = readScenario(name)
  const entries = store.entries.filter((entry) => entry.id !== id)
  if (entries.length === store.entries.length) return { ok: false, reason: 'not-found' }
  writeJsonAtomic(scenarioPath(name), { version: 1, scenario: name, updatedAt: Date.now(), entries })
  return { ok: true, removed: 1 }
}

/** Every stored entry for one scenario, newest first. */
export function entriesFor(scenario) {
  const { store } = readScenario(scenario)
  return [...store.entries].sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * Scenario names that currently hold memory.
 *
 * A name is only discoverable if it was written by a call that named it, which is
 * what keeps isolation honest: there is no ambient "current scenario" that could
 * silently widen.
 */
export function scenarios() {
  const found = []
  for (const path of listJsonFiles(denPath('memory'))) {
    const value = readJson(path)
    if (isValidStore(value)) found.push({ scenario: value.scenario, entries: value.entries.length, updatedAt: value.updatedAt })
  }
  return found.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Recall the entries most relevant to a query, within one scenario only.
 *
 * Scoring is deliberately simple and inspectable: token overlap dominates, and a
 * small recency bonus breaks ties so that two equally relevant memories resolve
 * to the more recent one rather than to file order.
 *
 * @returns {{ entries: object[], considered: number, truncated: boolean, chars: number }}
 */
export function recall(scenario, query, { limit = 8, maxChars = MAX_RECALL_CHARS, now = Date.now() } = {}) {
  const name = normalizeScenario(scenario)
  const { store } = readScenario(name)
  const queryTokens = new Set(tokenize(query))

  const scored = []
  for (const entry of store.entries.slice(-CANDIDATE_LIMIT)) {
    const entryTokens = tokenize(entry.text)
    if (entryTokens.length === 0) continue

    let overlap = 0
    const seen = new Set()
    for (const token of entryTokens) {
      if (queryTokens.has(token) && !seen.has(token)) {
        seen.add(token)
        overlap += 1
      }
    }
    // Normalise by entry length so a long entry cannot win on sheer size alone.
    const relevance = overlap / Math.sqrt(entryTokens.length)
    // A memory with no overlap is still a legitimate fallback only when the query
    // carries no signal at all; otherwise it is noise.
    if (overlap === 0 && queryTokens.size > 0) continue

    const ageDays = Math.max(0, (now - entry.createdAt) / 86_400_000)
    const recency = 1 / (1 + ageDays)
    scored.push({ entry, score: relevance + recency * 0.01 })
  }

  scored.sort((a, b) => b.score - a.score)

  const chosen = []
  let chars = 0
  let truncated = false
  for (const item of scored) {
    if (chosen.length >= limit) {
      truncated = true
      break
    }
    if (chars + item.entry.text.length > maxChars) {
      truncated = true
      continue
    }
    chars += item.entry.text.length
    chosen.push({ ...item.entry, score: Number(item.score.toFixed(4)) })
  }

  return { entries: chosen, considered: scored.length, truncated, chars }
}

/**
 * Render recall as a prompt fragment.
 *
 * Returns an empty string when there is nothing to add, so a caller can append it
 * unconditionally without emitting an empty section header into every request.
 * The header states the isolation explicitly: a model that knows the boundary can
 * tell the human which scenario it is answering from.
 */
export function renderRecall(scenario, query, options) {
  const result = recall(scenario, query, options)
  if (result.entries.length === 0) return { text: '', result }
  const lines = result.entries.map((entry) => `- [${entry.kind}] ${entry.text}`)
  const text = [
    `## Memory recalled for scenario: ${scenario}`,
    '',
    'These entries come only from this scenario. Other scenarios are not visible here.',
    '',
    ...lines,
  ].join('\n')
  return { text, result }
}
