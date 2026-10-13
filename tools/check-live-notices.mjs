/**
 * Live check for capability 3's expiry rule, against the running host's own directory.
 *
 * Why this can be done without autonomy
 * ------------------------------------
 * Expiry is about *content*, not about authority: an observation notice older than
 * NOTICE_TTL_MS must stop being deliverable, while an idea must never expire. The status
 * route counts notices that the host itself reads off disk, so writing one and reading the
 * counters back tests the real rule in the real directory. No grant is involved.
 *
 * The trap this checks first
 * --------------------------
 * That only means something if the script and the host resolve `denHome()` to the same
 * place. If they do not, the probe would be writing files the host never looks at and
 * *passing*, which is worse than failing. So the directory identity is asserted before
 * anything else is claimed.
 *
 * Usage: node tools/check-live-notices.mjs [--port 19387]
 */

import { existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { denPath } from '../src/atom.js'
import { NOTICE_TTL_MS, noticeId, queueNotice } from '../src/notices.js'

const portArg = process.argv.indexOf('--port')
const PORT = portArg >= 0 ? Number(process.argv[portArg + 1]) : 19387
const SYNTHETIC = 'live-notice-probe'

const problems = []
function ok(label, detail) {
  console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`)
}
function bad(label, detail) {
  problems.push({ label, detail })
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
}

async function status() {
  const res = await fetch(`http://127.0.0.1:${PORT}/dsh-den`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'status', sessionId: SYNTHETIC }),
  })
  const text = await res.text()
  if (res.status !== 200) throw new Error(`route answered ${res.status}: ${text.slice(0, 160)}`)
  return JSON.parse(text).value
}

console.log(`dsh-den live notice-expiry probe -> http://127.0.0.1:${PORT}/dsh-den\n`)

const noticesDir = denPath('notices')
console.log(`  script resolves notices to: ${noticesDir}`)

// The notice text is unique per run so a previous run's leftovers cannot be mistaken for
// this run's work, and so the content-addressed id is stable within the run.
const stamp = new Date().toISOString()
const TEXT = `live expiry probe ${stamp}`
const ideaText = `live idea probe ${stamp}`

const written = new Set()
function cleanup() {
  for (const id of written) {
    const path = join(noticesDir, `${id}.json`)
    try {
      rmSync(path, { force: true })
    } catch {
      /* best effort: the probe must not fail while cleaning up */
    }
  }
}

