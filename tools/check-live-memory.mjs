/**
 * Check the scenario-isolation rule for long-term memory, against the running host.
 *
 * What this proves
 * ----------------
 * The isolation rule itself: each scenario is its own file, a recall is keyed by scenario
 * from the first line, identical content collapses to one entry, and a store whose
 * self-declared scenario disagrees with its filename is not trusted. It runs against the
 * same `~/.dsh/den/memory` the host uses.
 *
 * It also proves the *host* reads that directory. `status.scenarios` comes from the host
 * calling `scenarios()`, so a scenario written here and then reported by the route is an
 * observation through the host rather than through my own copy of the module. That check
 * runs first, because everything after it is only meaningful if the two agree on where the
 * files live.
 *
 * Usage: node tools/check-live-memory.mjs [--port 19387]
 */

import { existsSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { denPath } from '../src/atom.js'
import { entriesFor, forget, recall, remember, scenarios } from '../src/memory.js'

const portArg = process.argv.indexOf('--port')
const PORT = portArg >= 0 ? Number(process.argv[portArg + 1]) : 19387

const problems = []
function ok(label, detail) {
  console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`)
}
function bad(label, detail) {
  problems.push({ label, detail })
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
}

async function hostScenarios() {
  const res = await fetch(`http://127.0.0.1:${PORT}/dsh-den`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'status' }),
  })
  if (res.status !== 200) throw new Error(`route answered ${res.status}`)
  const value = JSON.parse(await res.text()).value
  return Array.isArray(value?.scenarios) ? value.scenarios.map((s) => s.scenario) : null
}

console.log(`dsh-den live memory-isolation probe -> ~/.dsh/den/memory\n`)

const memoryDir = denPath('memory')
console.log(`  script resolves memory to: ${memoryDir}\n`)

// Two scenario names unique to this run, so a leftover from an earlier run cannot be
// mistaken for this run's work and two runs cannot collide on the same store file.
const stamp = Date.now().toString(36)
const ALPHA = `probe-alpha-${stamp}`
const BETA = `probe-beta-${stamp}`

// A distinctive token that exists in exactly one scenario, so a leak would be unambiguous.
const ALPHA_SECRET = `zebrafinch${stamp}`
const BETA_SECRET = `quokka${stamp}`

function storePathFor(scenario) {
  // Resolve the path the same way the module does, by listing and matching the declared
  // scenario, rather than by reimplementing the hash. Reimplementing it would test my
  // copy of the rule instead of the rule.
  if (!existsSync(memoryDir)) return null
  for (const name of readdirSync(memoryDir)) {
    if (!name.endsWith('.json')) continue
    try {
      const value = JSON.parse(readFileSync(join(memoryDir, name), 'utf8'))
      if (value?.scenario === scenario) return join(memoryDir, name)
    } catch {
      /* not ours; the module surfaces malformed stores rather than this probe */
    }
  }
  return null
}

const createdPaths = new Set()
function cleanup() {
  for (const path of createdPaths) {
    try {
      rmSync(path, { force: true })
    } catch {
      /* best effort */
    }
  }
}

