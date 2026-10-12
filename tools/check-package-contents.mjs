/**
 * What actually ships when this package is published or installed from a tarball.
 *
 * This exists because a plugin is installed from a packed tarball, not from a git
 * checkout, so anything a shipped command depends on must be inside `files`.
 * Measured failure this guards against: `test/` and `tools/` were both excluded
 * while `package.json` still advertised `npm test` and `npm run check:*`, so a
 * consumer who ran them would hit "no test files found" on a package that passed
 * every check in this repository.
 *
 * The npm file rules are reimplemented here rather than shelling out to
 * `npm pack`, so the check works offline and in a sandbox that cannot spawn npm.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
let failures = 0
function check(ok, label, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
  if (!ok) failures += 1
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/**
 * Always included regardless of `files` — but only if it exists. npm's rule is
 * "these are always included", not "these are always present", and listing a
 * non-existent file here would inflate the count with files that are not there.
 */
const ALWAYS_NAMES = ['package.json', 'README.md', 'LICENSE', 'LICENCE', 'CHANGELOG.md']

/** Never included, even if a `files` entry would match. */
const NEVER = [/^node_modules([\\/]|$)/, /^\.git([\\/]|$)/, /\.log$/, /^\.DS_Store$/]

const shipped = new Set()
for (const name of ALWAYS_NAMES) {
  try {
    if (statSync(join(root, name)).isFile()) shipped.add(name)
  } catch {
    /* not present, so not shipped — and the `files` list is what decides coverage */
  }
}

function walk(abs) {
  const info = statSync(abs)
  if (info.isFile()) {
    const rel = relative(root, abs).split(sep).join('/')
    if (!NEVER.some((re) => re.test(rel))) shipped.add(rel)
    return
  }
  if (!info.isDirectory()) return
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    walk(join(abs, entry.name))
  }
}

for (const entry of pkg.files ?? []) {
  const abs = join(root, entry)
  try {
    walk(abs)
  } catch {
    /* a `files` entry that does not exist ships nothing, which is the bug we want to see */
  }
}

console.log(`\n=== the package would ship ${shipped.size} files ===`)
for (const file of [...shipped].sort()) console.log(`      ${file}`)

/* ------------------------------------- every path the package itself refers to */

console.log('\n=== referenced paths are present in the package ===')

const referenced = new Map()
for (const [key, value] of Object.entries(pkg.exports ?? {})) {
  referenced.set(`exports[${key}]`, String(value).replace(/^\.\//, ''))
}
if (pkg.main) referenced.set('main', pkg.main.replace(/^\.\//, ''))
if (pkg.dsh?.bundle?.patch) referenced.set('dsh.bundle.patch', pkg.dsh.bundle.patch.replace(/^\.\//, ''))

for (const [label, path] of referenced) {
  check(shipped.has(path), `${label} → ${path}`)
}

/* ------------------------------ the advertised commands must be runnable as shipped */

console.log('\n=== advertised npm scripts can actually run ===')

for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
  // Only commands that read files from the package are checked; `git`/`npm` glue is not.
  const paths = [...command.matchAll(/([\w./*-]+\.(?:mjs|js|cjs|json|yml))/g)].map((m) => m[1])
  for (const raw of paths) {
    const needsGlob = raw.includes('*')
    const dir = raw.includes('/') ? raw.slice(0, raw.lastIndexOf('/')) : '.'
    const present = needsGlob
      ? [...shipped].some((file) => file.startsWith(dir + '/'))
      : shipped.has(raw)
    check(present, `script "${name}" needs ${raw}`, needsGlob ? `(any file under ${dir}/)` : '')
  }
}

/* ------------------------------------------------------ and nothing embarrassing */

console.log('\n=== the package does not ship local or private material ===')

const forbidden = [
  [/^\.den-state/, 'local runtime state'],
  [/^\.env/, 'environment file'],
  [/credentials/i, 'credential-shaped filename'],
  [/^_tmp/, 'scratch directory'],
  [/\.ps1$/i, 'local script'],
]
for (const [re, what] of forbidden) {
  const hit = [...shipped].filter((file) => re.test(file))
  check(hit.length === 0, `no ${what}`, hit.join(', '))
}

console.log('')
console.log(failures ? `FAIL — ${failures} packaging check(s) failed` : 'PASS — the packed package is complete')
process.exit(failures ? 1 : 0)
