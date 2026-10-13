/**
 * Every source file in this repository is actually in the repository.
 *
 * This exists because one was not. `.gitignore` had a bare `lib/`, which matches at any
 * depth, so `tools/lib/route-client.mjs` — a module three probes import — was never
 * committed. The local tree worked, every test passed, and the pushed repository was
 * broken: a clone would fail on a missing module. Worse, the pre-push check *confirmed*
 * that `lib/` was ignored, which read as a pass. The question that was never asked is the
 * one that matters: what else does this pattern match?
 *
 * An ignore rule is a claim about what is not source. Nothing was verifying that claim, so
 * this does: walk the source trees on disk and assert each file is tracked by git.
 *
 * Run: node tools/check-no-ignored-source.mjs
 */

import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['src', 'test', 'tools']
const EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml'])
/** Directories that are build output or dependencies by definition, wherever they appear. */
const SKIP = new Set(['node_modules', '.git', 'dist'])

function walk(root, prefix = '') {
  const found = []
  let entries
  try {
    entries = readdirSync(join(root, prefix), { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name)) continue
      found.push(...walk(root, relative))
    } else if (EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
      found.push(`${root}/${relative}`)
    }
  }
  return found
}

const tracked = new Set(
  execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean)
    .map((path) => path.split('\\').join('/')),
)

const onDisk = ROOTS.flatMap((root) => walk(root))
const untracked = onDisk.filter((path) => !tracked.has(path.split('\\').join('/')))

console.log(`=== ${onDisk.length} source file(s) under ${ROOTS.join(', ')}, cross-checked against git ===`)

if (untracked.length === 0) {
  console.log(`PASS - every source file on disk is tracked by git.`)
  process.exitCode = 0
} else {
  console.log(`FAIL - ${untracked.length} source file(s) exist on disk but are NOT in the repository:`)
  for (const path of untracked) {
    // Name the rule, so the fix is obvious rather than a hunt through .gitignore.
    let rule = null
    try {
      rule = execFileSync('git', ['check-ignore', '-v', path], { encoding: 'utf8' }).trim()
    } catch {
      rule = null
    }
    console.log(`  - ${path}${rule === null ? '  (not ignored - just never added)' : `\n      ignored by: ${rule}`}`)
  }
  console.log(
    '\nA file that exists locally and not in the repo works for you and fails for everyone\n' +
      'else. Anchor an over-broad ignore pattern, or move the file out of its way.',
  )
  process.exitCode = 1
}
