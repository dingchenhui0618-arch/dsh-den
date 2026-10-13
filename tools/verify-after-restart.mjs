/**
 * After the restart: is the running host serving this tree, end to end?
 *
 * Run this once the host has been restarted. It is the scripted form of the acceptance
 * the objective asks for, so the answer is a verdict rather than a claim.
 *
 *   node tools/verify-after-restart.mjs
 *
 * What it does, and why in this order:
 *
 *   1. `check-deployment.mjs` first, because everything else is meaningless if the host
 *      is still running the old build. It is the falsification step.
 *   2. Then the seam that has never once been observed: a browser request reaching the
 *      route. This is where a human clicking the panel is needed, and the script is
 *      explicit about that rather than implying it happened.
 *
 * **The script never claims the browser observation itself.** It records
 * `transport.browserReachable` *before* it sends anything, then sends its own probes and
 * re-reads. Any movement between those two readings is attributable to something that is
 * not this script — which, on a machine where nobody else is clicking, means the app.
 * Without that before/after split, the script's own requests would look exactly like a
 * user's, and the one observation that has never been made would still not be made.
 */

import { spawnSync } from 'node:child_process'
import { request } from 'node:http'

const BASE = process.argv[2] ?? 'http://127.0.0.1:19387'
const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

let failures = 0
function line(ok, label, detail) {
  console.log(`  ${ok === null ? '--  ' : ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
  if (ok === false) failures += 1
}

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

console.log(`dsh-den post-restart verification against ${BASE}\n`)

/* ------------------------------------------------ step 1: is this build the live one? */

console.log('step 1 - the deployment check (falsification)\n')
const deployment = spawnSync(process.execPath, [`${here}check-deployment.mjs`, BASE], {
  encoding: 'utf8',
})
process.stdout.write(deployment.stdout ?? '')
if (deployment.stderr) process.stderr.write(deployment.stderr)

const deployed = deployment.status === 0
if (!deployed) {
  console.log(
    '\nStopping here. The host is not serving this tree, so nothing below would be\n' +
      'evidence about it. Restart DSH and run this again.',
  )
  process.exit(1)
}

/* ------------------------------------- step 2: the seam that has never been observed */

console.log('\nstep 2 - the browser seam\n')

/** Read `transport.browserReachable` from the status payload. */
async function browserReachability() {
  const res = await get('/dsh-den', 8000)
  if (res.status !== 200) return { status: res.status, reached: null, read: false }
  try {
    const envelope = JSON.parse(res.body)
    const status = envelope?.value ?? envelope
    return { status: 200, reached: status?.transport?.browserReachable ?? null, read: true }
  } catch {
    return { status: 200, reached: null, read: false }
  }
}

const before = await browserReachability()
if (!before.read) {
  line(false, 'the route answers a readable status payload', `HTTP ${before.status}`)
} else if (before.reached !== null) {
  line(
    true,
    'a browser request has already reached the route',
    `first reached ${new Date(before.reached).toISOString()}`,
  )
} else {
  line(
    null,
    'no browser request has reached the route yet',
    'open the den panel in the app and click anything in it',
  )

  // The script's own probes: request twice with a visible gap, then re-read. Anything
  // that moves is not ours alone only if it moved before our first probe landed, so the
  // distinction is stated rather than assumed.
  const firstProbe = await get('/dsh-den')
  line(firstProbe.status === 200, 'the script can reach the route itself', `HTTP ${firstProbe.status}`)

  const after = await browserReachability()
  if (after.reached !== null) {
    line(
      true,
      'the route recorded a first browser reach',
      `first reached ${new Date(after.reached).toISOString()} - if you have not clicked, ` +
        'this script\'s own probe is the likely cause, and the browser observation is still open',
    )
  } else {
    line(
      false,
      'the route records browser reachability at all',
      'the status payload has transport.browserReachable = null and no request set it',
    )
  }
}

/* ------------------------------------------------------------------------- verdict */

console.log('')
if (failures === 0 && before.read && before.reached !== null) {
  console.log('PASS - the running host serves this tree and a browser request has reached it.')
} else if (failures === 0) {
  console.log(
    'PARTIAL - the running host serves this tree. The browser observation is still open:\n' +
      '          open the den panel, click something, then run this again.',
  )
} else {
  console.log(`FAIL - ${failures} check(s) did not pass.`)
}
process.exit(failures === 0 ? 0 : 1)
