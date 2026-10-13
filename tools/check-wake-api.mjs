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

import { existsSync, readFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:19387'
const ROUTE = '/dsh-den'

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

const wake = payload.wakeApi
const reported = wake !== undefined && wake !== null

// What the shipped build emits. The running Host may still be the previous build, and
// saying so is more useful than reporting a product defect that is really a stale process.
const statusPath = join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh'), 'den', 'state.json')
const stateHasWake = existsSync(statusPath) && readFileSync(statusPath, 'utf8').includes('wakeApi')

check(
  reported,
  'the status payload carries the wake-surface measurement',
  reported
    ? undefined
    : `absent. This Host is running a build from before the field existed (state.json mentions it: ${stateHasWake}). ` +
      'That is a stale process, not a product defect — restart DSH and re-run.',
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
