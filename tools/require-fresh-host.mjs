/**
 * Refuse to let a live probe speak about a tree the host never loaded.
 *
 * This runs as its own process, in front of a live probe, chained with `&&` in
 * `package.json`:
 *
 *     "check:memory": "node tools/require-fresh-host.mjs && node tools/check-live-memory.mjs"
 *
 * That placement is the point. `verify:live` already stops before its later steps when the
 * deployment check fails, but a probe run on its own — `npm run check:notices` while working on
 * notices — had no gate at all, so it printed a pass about whatever instance happened to be
 * listening. On 2026-10-13 that instance was built from code six commits old, and the passes were
 * reported as evidence. A guard inside each probe would have to be remembered; a guard in front of
 * the probe is inherited by every way of running it.
 *
 * Three outcomes, and only one of them is a pass:
 *
 *   - the instance loaded this tree                     -> exit 0, the probe runs
 *   - the instance loaded older code                    -> exit 1 with the file named
 *   - the instance cannot say, or nothing is listening  -> exit 1, because "unable to tell" is not
 *     a pass either; the probe's subject is the running host, and there is no host to describe
 *
 * Usage: node tools/require-fresh-host.mjs [--port 19387]
 */

import { judgeHostUsability, callRoute, finish } from './support/route-client.mjs'

const portArg = process.argv.indexOf('--port')
const PORT = portArg >= 0 ? Number(process.argv[portArg + 1]) : 19387
const ROUTE = '/dsh-den'

let answer
try {
  answer = await callRoute({ port: PORT, route: ROUTE, action: 'status', method: 'POST' })
} catch (error) {
  console.log(`  FAIL no host answered on 127.0.0.1:${PORT}${ROUTE} — ${error?.message ?? error}`)
  console.log('       A live probe describes a running instance; without one there is nothing to describe.')
  finish(1)
}

if (answer) {
  const status = answer.envelope?.value ?? null
  if (answer.status !== 200 || !status) {
    console.log(`  FAIL the route answered ${answer.status} with ${status ? 'no value' : 'no value envelope'}`)
    console.log(`       ${String(answer.body ?? '').slice(0, 200)}`)
    finish(1)
  } else {
    const verdict = judgeHostUsability(status.freshness)
    if (verdict.usable) {
      console.log(`  ok   the running instance loaded this tree — ${verdict.reason}`)
      finish(0)
    } else {
      console.log(`  FAIL the running instance cannot be probed about this tree (${verdict.code})`)
      console.log(`       ${verdict.reason}`)
      console.log(`       instance started ${status.startedAt ?? 'unknown'}; restart DSH and re-run.`)
      console.log('       Any pass printed by the probe behind this line would describe code that is not on disk.')
      finish(1)
    }
  }
}