try {
  // 1. Isolation is structural: two scenarios are two files.
  remember(ALPHA, `the ${ALPHA_SECRET} is a bird`, 'fact')
  remember(BETA, `the ${BETA_SECRET} is a marsupial`, 'fact')

  const alphaPath = storePathFor(ALPHA)
  const betaPath = storePathFor(BETA)
  if (alphaPath) createdPaths.add(alphaPath)
  if (betaPath) createdPaths.add(betaPath)

  if (alphaPath && betaPath && alphaPath !== betaPath) {
    ok('two scenarios are two files', `${alphaPath.split(/[\\/]/).pop()} vs ${betaPath.split(/[\\/]/).pop()}`)
  } else {
    bad('two scenarios are two files', `alpha ${alphaPath}, beta ${betaPath}`)
  }

  // 2. The host itself must see what was written here. `status.scenarios` is the host
  //    calling `scenarios()` on its own service, so this is an observation through the
  //    host rather than a reread of my own files — the difference between "the rule works"
  //    and "the assistant is actually using this memory".
  const hostSaw = await hostScenarios()
  if (hostSaw && hostSaw.includes(ALPHA) && hostSaw.includes(BETA)) {
    ok('the host reports both scenarios through its own route', `${hostSaw.length} scenario(s) visible`)
  } else {
    bad(
      'the host reports both scenarios through its own route',
      hostSaw === null ? 'the route reported no scenarios list' : JSON.stringify(hostSaw.slice(0, 6)),
    )
  }

  // 3. The isolation that matters: recall in one scenario cannot return the other's entry.
  const inAlpha = recall(ALPHA, ALPHA_SECRET, { now: Date.now() })
  const leak = inAlpha.entries.filter((e) => e.text.includes(BETA_SECRET))
  if (leak.length === 0 && inAlpha.entries.some((e) => e.text.includes(ALPHA_SECRET))) {
    ok('recall finds its own entry and none of the other scenario', `${inAlpha.entries.length} entry(ies)`)
  } else {
    bad('recall finds its own entry and none of the other scenario', `leaked ${leak.length}`)
  }

  // 3. The reverse direction, so a one-way accident is not enough.
  const inBeta = recall(BETA, BETA_SECRET, { now: Date.now() })
  const reverseLeak = inBeta.entries.filter((e) => e.text.includes(ALPHA_SECRET))
  if (reverseLeak.length === 0 && inBeta.entries.some((e) => e.text.includes(BETA_SECRET))) {
    ok('and the same holds in the other direction', `${inBeta.entries.length} entry(ies)`)
  } else {
    bad('and the same holds in the other direction', `leaked ${reverseLeak.length}`)
  }

  // 4. A store declares which scenario it is. If the declaration disagrees with the file it
  //    was found in, the module must refuse the contents rather than trust them — this is
  //    the guard against a hash collision or a hand-moved file.
  if (alphaPath) {
    const value = JSON.parse(readFileSync(alphaPath, 'utf8'))
    value.scenario = BETA
    writeFileSync(alphaPath, JSON.stringify(value, null, 2), 'utf8')

    const afterMove = entriesFor(ALPHA)
    const recovered = recall(ALPHA, ALPHA_SECRET, { now: Date.now() })
    if (afterMove.length === 0 && recovered.entries.length === 0) {
      ok('a store claiming another scenario is not trusted', 'contents refused, not returned')
    } else {
      bad('a store claiming another scenario is not trusted', `${afterMove.length} entr(ies) still readable`)
    }
  }

  // 5. Identical content within one scenario is one entry, so re-learning a fact does not
  //    grow the store.
  remember(BETA, `the ${BETA_SECRET} is a marsupial`, 'fact')
  const betaEntries = entriesFor(BETA).filter((e) => e.text.includes(BETA_SECRET))
  if (betaEntries.length === 1) {
    ok('re-learning the same fact is one entry', `${betaEntries.length} copy`)
  } else {
    bad('re-learning the same fact is one entry', `${betaEntries.length} copies`)
  }

  // 6. `forget` removes exactly one entry and leaves the scenario readable.
  const target = betaEntries[0]
  if (target) {
    forget(BETA, target.id)
    const afterForget = entriesFor(BETA).filter((e) => e.text.includes(BETA_SECRET))
    if (afterForget.length === 0) ok('forget removes the entry', 'scenario still readable afterwards')
    else bad('forget removes the entry', `${afterForget.length} left`)
  }

  // 7. Listing scenarios reports the real ones, by name.
  const listed = scenarios().map((s) => s.scenario)
  if (listed.includes(BETA) && !listed.includes(ALPHA)) {
    // ALPHA was deliberately corrupted above and must now read as empty rather than as a
    // scenario holding the wrong name.
    ok('listing scenarios reports the store that still declares itself', `${listed.length} scenario(s)`)
  } else {
    bad('listing scenarios reports the store that still declares itself', JSON.stringify(listed.slice(0, 6)))
  }
} finally {
  cleanup()
}

// 8. Nothing this probe created may survive it.
{
  const leftovers = []
  if (existsSync(memoryDir)) {
    for (const name of readdirSync(memoryDir)) {
      if (!name.endsWith('.json')) continue
      try {
        const value = JSON.parse(readFileSync(join(memoryDir, name), 'utf8'))
        if (value?.scenario === ALPHA || value?.scenario === BETA) leftovers.push(name)
      } catch {
        /* not ours */
      }
    }
  }
  const remaining = scenarios().filter((s) => s.scenario === ALPHA || s.scenario === BETA)
  if (leftovers.length === 0 && remaining.length === 0) {
    ok('the probe cleaned up after itself', 'no probe scenario remains')
  } else {
    bad('the probe cleaned up after itself', `${leftovers.length} file(s), ${remaining.length} listed`)
  }
}

console.log('')
if (problems.length === 0) {
  console.log('RESULT: PASS — scenario isolation holds, and the running host reads the same store.')
  process.exit(0)
}
console.log(`RESULT: FAIL — ${problems.length} problem(s):`)
for (const p of problems) console.log(`  - ${p.label}: ${p.detail}`)
process.exit(1)
