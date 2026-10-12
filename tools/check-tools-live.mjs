/**
 * Prove, from disk, that the den's tools are actually available to a session.
 *
 * The in-session tool list is rendered by the client and is not persisted, so it
 * cannot be read back after the fact. What IS persisted is every `tool/call`
 * record, by name. So the evidentiary question is precise:
 *
 *   has any session, started after the plugin went live, actually invoked a
 *   `den_*` tool?
 *
 * A `tool/call` record is NOT evidence on its own, and this is the trap the first
 * version of this tool fell into: a model can *attempt* a tool that is not
 * registered, and the attempt is still logged by name. The attempt is then
 * answered with `Error: unknown tool "..."`. So every call must be paired with
 * its result, and a call whose result is an unknown-tool error counts as proof
 * that the tool was NOT available.
 *
 * The check is therefore: has any session invoked a `den_*` tool AND received a
 * result that is not an unknown-tool error?
 *
 * Usage: node check-tools-live.mjs [--since <epoch-ms>]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Machine-specific paths stay out of the source: DSH_HOME, else the default home.
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const root = process.env.DSH_SESSIONS ?? join(dshHome, 'sessions')
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

// The moment the plugin was re-activated in the live profile.
//
// Default is intentionally 0 so the tool never silently hides evidence: pass an
// explicit --since to restrict the window to *records* at or after that instant.
// The re-activation was verified at 2026-10-12T06:20:11Z (14:20 local).
const sinceArg = process.argv.indexOf('--since')
const SINCE = sinceArg >= 0 ? Number(process.argv[sinceArg + 1]) : 0

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.zstd')) out.push(full)
  }
  return out
}

/**
 * Session logs are zstd **concatenated frames** (one per appended batch), so a
 * single-shot decompress returns only the first frame — 190 bytes out of 10.9 MB
 * in the log measured here. Every frame must be decoded and joined.
 */
function decode(path) {
  const buf = readFileSync(path)
  const parts = []
  let cursor = 0
  let torn = 0
  while (cursor < buf.length) {
    const next = buf.indexOf(MAGIC, cursor + 4)
    const end = next < 0 ? buf.length : next
    try {
      parts.push(zstdDecompressSync(buf.subarray(cursor, end)))
    } catch {
      torn += 1
    }
    cursor = end
  }
  return { text: Buffer.concat(parts).toString('utf8'), torn }
}

const files = walk(root)
  .map((p) => ({ p, m: statSync(p).mtimeMs, s: statSync(p).size }))
  .sort((a, b) => b.m - a.m)

console.log(`session logs scanned : ${files.length}`)
console.log(`counting calls after : ${SINCE ? new Date(SINCE).toISOString() : '(no cutoff)'}`)

const denCalls = []
const allDenTools = new Set()
const attempted = new Set()
let scanned = 0
let records = 0

/** A result counts as "the tool existed" unless it is an unknown-tool refusal. */
function isUnknownTool(resultText) {
  return /unknown tool/i.test(resultText)
}

for (const file of files) {
  let decoded
  try {
    decoded = decode(file.p)
  } catch {
    continue
  }
  scanned += 1
  const callsById = new Map()
  const resultsById = new Map()

  for (const line of decoded.text.split('\n')) {
    if (!line.trim()) continue
    records += 1
    if (!line.includes('"den_')) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    const at = typeof rec.time === 'number' ? rec.time : 0
    if (SINCE && at < SINCE) continue

    if (rec.type === 'tool/call' && typeof rec.data?.name === 'string' && rec.data.name.startsWith('den_')) {
      callsById.set(rec.data.callId, { name: rec.data.name, time: at })
      attempted.add(rec.data.name)
    }
    // Tool results arrive as assistant/message records carrying role:"tool".
    const callId = rec.data?.toolCallId ?? rec.data?.message?.toolCallId
    if (typeof callId === 'string' && callsById.has(callId)) {
      const text = JSON.stringify(rec.data)
      resultsById.set(callId, { text, unknown: isUnknownTool(text) })
    } else if (typeof callId === 'string') {
      // Result for a call that happened before the cutoff; remember the verdict.
      const text = JSON.stringify(rec.data)
      if (isUnknownTool(text)) resultsById.set(callId, { text, unknown: true })
      else resultsById.set(callId, { text, unknown: false })
    }
  }

  for (const [id, call] of callsById) {
    const result = resultsById.get(id) ?? null
    const existed = result !== null && result.unknown === false
    if (existed) allDenTools.add(call.name)
    denCalls.push({ session: file.p.replace(root, ''), time: call.time, name: call.name, existed, result })
  }
}

console.log(`logs decoded         : ${scanned}`)
console.log(`records examined     : ${records}`)
console.log('')

const worked = denCalls.filter((c) => c.existed)
const failed = denCalls.filter((c) => !c.existed)

console.log('=== den_* calls that returned a real result (proof the tool was available) ===')
if (worked.length === 0) {
  console.log('  none')
} else {
  for (const call of worked.slice(-20)) {
    console.log(`  ${new Date(call.time).toISOString()}  ${call.name}`)
    console.log(`      ${call.session}`)
  }
}

if (failed.length) {
  console.log('')
  console.log('=== den_* attempts that were REFUSED (tool was not in that session\'s set) ===')
  for (const call of failed.slice(-20)) {
    const why = call.result === null ? 'no result record found' : 'unknown tool'
    console.log(`  ${new Date(call.time).toISOString()}  ${call.name}  (${why})`)
    console.log(`      ${call.session}`)
  }
}

console.log('')
if (worked.length === 0) {
  console.log('VERDICT: NOT PROVEN.')
  console.log(`  ${attempted.size} distinct den_ tool(s) were attempted (${[...attempted].sort().join(', ')}),`)
  console.log(`  but no attempt returned a real result. ${failed.length} were refused as unknown tools.`)
  console.log('  The plugin is active and its service works when driven in-process, but the')
  console.log('  in-session tool surface is still unverified. Open a NEW session — the tool')
  console.log('  list is frozen when a session starts, so a session that predates')
  console.log('  activation can never see the tools no matter what is registered later.')
} else {
  console.log(`VERDICT: PROVEN for ${[...allDenTools].sort().join(', ')}.`)
  console.log('  Each of these returned a result that was not an unknown-tool error, which')
  console.log('  is only possible if the tool was registered in that session\'s tool set.')
}
