/**
 * Does the wake-delivery surface exist on the Host we are actually running on?
 *
 * This probe exists because the delivery path was broken by an assumption about an API.
 * The plugin used to deliver a wake with `subagents.sendMessage(agent, sessionId, ...)`,
 * reading it as "send a message to a conversation" when it is a restricted parent/child
 * channel — so every admitted wake failed with "delivery requires the exact live parent
 * agent", and nothing in the test suite noticed because the fakes accepted anything.
 *
 * The replacement calls `Agent.followup`. That method is **not in any service signature**:
 * `agents.get`/`agents.resume` are declared to return `Agent`, and `Agent` is declared as
 * `{ readonly id }`. `followup` is a method on the live agent object the factory builds.
 * So no amount of reading the contract answers "will delivery work here" — it has to be
 * measured on the running Host.
 *
 * The check therefore reports a *shape*, and it distinguishes three things that are easy
 * to confuse:
 *
 *   1. the service is not wired in this profile at all;
 *   2. the service is wired but no agent is live right now, so the capability cannot be
 *      observed yet;
 *   3. a live agent exists and its `followup` is (or is not) callable.
 *
 * Case 2 is reported as `sawLiveAgent: false`, never as a pass and never as a failure —
 * "I could not look" is not "it is not there", and the whole defect being fixed here came
 * from treating an unobserved assumption as an established fact.
 *
 * Run: node tools/check-wake-api.mjs [baseUrl]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const BASE = process.argv[2] ?? 'http://127.0.0.1:19387'
const ROUTE = '/dsh-den'
/** Where the probe remembers the host process it last looked at. */
const LAST_SEEN = join(tmpdir(), 'dsh-den-wake-api-seen.json')

function get(url) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET', timeout: 15000 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('timeout', () => req.destroy(new Error('timed out')))
    req.on('error', reject)
    req.end()
  })
}

const results = []
const check = (ok, label, detail) => {
  results.push({ ok: Boolean(ok), label, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}${detail === undefined ? '' : `\n       ${detail}`}`)
}

console.log(`=== the wake-delivery surface, as the running Host reports it (${BASE}) ===`)

let payload
try {
  const response = await get(`${BASE}${ROUTE}`)
  check(response.status === 200, `the panel route answers (${response.status})`)
  payload = JSON.parse(response.body)
} catch (error) {
  check(false, 'the panel route answers', `the running Host did not answer: ${error.message}`)
  console.log('\nRESULT: FAIL — cannot measure the wake surface without the Host.')
  process.exit(1)
}

const wake = payload?.value?.wakeApi
const reported = wake !== undefined && wake !== null

// A build that predates the field and a build that has it but is not loaded look the same
// from outside. Say both, name the one transferable fact, and start a clock so a restart
// can be told apart from a reload by whether this number changed.
const startedAt = payload?.value?.startedAt ?? null
const pid = payload?.value?.pid ?? null
const observedNow = { pid, startedAt, at: new Date().toISOString() }
// Read the previous run, then record this one. One file, read-then-write, so the rotation
// cannot get out of step with itself.
let previous = null
try {
  previous = JSON.parse(readFileSync(LAST_SEEN, 'utf8'))
} catch {
  previous = null
}
try {
  writeFileSync(LAST_SEEN, JSON.stringify(observedNow, null, 2))
} catch {
  /* a probe must not fail because it cannot keep a note */
}
const sameProcess = previous !== null && previous.pid === pid && previous.startedAt === startedAt

check(
  reported,
  'the status payload carries the wake-surface measurement',
  reported
    ? undefined
    : 'absent from the payload the running Host serves.\n' +
      `       This process: pid ${pid ?? '?'}, started ${startedAt ?? '?'}` +
      (previous === null ? '' : ` (previous run: pid ${previous.pid ?? '?'}, started ${previous.startedAt ?? '?'})`) +
      `\n       Same process as the previous run: ${sameProcess ? 'yes — nothing has been reloaded, so the field cannot' +
        ' appear no matter how correct the source is' : 'no — a new process is serving an old payload, which is a real problem'}.` +
      '\n       The source is correct either way; what this measures is whether the running' +
      ' host has loaded it.',
)

if (!reported) {
  console.log(`\nRESULT: FAIL — the wake surface could not be measured on this Host.`)
  process.exit(1)
}

check(wake.checked === true, 'the measurement actually ran', wake.checked ? undefined : `reason: ${wake.reason}`)

if (wake.checked) {
  const contract = wake.contract ?? {}
  check(contract.get === true, 'the agents service exposes get()')
  check(contract.resume === true, 'the agents service exposes resume()')

  // The interesting part. `followup` is deliberately NOT in the service signatures, so a
  // probe that demanded it there would be testing the wrong surface.
  check(
    contract.followup === undefined,
    '`followup` is absent from the service contract, as expected',
    'a service-level `followup` would mean the plugin could have checked this statically',
  )

  if (wake.sawLiveAgent) {
    const live = wake.liveAgent ?? {}
    check(typeof live.id === 'string', 'a live agent was found and identified', `id: ${live.id}`)
    check(
      live.followup === true,
      'the live agent carries a callable followup()',
      live.followup === true
        ? 'this is the capability the delivery path needs, measured on the running Host'
        : 'MISSING — a wake admitted on this Host would throw and be retried forever',
    )
  } else {
    // Not a failure. Report it as the limit of what this run observed.
    console.log(
      'SKIP — no agent is live right now, so `followup` cannot be observed on a real object.\n' +
        '       The capability is therefore still unverified on this Host; do not read this run as a pass.',
    )
  }
}

const failures = results.filter((entry) => !entry.ok)
console.log(
  failures.length
    ? `\nRESULT: FAIL — ${failures.length} of ${results.length} checks failed.`
    : `\nRESULT: PASS — ${results.length} checks, and the delivery surface is the one this Host actually offers.`,
)
process.exit(failures.length ? 1 : 0)
