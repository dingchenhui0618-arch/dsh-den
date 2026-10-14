/**
 * The live drill for the one thing no instance has ever shown: a wake the kernel *admits*.
 *
 * Everything around it is verified. The grant path runs offline end to end, and so does the wake
 * path — `test/cold-start.test.mjs` mints a real panel token, puts it in a human message, grants
 * through the tool, stores a trigger, moves the clock past a restart, and watches the wake get
 * delivered and recorded. What has never happened is the two **joined on a running host**, and
 * the reason was never in this plugin: the approval policy is a side effect of the profile's
 * permission preset, and under `approval: never` a gate `ask` is not "later" but "never"
 * (`DESIGN.md` §2.28–§2.30).
 *
 * This turns that last step into two frames instead of a story:
 *
 *   node tools/drill-live-wake.mjs --before     after restarting DSH, before granting
 *   … grant, send the token as a message, and let one self-check come due …
 *   node tools/drill-live-wake.mjs --after
 *
 * `--after` refuses to call a diff a wake unless the diff is the one the design predicts, and two
 * of its checks are the ones worth reading:
 *
 *   - **both counters must move.** `turns` is bumped after a wake is *delivered*; `spoken` only
 *     when it actually speaks. "Something happened" is therefore not the claim — a wake that was
 *     admitted and judged not worth saying moves the first and not the second, and that outcome
 *     is a failure of *this drill*, not a bug: it means the drill never had anything to report.
 *   - **a trigger has to exist and come due.** A grant alone wakes nothing — standing autonomy is
 *     permission, not a schedule. That is capability 1 stated as an instruction, and it is the
 *     step most likely to be missed by someone following a checklist.
 *
 * The self-check floor is 300 seconds, so the wait between the frames is minutes, not seconds.
 *
 * Usage:
 *   node tools/drill-live-wake.mjs --before [--session <conversation-id>] [--port 19387]
 *   node tools/drill-live-wake.mjs --after  [--session <conversation-id>] [--port 19387]
 *
 * `--session` matters: authority is recorded per conversation, so a status read without one
 * reports `autonomy: null` for a host that has authority — see `resolveSession`.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { callRoute, finish, judgeHostUsability } from './support/route-client.mjs'

const ROUTE = '/dsh-den'
const portArg = process.argv.indexOf('--port')
const PORT = portArg >= 0 ? Number(process.argv[portArg + 1]) : 19387
const isAfter = process.argv.includes('--after')
const isBefore = process.argv.includes('--before')
const sessionArg = process.argv.indexOf('--session')
const SESSION = sessionArg >= 0 ? process.argv[sessionArg + 1] : null
const framePath = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'den', 'drill-frame.json')

/**
 * Which conversation the frames are about.
 *
 * This is not bookkeeping — authority is recorded **per conversation**, and a `status` read
 * without a session answers `autonomy: null, autonomyKnown: false` for a host that has authority
 * on every conversation it serves. The first version of this tool asked without a session and
 * therefore recorded a frame that no wake could ever satisfy: the verdict could only fail, which
 * is the same defect as a gate that refuses everything. It was found by running it against the
 * real host, which is the argument for running these things rather than reasoning about them.
 *
 * An explicit `--session` wins. Failing that, the newest event the host reported *that names a
 * conversation* is used, and the frame says which of the two it came from.
 */
function resolveSession(status) {
  if (SESSION) return { sessionId: SESSION, sessionFrom: 'argument' }
  const events = Array.isArray(status.recentEvents) ? status.recentEvents : []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const sessionId = events[index]?.sessionId
    if (typeof sessionId === 'string' && sessionId) return { sessionId, sessionFrom: 'newest-event' }
  }
  return { sessionId: null, sessionFrom: 'none' }
}

/**
 * The fields both frames record, flattened so a before/after diff is readable by a human in the
 * output rather than only by the comparison below.
 */
