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

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Every offset at which a zstd frame could start. */
export function frameStarts(buffer) {
  const starts = []
  for (let i = 0; i + 4 <= buffer.length; i++) {
    if (buffer[i] === MAGIC[0] && buffer[i + 1] === MAGIC[1] && buffer[i + 2] === MAGIC[2] && buffer[i + 3] === MAGIC[3]) starts.push(i)
  }
  return starts
}

/**
 * Decompress every frame, in order.
 *
 * A four-byte magic can occur inside compressed data, so a candidate that will not decompress is
 * skipped and the slice is extended to the next candidate instead of being trusted.
 */
export function decodeFrames(buffer) {
  const starts = frameStarts(buffer)
  const parts = []
  let i = 0
  while (i < starts.length) {
    let decoded = null
    for (let j = i + 1; j <= Math.min(i + 4, starts.length); j++) {
      const end = j < starts.length ? starts[j] : buffer.length
      try {
        decoded = zstdDecompressSync(buffer.subarray(starts[i], end)).toString('utf8')
        i = j
        break
      } catch (error) {
        decoded = null
      }
    }
    if (decoded === null) {
      i += 1
      continue
    }
    parts.push(decoded)
  }
  return parts.join('')
}

/** Every parsed event in the log, oldest first. */
export function decodeLog(buffer) {
  return decodeFrames(buffer)
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch (error) {
        return { type: 'unparsable', line: line.slice(0, 120) }
      }
    })
}

function messageText(data) {
  const blocks = data && Array.isArray(data.message?.content) ? data.message.content : []
  return blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ').slice(0, 160)
}

export function summarise(events) {
  const kinds = new Map()
  const ends = new Map()
  const messages = []
  let lastError = null
  for (const event of events) {
    const type = event.type || 'unknown'
    kinds.set(type, (kinds.get(type) || 0) + 1)
    if (type === 'turn/end') {
      const kind = event.data?.reason?.kind || 'unknown'
      ends.set(kind, (ends.get(kind) || 0) + 1)
      if (kind === 'error') lastError = event.data?.reason?.error?.message || lastError
    }
    if (type === 'user/message' || type === 'assistant/message') messages.push({ type, text: messageText(event.data) })
  }
  return { kinds, ends, messages, lastError }
}

function findLog(dir, sessionId, depth = 0) {
  if (depth > 4) return null
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    return null
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === sessionId) {
        const candidate = join(full, 'session.v4.jsonl.zstd')
        try {
          if (statSync(candidate).isFile()) return candidate
        } catch (error) {
          return null
        }
      }
      const found = findLog(full, sessionId, depth + 1)
      if (found) return found
    }
  }
  return null
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