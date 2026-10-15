/**
 * What den's standing conversation actually contains.
 *
 * Written after a reader of this same log reported "one line, no messages" for a file that held three
 * complete turns: a compressed jsonl log APPENDS A NEW FRAME per write, and decompressing one frame
 * gives one frame. This decodes all of them, and says out loud what a session with no preset can and
 * cannot do.
 *
 * Usage: node tools/inspect-standing-log.mjs [conversation.json]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/**
 * The decoding lives in `src/session-log.js` now, so the window and this tool cannot drift: one
 * implementation of "a log APPENDS A FRAME per write". Re-exported here because the tests import
 * these names from this file.
 */
export { frameStarts, decodeFrames, decodeLog } from '../src/session-log.js'
import { decodeLog, findSessionLog, frameStarts, summariseEvents } from '../src/session-log.js'

/** What the CLI prints: event counts, turn endings, and the last error reason. */
export function summarise(events) {
  return summariseEvents(events)
}

function findLog(dir, sessionId) {
  return findSessionLog(sessionId, { sessionsRoot: dir })
}

function main() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const recordPath = process.argv[2] || join(home, 'den', 'conversation.json')
  console.log('record   : ' + recordPath)
  let record
  try {
    record = JSON.parse(readFileSync(recordPath, 'utf8'))
  } catch (error) {
    console.log('verdict  : no standing conversation has been created on this machine')
    return
  }
  console.log('session  : ' + record.sessionId + (record.agentPreset ? ' (preset ' + record.agentPreset + ')' : ' (NO PRESET RECORDED — created before this plugin passed one)'))
  if (record.replacedSessionId) console.log('replaced : ' + record.replacedSessionId)
  const log = findLog(join(home, 'sessions'), record.sessionId)
  if (!log) {
    console.log('verdict  : the record names a session whose log is not on disk')
    return
  }
  const buffer = readFileSync(log)
  const events = decodeLog(buffer)
  const header = events.find((event) => event.type === 'session') || {}
  console.log('log      : ' + log + ' (' + buffer.length + ' bytes, ' + frameStarts(buffer).length + ' candidate frames, ' + events.length + ' events)')
  console.log('header   : cwd=' + (header.cwd || '(none)') + '  agentPreset=' + (header.agentPreset || '(none)'))
  const { kinds, ends, messages, lastError } = summarise(events)
  console.log('events   : ' + [...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => k + ' ' + n).join(', '))
  console.log('turns    : ' + (ends.size ? [...ends.entries()].map(([k, n]) => k + ' ' + n).join(', ') : 'none ended'))
  for (const message of messages.slice(-6)) console.log('message  : ' + message.type + ' — ' + message.text)
  if (!messages.length) {
    console.log('verdict  : NO message has ever been written to this conversation' + (lastError ? '; last turn error: ' + lastError : ''))
  } else if (!messages.some((m) => m.type === 'assistant/message')) {
    console.log('verdict  : the human has spoken and den has never answered; last turn error: ' + (lastError || '(none)'))
  } else {
    console.log('verdict  : den has answered ' + messages.filter((m) => m.type === 'assistant/message').length + ' time(s); the loop is closed')
  }
}

main()