function frameOf(status, sessionId, sessionFrom) {
  return {
    at: new Date().toISOString(),
    sessionId,
    sessionFrom,
    startedAt: status.startedAt ?? null,
    autonomy: status.autonomy ?? null,
    autonomyKnown: status.autonomyKnown === true,
    kernelRunning: status.kernel?.running === true,
    residencyHeld: status.residency ? status.residency.held === true : null,
    triggersTotal: status.triggers?.total ?? null,
    triggersDue: status.triggers?.due ?? null,
    turns: status.ledger?.turns ?? null,
    spoken: status.ledger?.spoken ?? null,
    skipped: status.ledger?.skipped ?? null,
    refused: status.ledger?.refused ?? null,
  }
}

/**
 * Whether the second frame shows the wake the first frame was waiting for.
 *
 * Pure, so the cases that matter can be asserted without a host: `test/drill-live-wake.test.mjs`
 * covers the silent wake, the missing grant, the missing trigger and the standing-down host. A
 * drill whose verdict was only ever read from a live run would be a verdict nobody had tested.
 *
 * @param {object} before the frame `--before` wrote
 * @param {object} now the frame `--after` just read
 * @returns {{pass: boolean, failures: string[], notes: string[]}}
 */
export function judgeWake(before, now) {
  const failures = []
  const notes = []

  if (!now.sessionId) {
    // The instrument, not the host. Without a conversation the status cannot resolve authority,
    // so `autonomy === null` here says nothing about whether a grant exists — and the first
    // version of this tool reported exactly that as "the grant never landed".
    failures.push('the frames name no conversation, so authority cannot resolve — pass --session <id>')
  } else if (!now.autonomyKnown) failures.push('the host cannot say whether standing autonomy exists')
  else if (now.autonomy !== true) failures.push('no authority is recorded — the grant never landed, so nothing may wake')
  if (now.kernelRunning !== true) failures.push('the heartbeat is not running, so nothing can wake on its own')
  if (now.residencyHeld === false) failures.push('this host is standing down: another host on this home holds residency')
  if (!(now.triggersTotal >= 1)) {
    failures.push('no self-check exists: authority alone wakes nothing, because a wake needs something due')
  }
  if (!(now.turns > before.turns)) {
    failures.push(`no turn was spent (turns ${before.turns} -> ${now.turns}): no wake was delivered`)
  } else if (!(now.spoken > before.spoken)) {
    failures.push(
      `a turn was spent but nothing was spoken (spoken ${before.spoken} -> ${now.spoken}): the wake was ` +
        'admitted and judged not worth saying, so the drill never had anything to report',
    )
  }

  if (before.startedAt !== now.startedAt) {
    notes.push(
      `the instance restarted between the frames (${before.startedAt} -> ${now.startedAt}); the ledger and the ` +
        'triggers are on disk, so the comparison still holds',
    )
  }
  if (before.at && now.at) notes.push(`frames taken ${before.at} and ${now.at}`)
  return { pass: failures.length === 0, failures, notes }
}

function line(label, before, now) {
  const from = before === undefined ? '—' : String(before)
  const to = now === undefined ? '—' : String(now)
  return `  ${label.padEnd(18)} ${from.padEnd(28)} -> ${to}`
}

async function readStatus(sessionId) {
  const answer = await callRoute({
    port: PORT,
    route: ROUTE,
    action: 'status',
    input: sessionId ? { sessionId } : {},
  })
  if (answer.status !== 200) throw new Error(`${ROUTE} answered ${answer.status}: ${answer.body.slice(0, 200)}`)
  if (!answer.envelope?.ok) throw new Error(`${ROUTE} did not return an ok envelope: ${answer.body.slice(0, 200)}`)
  const value = answer.envelope.value
  const usability = judgeHostUsability(value.freshness)
  if (!usability.usable) {
    throw new Error(
      `the running instance cannot be probed about this tree (${usability.code}): ${usability.reason}\n` +
        '       Restart DSH and run this again — a verdict read from an older instance describes code that is not on disk.',
    )
  }
  return value
}

/**
 * Record one frame, or compare against the recorded one.
 *
 * Kept inside a function, behind the entry-point check at the bottom, because the verdict above is
 * *imported* by a test: a module that opened a socket on import would make the test's result depend
 * on whether a host happened to be listening — which is the same defect as a check that measures
 * whatever is there.
 */
