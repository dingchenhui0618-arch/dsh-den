/**
 * Install the way a consumer would, then load what was installed.
 *
 * `check-package-contents.mjs` reimplements npm's `files` rules and checks them
 * statically, so it can run offline. That answers "would these files ship?" but not
 * "does the thing that ships actually work?" — and the objective is that this plugin is
 * *installed* on a real host, which makes installability a claim worth testing rather
 * than assuming.
 *
 * So this packs a real tarball, extracts it into a directory with no access to this
 * repository, and brings the plugin up from there:
 *
 *   - `npm pack`       → a tarball built by npm's own rules, not by a reimplementation
 *   - extract          → the exact bytes a consumer receives
 *   - exercise         → import the host half, apply it to a host, and check that the
 *                        tools, the guard and the route are all registered
 *   - resolve          → the client entry and the Cordis patch, by the paths
 *                        `package.json` advertises
 *
 * Deletion happens in a `finally`, and it happens even on failure: a check that leaves
 * temp directories behind is a check people stop running.
 *
 * Usage: node tools/check-install.mjs
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

let failures = 0
function check(ok, label, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
  if (!ok) failures += 1
}

const workdir = mkdtempSync(join(tmpdir(), 'dsh-den-install-'))
let packed
try {
  /* ------------------------------------------------------------------ pack */

  // `--json` keeps the output parseable; `--pack-destination` keeps the tarball out of
  // the repository, which is also why this never runs inside it.
  let packOutput
  try {
    packOutput = execFileSync(
      npm,
      ['pack', '--json', '--pack-destination', workdir, root],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' },
    )
  } catch (error) {
    check(false, 'npm pack succeeds', String(error.stderr || error.message).slice(0, 200))
    process.exit(1)
  }

  let tarballName
  try {
    const entries = JSON.parse(packOutput)
    tarballName = entries[0].filename
  } catch (error) {
    check(false, 'npm pack reports a tarball', String(error.message))
    process.exit(1)
  }

  const tarball = join(workdir, tarballName)
  check(existsSync(tarball), 'the tarball exists on disk', tarballName)

  /* --------------------------------------------------------------- extract */

  // `tar` is the same program npm uses for this container format, so the extraction is
  // not a second implementation of untarring either.
  const extracted = join(workdir, 'package')
  execFileSync('tar', ['-xzf', tarball, '-C', workdir], { stdio: ['ignore', 'pipe', 'pipe'] })
  check(existsSync(join(extracted, 'package.json')), 'the tarball extracts to package/')

  const installed = JSON.parse(readFileSync(join(extracted, 'package.json'), 'utf8'))
  check(installed.name === 'dsh-den', 'the installed package keeps its name', installed.name)

  /* -------------------------------------------------- what package.json promises */

  const clientEntry = installed.exports?.['./client']
  check(
    typeof clientEntry === 'string' && existsSync(join(extracted, clientEntry)),
    'the advertised client entry resolves on disk',
    clientEntry,
  )

  const patch = installed.dsh?.bundle?.patch
  check(
    typeof patch === 'string' && existsSync(join(extracted, patch)),
    'the advertised Cordis patch resolves on disk',
    patch,
  )

  const main = installed.main
  check(
    typeof main === 'string' && existsSync(join(extracted, main)),
    'the advertised host entry resolves on disk',
    main,
  )

  check(
    installed.dependencies === undefined || Object.keys(installed.dependencies).length === 0,
    'the package declares no runtime dependencies, so an install cannot pull one in',
    JSON.stringify(installed.dependencies ?? {}),
  )

  /* ------------------------------------------- bring the installed copy up */

  // Import the *extracted* copy, not the checkout. `pathToFileURL` because a bare
  // Windows path is not a valid specifier for a dynamic import.
  const hostUrl = pathToFileURL(join(extracted, main)).href
  const installedHost = await import(hostUrl)

  check(typeof installedHost.apply === 'function', 'the installed host half exports apply')
  check(Array.isArray(installedHost.inject), 'the installed host half declares its injects', JSON.stringify(installedHost.inject))

  // The shipping `fakeHost` comes from the extracted tree too, so the exercised code and
  // the harness are the same bytes a consumer gets.
  const supportUrl = pathToFileURL(join(extracted, 'test', 'support', 'host.mjs')).href
  const { fakeHost } = await import(supportUrl)
  const { ctx, state } = fakeHost()

  process.env.DSH_HOME = join(workdir, 'den-home')
  installedHost.apply(ctx)

  check(state.tools.length > 0, 'the installed plugin registers its tools', `${state.tools.length} tools`)
  check(state.guards.length === 1, 'the installed plugin registers the monotonic approval guard')
  check(state.routes.length >= 1, 'the installed plugin mounts its panel route')

  const routePaths = state.routes.map((route) => route.path)
  check(
    routePaths.includes('/dsh-den'),
    'the mounted route path is the one the client bundle calls',
    routePaths.join(', '),
  )

  // The client half greps its own API constant; comparing the two files stops the route
  // and the browser from drifting apart in an installed copy.
  const clientSource = readFileSync(join(extracted, clientEntry), 'utf8')
  const apiMatch = clientSource.match(/var API = '([^']+)'/)
  check(
    apiMatch?.[1] === '/dsh-den',
    'the client bundle calls the same path the host mounts',
    apiMatch?.[1],
  )

  // `require` resolution, the way a module loader would do it after install.
  const require = createRequire(pathToFileURL(join(extracted, 'package.json')).href)
  check(require.resolve('./package.json').length > 0, 'the installed package is resolvable as a module')
} finally {
  rmSync(workdir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nPASS - the packed package installs and loads.' : `\nFAIL - ${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
