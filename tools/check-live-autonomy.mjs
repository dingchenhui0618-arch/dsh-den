/**
 * Exercise the autonomy boundary against the *running* host, and refuse to claim
 * anything the host does not actually do.
 *
 * Why this exists
 * ---------------
 * Every hermetic test passes while the field behaviour of the authority gate is
 * unknown, because the fixtures provide the authority the real host has to earn. This
 * script asks the live host the one question the fixtures cannot: *can an agent obtain
 * standing autonomy without a human?* The expected answer is no, and the value is in
 * checking the several ways it could accidentally become yes.
 *
 * What it does NOT prove
 * ----------------------
 * It never grants autonomy, so it says nothing about what an *admitted* wake does. That
 * path needs a human to cite a token and approve the call, and cannot be reached from
 * here by design.
 *
 * Usage: node tools/check-live-autonomy.mjs [--port 19387]
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { callRoute, finish } from './support/route-client.mjs'

const ROUTE = '/dsh-den'
const portArg = process.argv.indexOf('--port')
const PORT = portArg >= 0 ? Number(process.argv[portArg + 1]) : 19387

const problems = []
const observations = []

function ok(label, detail) {
  observations.push({ ok: true, label, detail })
  console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`)
}

function bad(label, detail) {
  problems.push({ label, detail })
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
}

async function post(body) {
  const answer = await callRoute({ port: PORT, route: ROUTE, action: body.action, input: body })
  if (!answer.envelope) {
    throw new Error(`${ROUTE} did not answer JSON (status ${answer.status}): ${answer.body.slice(0, 200)}`)
  }
  return { status: answer.status, envelope: answer.envelope }
}

/** A session name that cannot be a real conversation. */
const SYNTHETIC = 'live-autonomy-probe'

function triggerFiles() {
  const dir = join(homedir(), '.dsh', 'den', 'triggers')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
}

console.log(`dsh-den live autonomy probe -> http://127.0.0.1:${PORT}${ROUTE}\n`)

// 1. The route has to be reachable at all, or nothing below means anything.
{
  const { status, envelope } = await post({ action: 'status' })
  if (status !== 200 || envelope.ok !== true) {
    bad('the route answers', `status ${status}, ok ${envelope.ok}`)
    console.log('\nRESULT: FAIL — the host did not serve this tree, so no claim below is supported.')
    // `process.exit(1)` is right here and wrong at the end of a probe, and the difference is
    // whether a handle is still open. The crash this file was fixed for came from undici's
    // global keep-alive pool closing underneath the exit; this probe now uses `node:http`
    // with `agent: false`, and this guard runs after that one request has already answered
    // and closed. Stopping immediately is the point — running the rest of the checks against
    // a host that did not answer would bury the real cause under a cascade of invented ones.
    // The normal endings below use `finish()`, which lets the loop drain.
    process.exit(1)
  }
  ok('the route answers', 'HTTP 200 with a well-formed envelope')
}

// 2. Asking for autonomy mints a token. It must not, by itself, create authority.
//
//    There is deliberately no step here asking the route to classify the grant call: the
//    panel route accepts exactly the six actions in `PANEL_ACTIONS`, and gate
//    classification is not one of them. That question is answered by `den_explain_gate`
//    (which reports `verdict: "ask"` for `den_set_autonomy`) and by the static fact that
//    `src/gate.js` leaves it off the allow list — neither of which belongs in a probe that
//    only talks to the live host.
let token = null
{
  const { envelope } = await post({ action: 'autonomy/request', autonomy: true, sessionId: SYNTHETIC })
  token = envelope?.value?.token ?? null
  if (envelope.ok === true && typeof token === 'string' && token.length > 0) {
    ok('autonomy/request mints a single-use token', `${token.length} characters`)
  } else {
    bad('autonomy/request mints a token', JSON.stringify(envelope).slice(0, 160))
  }

  const after = await post({ action: 'status', sessionId: SYNTHETIC })
  const autonomy = after.envelope?.value?.autonomy ?? null
  const known = after.envelope?.value?.autonomyKnown
  if (autonomy === null && known === false) {
    ok('minting the token created no authority', 'autonomy null, autonomyKnown false')
  } else {
    bad('minting the token created no authority', `autonomy ${JSON.stringify(autonomy)}, known ${known}`)
  }
}

// 4. Confirming without human evidence is refused. Twice, to see whether the failure
//    spends the token — a refused attempt that burns the token would turn one typo into
//    a re-request, and worse, would make the token a bearer credential for a single try.
//
//    The route reports refusals as `{ ok: false, error: { code, message } }`, so
//    `String(error)` is "[object Object]" and two refusals only compare equal if the
//    comparison reaches the fields. Getting that wrong makes this check pass or fail for
//    a reason that has nothing to do with the token.
function refusalOf(envelope) {
  if (envelope?.ok !== false) return null
  const e = envelope.error ?? envelope
  return `${e?.code ?? ''}:${e?.message ?? ''}`
}

if (token) {
  const first = await post({
    action: 'autonomy/confirm',
    token,
    autonomy: true,
    humanMessageId: 'not-a-real-message',
    sessionId: SYNTHETIC,
  })
  const firstRefusal = refusalOf(first.envelope)
  if (firstRefusal) ok('confirm without human evidence is refused', firstRefusal)
  else bad('confirm without human evidence is refused', JSON.stringify(first.envelope).slice(0, 160))

  const second = await post({
    action: 'autonomy/confirm',
    token,
    autonomy: true,
    humanMessageId: 'still-not-a-real-message',
    sessionId: SYNTHETIC,
  })
  const secondRefusal = refusalOf(second.envelope)
  if (firstRefusal && secondRefusal === firstRefusal) {
    ok('the refused attempt did not spend the token', 'the same refusal came back verbatim')
  } else {
    // A "no matching autonomy request" here would mean the first attempt consumed it.
    bad(
      'the refused attempt did not spend the token',
      `first ${JSON.stringify(firstRefusal)}, second ${JSON.stringify(secondRefusal)}`,
    )
  }
}

// 5. After all of that, the host must still report no authority anywhere.
{
  const { envelope } = await post({ action: 'status', sessionId: SYNTHETIC })
  const value = envelope?.value ?? {}
  if (value.autonomy === null && value.autonomyKnown === false) {
    ok('no authority exists after the probe', 'autonomy null, autonomyKnown false')
  } else {
    bad('no authority exists after the probe', JSON.stringify(value.autonomy))
  }
}

// 6. A trigger left due would be re-asked on every heartbeat. Check the disk rather than
//    trusting that the probe cleaned up after itself.
{
  const files = triggerFiles()
  if (files.length === 0) ok('no trigger is left due', '~/.dsh/den/triggers/ is empty')
  else bad('no trigger is left due', `${files.length} file(s): ${files.slice(0, 3).join(', ')}`)
}

console.log('')
if (problems.length === 0) {
  console.log('RESULT: PASS — an agent cannot obtain standing autonomy from the live host.')
  console.log('        What an *admitted* wake does is still unverified; that needs a human.')
  finish(0)
} else {
  console.log(`RESULT: FAIL — ${problems.length} problem(s):`)
  for (const p of problems) console.log(`  - ${p.label}: ${p.detail}`)
  finish(1)
}