async function main() {
  console.log(`dsh-den admitted-wake drill -> http://127.0.0.1:${PORT}${ROUTE}\n`)

  if (isBefore === isAfter) {
    console.log(
      'RESULT: FAIL — choose one frame: --before (after a restart, before granting) or --after (once the check has come due).',
    )
    finish(2)
    return
  }

  let status
  try {
    status = await readStatus(SESSION)
  } catch (error) {
    console.log(`RESULT: FAIL — ${error.message}`)
    finish(1)
    return
  }

  const resolved = resolveSession(status)
  const now = frameOf({ ...status }, resolved.sessionId, resolved.sessionFrom)
  if (resolved.sessionFrom === 'newest-event') {
    console.log(`session: ${resolved.sessionId} (newest conversation the host named; pass --session to be explicit)\n`)
  } else if (!resolved.sessionId) {
    console.log('session: NONE — no --session given and no event named a conversation; authority cannot resolve.\n')
  } else {
    console.log(`session: ${resolved.sessionId} (--session)\n`)
  }

  if (!isAfter) {
    mkdirSync(dirname(framePath), { recursive: true })
    writeFileSync(framePath, `${JSON.stringify(now, null, 2)}\n`, 'utf8')
    console.log('frame --before recorded:')
    for (const [key, value] of Object.entries(now)) console.log(`  ${key.padEnd(18)} ${JSON.stringify(value)}`)
    console.log(`\n  written to ${framePath}\n`)
    // State-aware, because the drill is run by a human who may already have done some of it: the
    // first live run of this tool told its reader to mint a token that had already been spent.
    console.log('What is still owed, in order:')
    if (now.autonomy === true) {
      console.log('  1. Authority is recorded for this conversation — nothing to do here.')
    } else {
      console.log('  1. In the panel strip above the message box, press 授予 (Grant), then 复制令牌 (copy token).')
      console.log('     Send that token to the assistant as a message: authority is only recorded when a human')
      console.log('     message carries the token, and the panel cannot complete it alone.')
    }
    if (now.triggersTotal >= 1) {
      console.log(`  2. A self-check exists (${now.triggersTotal}); it has to come due, then a heartbeat has to deliver it.`)
    } else {
      console.log('  2. Give it something due: a self-check whose interval has elapsed (the floor is 300s).')
      console.log('     Authority alone wakes nothing; the wake needs a trigger that is due.')
    }
    console.log('  3. Run `npm run drill:after` once a heartbeat has had the chance to deliver it.\n')
    console.log('RESULT: ARMED — the frame is on disk, and `--after` will compare against it.')
    finish(0)
    return
  }

  let before
  try {
    before = JSON.parse(readFileSync(framePath, 'utf8'))
  } catch (error) {
    console.log(`RESULT: FAIL — no usable --before frame at ${framePath}: ${error.message}`)
    finish(1)
    return
  }

  const verdict = judgeWake(before, now)
  console.log('frame comparison (before -> now):')
  console.log(line('conversation', before.sessionId, now.sessionId))
  console.log(line('startedAt', before.startedAt, now.startedAt))
  console.log(line('autonomy', before.autonomy, now.autonomy))
  console.log(line('kernel.running', before.kernelRunning, now.kernelRunning))
  console.log(line('residency.held', before.residencyHeld, now.residencyHeld))
  console.log(line('triggers.total', before.triggersTotal, now.triggersTotal))
  console.log(line('ledger.turns', before.turns, now.turns))
  console.log(line('ledger.spoken', before.spoken, now.spoken))
  console.log(line('ledger.skipped', before.skipped, now.skipped))
  console.log(line('ledger.refused', before.refused, now.refused))

  const events = Array.isArray(status.recentEvents) ? status.recentEvents.slice(-6) : []
  if (events.length) {
    console.log('\n  last events the host recorded:')
    for (const event of events) console.log(`    ${JSON.stringify(event)}`)
  }
  for (const note of verdict.notes) console.log(`\n  note: ${note}`)

  if (verdict.pass) {
    console.log('\nRESULT: PASS — the kernel admitted a wake: one turn was spent and one notice was spoken.')
    finish(0)
    return
  }
  console.log('')
  for (const failure of verdict.failures) console.log(`  FAIL: ${failure}`)
  console.log('\nRESULT: FAIL — the admitted wake has still not been observed on this host.')
  finish(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
