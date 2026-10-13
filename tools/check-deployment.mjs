/**
 * Is the *running* host executing this tree?
 *
 * Every other check in this repository is hermetic: it brings the plugin up in-process
 * and asserts on its behaviour. None of them can answer the question that actually
 * blocks the remaining verification, which is whether the profile is serving the code
 * that is on disk.
 *
 * That question has one honest answer: ask the running host and compare. So this script
 * makes claims about the host and then tries to falsify them, and it exits non-zero
 * while they remain unverified rather than printing a hopeful summary.
 *
 * What it observes:
 *
 *   1. The panel route. `GET /dsh-den` must answer 200 with JSON. Before activation it
 *      answers 404, because the route is registered by the code being activated.
 *   2. Whether state has ever been written. A host that has booted this plugin writes
 *      `state.json` on the way up; its absence means the running fiber predates the
 *      persistence work.
 *   3. Whether a browser request has ever reached the route, read back from
 *      `transport.browserReachable` in the status payload. This is the last unobserved
 *      seam, and it reports itself.
 *
 * It cannot see the Cordis Tool registry, because that is available only through the
 * Host's inspect providers. The tool count is therefore compared against the source
 * instead, and reported as a pointer rather than as a measurement.
 *
 * Usage:  node tools/check-deployment.mjs [baseUrl]
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { request } from 'node:http'

const BASE = process.argv[2] ?? 'http://127.0.0.1:19387'
const STATE_PATH = 'C:/Users/123/.dsh/den/state.json'

let failures = 0
function check(ok, label, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
  if (!ok) failures += 1
}

/** One GET, resolving to `{ status, body }` and never rejecting on a network error. */
function get(path, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const req = request(`${BASE}${path}`, { method: 'GET', timeout: timeoutMs }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        raw += chunk
      })
      res.on('end', () => resolve({ status: res.statusCode, body: raw }))
    })
    req.on('timeout', () => {
      req.destroy()
      resolve({ status: 0, body: '', error: `no answer within ${timeoutMs}ms` })
    })
    req.on('error', (error) => resolve({ status: 0, body: '', error: String(error.message) }))
    req.end()
  })
}

console.log(`dsh-den deployment check against ${BASE}\n`)

/* ------------------------------------------------- 1. the route the panel uses */

const route = await get('/dsh-den')
const reachable = route.status === 200

check(
  reachable,
  'GET /dsh-den answers 200',
  reachable ? '' : `got ${route.status || 'no answer'}${route.error ? ` (${route.error})` : ''}`,
)

let status = null
if (reachable) {
  try {
    const parsed = JSON.parse(route.body)
    status = parsed?.value ?? parsed
    check(status?.ok !== false, 'the route answers a well-formed envelope', '')
  } catch (error) {
    check(false, 'the route answers JSON', String(error.message))
  }
} else {
  console.log(
    '  note the route is registered by the code being activated, so 404 here means the\n' +
      '       running host predates it - not that it is misconfigured. Siblings that are\n' +
      '       already active answer 200 and prove the mechanism works:',
  )
  for (const sibling of ['/dsh-warden', '/dsh-vision-diff']) {
    const probe = await get(sibling)
    console.log(`       GET ${sibling} -> ${probe.status}`)
  }
}

/* ------------------------------------------------- 2. state written by a boot */

const stateExists = existsSync(STATE_PATH)
check(
  stateExists,
  'a boot has written den state.json',
  stateExists ? STATE_PATH : `${STATE_PATH} is absent, so the running fiber predates it`,
)
if (stateExists) {
  try {
    const stored = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
    console.log(`       stored keys: ${Object.keys(stored).sort().join(', ')}`)
  } catch {
    console.log('       (state.json exists but is not readable as JSON)')
  }
}

/* ------------------------------------------------- 3. the last unobserved seam */

// The field is named `browserReachable` but it records the first request of *any* kind to
// arrive, and this script is itself such a request: run twice and the second run reads the
// timestamp the first one set. So the check below is that a request has arrived, which is all
// the field can support; attributing it to a browser needs a timestamp from before the reading
// script started, which `verify-after-restart.mjs` has and this script does not.
if (status) {
  const transport = status.transport ?? {}
  const reached = transport.browserReachable ?? null
  check(
    reached !== null,
    'some HTTP request has reached the route',
    reached === null
      ? 'no request yet; open the den panel in the app and re-run'
      : `first reached at ${new Date(reached).toISOString()} — this does not say a browser sent it`,
  )
  console.log(`       claimedMounted: ${transport.claimedMounted}`)
  console.log(`       note: ${transport.note}`)
}

/* --------------------------------- 4. is the running instance built from this tree? */

console.log('\n=== is the running instance built from this tree? ===')

// The tool-name comparison above catches a *different build*. It cannot catch a changed
// *behaviour*, because editing a handler does not rename a tool — so a host running last
// week's grant path still lists this week's tool names and passes. The honest question is
// not "does the registry look right" but "did this instance load after the last edit", and
// the plugin already reports the one fact needed to answer it: `startedAt` is when the
// service was constructed, which is when the Host loaded these modules.
const srcDir = new URL('../src/', import.meta.url)
let newestMs = 0
let newestFile = ''
for (const entry of readdirSync(srcDir, { recursive: true })) {
  const name = String(entry)
  if (!/\.(js|mjs|json)$/.test(name)) continue
  const info = statSync(new URL(name, srcDir))
  if (!info.isFile()) continue
  if (info.mtimeMs > newestMs) {
    newestMs = info.mtimeMs
    newestFile = name
  }
}

const startedAtMs = status?.startedAt ? Date.parse(status.startedAt) : Number.NaN
if (Number.isNaN(startedAtMs)) {
  check(
    false,
    'the running instance says when it loaded',
    'startedAt is absent from the status payload, so staleness cannot be judged',
  )
} else {
  check(
    startedAtMs >= newestMs,
    'the running instance loaded this tree',
    startedAtMs >= newestMs
      ? `loaded ${status.startedAt}, newest source edit ${new Date(newestMs).toISOString()} (${newestFile})`
      : `the instance loaded at ${status.startedAt} but ${newestFile} changed at ` +
        `${new Date(newestMs).toISOString()} — the host is running code older than this tree, ` +
        'so restart DSH before believing anything below',
  )
}

/* ------------------------------------------------- what this script cannot see */

console.log(
  '\nNot observable from here: the Cordis Tool registry. Confirm the build by counting\n' +
    'den tools through the Host inspect provider (host / Tool / listTools) and comparing\n' +
    'against the source:',
)

const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
const names = [...source.matchAll(/name: '(den_[a-z_]+)'/g)].map((match) => match[1])
console.log(`       this tree registers ${names.length}: ${names.join(', ')}`)
console.log(
  '       a different count from the host means the running fiber is a different build.',
)

console.log(
  failures === 0
    ? '\nPASS - the running host is serving this tree, and it loaded it after the last edit.'
    : `\nFAIL - ${failures} claim(s) about the running host are unverified.`,
)
process.exit(failures === 0 ? 0 : 1)