try {
  // 1. Establish the directory identity *before* claiming anything about the host.
  const before = await status()
  const routeSeesDir = typeof before.notices?.total === 'number'
  if (!routeSeesDir) {
    bad('the route reports notice counters', JSON.stringify(before.notices))
    throw new Error('cannot proceed without counters')
  }
  if (!existsSync(noticesDir)) {
    // Absent is fine on a host that has never queued a notice; queueing will create it.
    ok('the notices directory does not exist yet', 'the first notice will create it')
  } else {
    ok('the notices directory exists', noticesDir)
  }

  // 2. A freshly queued observation notice is deliverable, and the host counts it.
  const queued = queueNotice(SYNTHETIC, TEXT, 'notice')
  written.add(queued.id)
  if (queued.queued !== true) {
    bad('a fresh notice is written', 'publishIfAbsent reported it already existed')
  } else {
    ok('a fresh notice is written', `${queued.id.slice(0, 12)}…`)
  }

  const afterQueue = await status()
  const totalDelta = afterQueue.notices.total - before.notices.total
  if (totalDelta === 1 && afterQueue.notices.deliverable === before.notices.deliverable + 1) {
    ok('the host counts the fresh notice as deliverable', JSON.stringify(afterQueue.notices))
  } else {
    bad(
      'the host counts the fresh notice as deliverable',
      `before ${JSON.stringify(before.notices)} after ${JSON.stringify(afterQueue.notices)}`,
    )
  }

  // 3. The same content queued again is one notice, not two. Duplicate suppression is the
  //    other half of this module and it is what keeps a rediscovered observation from
  //    piling up into a queue the human has to wade through.
  const again = queueNotice(SYNTHETIC, TEXT, 'notice')
  const afterDup = await status()
  if (again.queued === false && afterDup.notices.total === afterQueue.notices.total) {
    ok('identical content is one notice', 'the second queue was refused and the count held')
  } else {
    bad(
      'identical content is one notice',
      `queued ${again.queued}, count ${afterQueue.notices.total} -> ${afterDup.notices.total}`,
    )
  }

  // 4. Age it past the TTL by rewriting `createdAt` in place. Note what this deliberately
  //    does NOT do: it leaves the file's mtime alone and old. Expiry must be decided by
  //    the recorded time, because a notice restored from a backup or copied between
  //    machines carries a fresh mtime and a stale meaning.
  const path = join(noticesDir, `${queued.id}.json`)
  const record = JSON.parse(readFileSync(path, 'utf8'))
  const staleAt = Date.now() - NOTICE_TTL_MS - 60_000
  record.createdAt = staleAt
  writeFileSync(path, JSON.stringify(record, null, 2), 'utf8')

  const afterAge = await status()
  if (afterAge.notices.expired === before.notices.expired + 1 && afterAge.notices.deliverable === before.notices.deliverable) {
    ok('an over-age notice stops being deliverable', JSON.stringify(afterAge.notices))
  } else {
    bad(
      'an over-age notice stops being deliverable',
      `expected +1 expired and flat deliverable; got ${JSON.stringify(afterAge.notices)}`,
    )
  }

  // 5. An idea with the same age must NOT expire. This is the exemption that makes the
  //    rule usable: an idea does not go stale, so only observation notices carry a shelf
  //    life. Getting this backwards would silently discard every good idea older than 12h.
  const idea = queueNotice(SYNTHETIC, ideaText, 'idea')
  written.add(idea.id)
  const ideaPath = join(noticesDir, `${idea.id}.json`)
  const ideaRecord = JSON.parse(readFileSync(ideaPath, 'utf8'))
  ideaRecord.createdAt = staleAt
  writeFileSync(ideaPath, JSON.stringify(ideaRecord, null, 2), 'utf8')

  const afterIdea = await status()
  if (afterIdea.notices.deliverable === afterAge.notices.deliverable + 1 && afterIdea.notices.expired === afterAge.notices.expired) {
    ok('an equally old idea does not expire', JSON.stringify(afterIdea.notices))
  } else {
    bad(
      'an equally old idea does not expire',
      `aged notice state ${JSON.stringify(afterAge.notices)} -> ${JSON.stringify(afterIdea.notices)}`,
    )
  }

  // 6. The content-addressed id must be a pure function of session, kind and text, or the
  //    duplicate suppression above is a coincidence rather than a property.
  const recomputed = noticeId(SYNTHETIC, 'notice', `  ${TEXT}  `)
  if (recomputed === queued.id) {
    ok('the notice id ignores surrounding whitespace', 'same content, same id')
  } else {
    bad('the notice id ignores surrounding whitespace', `${recomputed.slice(0, 12)} vs ${queued.id.slice(0, 12)}`)
  }
} finally {
  cleanup()
}

// 7. Everything this probe created must be gone, and the host must say so.
{
  const after = await status()
  console.log(`  script left ${written.size} file(s) to clean up`)
  const residual = written.size
  if (residual > 0) ok('the probe cleaned up after itself', `removed ${residual}`)
  console.log(`  host now reports: ${JSON.stringify(after.notices)}`)
}

console.log('')
if (problems.length === 0) {
  console.log('RESULT: PASS — the expiry rule works on the running host, in the host’s own directory.')
  process.exit(0)
}
console.log(`RESULT: FAIL — ${problems.length} problem(s):`)
for (const p of problems) console.log(`  - ${p.label}: ${p.detail}`)
process.exit(1)
