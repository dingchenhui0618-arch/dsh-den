/**
 * Reading a session log from disk, frame by frame.
 *
 * A compressed jsonl log APPENDS A NEW FRAME per write, so decompressing one frame gives one frame —
 * the mistake this reader exists to prevent. It also reads the transcript of a session the host has
 * not published: an agent that has finished is gone, `sessions.get(id)` answers nothing, and a
 * standing conversation would otherwise look empty while every word of it is on disk.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** The session directory the Host keys storage by: `C:\a\.b` becomes `--C-a-.b--`. */
export function encodeCwd(cwd) {
  return '--' + String(cwd).replace(/:/g, '').replace(/[\\/]/g, '-') + '--'
}

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

/** Event counts, turn endings and the last error — what the CLI prints. */
export function summariseEvents(events) {
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
    if (type === 'user/message' || type === 'assistant/message') {
      // Role decides where the text lives: a user message carries `data.content`, an assistant message
      // carries `data.message.content`. Reading both the same way silently halves this summary, which is
      // exactly what the doctor tool was doing when it printed user lines with no text.
      const message = type === 'user/message' ? event.data : event.data && event.data.message
      messages.push({ type, text: textOf(message).slice(0, 160) })
    }
  }
  return { kinds, ends, messages, lastError }
}

/** The text blocks of one message, in order, joined. */
function textOf(message) {
  const content = message && Array.isArray(message.content) ? message.content : []
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * The conversation a log holds: what was said to den and what den said back, oldest first.
 *
 * Same shape as the store-backed read, and the same refusal to include tool traffic: a turn's
 * machinery is not something to read in a small window. The last error reason wins, so a turn that
 * wrote no message still explains itself.
 */
export function transcriptFromEvents(events, { limit = 60 } = {}) {
  const all = []
  let lastError = ''
  for (const event of events) {
    if (event?.type === 'turn/end') {
      const reason = event.data?.reason
      lastError =
        reason?.kind === 'error' && typeof reason.error?.message === 'string' ? reason.error.message.slice(0, 200) : ''
    }
    const role = event?.type === 'user/message' ? 'user' : event?.type === 'assistant/message' ? 'assistant' : ''
    if (!role) continue
    const message = role === 'user' ? event.data : event.data && event.data.message
    const text = textOf(message)
    if (!text) continue
    all.push({ role, text, seq: Number(event.seq) || 0, time: Number(event.time) || 0 })
  }
  const wanted = Math.max(1, Number(limit) || 60)
  const messages = all.slice(-wanted)
  return { messages, total: all.length, truncated: messages.length < all.length, lastError }
}

/** The session log for an id, by direct name first and by walking the store second. */
export function findSessionLog(sessionId, { cwd = '', sessionsRoot } = {}) {
  const root = sessionsRoot || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')
  const candidates = []
  if (cwd) candidates.push(join(root, encodeCwd(cwd), sessionId, 'session.v4.jsonl.zstd'))
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch (error) {
      /* try the walk */
    }
  }
  return walk(root, sessionId, 0)
}

function walk(dir, sessionId, depth) {
  if (depth > 4) return null
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    return null
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (!entry.isDirectory()) continue
    if (entry.name === sessionId) {
      const candidate = join(full, 'session.v4.jsonl.zstd')
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch (error) {
        return null
      }
    }
    const found = walk(full, sessionId, depth + 1)
    if (found) return found
  }
  return null
}

/**
 * The transcript of a session read from its log, or null when there is no log to read.
 *
 * Never throws: a session whose log is missing, unreadable or not compressed at all is a session this
 * host cannot hand back, which the caller reports as such rather than as an empty conversation.
 */
export function readTranscriptFromLog(sessionId, { cwd = '', limit = 60, sessionsRoot } = {}) {
  if (!sessionId) return null
  const path = findSessionLog(sessionId, { cwd, sessionsRoot })
  if (!path) return null
  try {
    return Object.assign({ path }, transcriptFromEvents(decodeLog(readFileSync(path)), { limit }))
  } catch (error) {
    return null
  }
}
