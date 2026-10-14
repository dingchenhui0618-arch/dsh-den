import test from 'node:test'
import assert from 'node:assert/strict'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const { decodeLog, frameStarts, summarise } = await import('../tools/inspect-standing-log.mjs')

/** Three frames, exactly as an appended log writes them: one event per write. */
function threeFrameLog() {
  const lines = [
    JSON.stringify({ type: 'session', version: 4, id: 'sess-1', agentPreset: 'cordis', cwd: 'D:/Projects' }),
    JSON.stringify({ type: 'turn/start', seq: 1, data: { turn: 1 } }),
    JSON.stringify({
      type: 'assistant/message',
      seq: 2,
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'all clear' }] } },
    }),
    JSON.stringify({ type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } }),
  ]
  return {
    buffer: Buffer.concat([
      zstdCompressSync(Buffer.from(lines[0] + '\n')),
      zstdCompressSync(Buffer.from(lines[1] + '\n')),
      zstdCompressSync(Buffer.from(lines[2] + '\n' + lines[3] + '\n')),
    ]),
    lines,
  }
}

test('a one-frame reader sees one frame, which is the mistake this tool exists to prevent', () => {
  const { buffer, lines } = threeFrameLog()
  const single = zstdDecompressSync(buffer).toString('utf8')
  assert.equal(single.trim(), lines[0], 'decompressing the whole buffer yields the FIRST frame only')
  assert.ok(!single.includes('assistant'), 'so a reader built on it would report an empty conversation')
})

test('every frame is decoded, in order', () => {
  const { buffer, lines } = threeFrameLog()
  assert.equal(frameStarts(buffer).length, 3)
  const events = decodeLog(buffer)
  assert.deepEqual(events.map((event) => event.type), ['session', 'turn/start', 'assistant/message', 'turn/end'])
  assert.equal(events.length, lines.length)
})

test('the summary says how the turns ended and what den said', () => {
  const { buffer } = threeFrameLog()
  const summary = summarise(decodeLog(buffer))
  assert.equal(summary.ends.get('completed'), 1)
  assert.equal(summary.ends.get('error'), undefined)
  assert.deepEqual(summary.messages, [{ type: 'assistant/message', text: 'all clear' }])
  assert.equal(summary.lastError, null)
})

test('an error turn is reported with the reason the host gave', () => {
  const failing = Buffer.concat([
    zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', id: 's' }) + '\n')),
    zstdCompressSync(
      Buffer.from(
        JSON.stringify({
          type: 'turn/end',
          seq: 1,
          data: { turn: 1, reason: { kind: 'error', error: { message: 'prompt variable "{{model}}" has no value' } } },
        }) + '\n',
      ),
    ),
  ])
  const summary = summarise(decodeLog(failing))
  assert.equal(summary.ends.get('error'), 1)
  assert.match(summary.lastError, /no value/)
  assert.deepEqual(summary.messages, [], 'an error turn produces no message, which is the whole point')
})

test('a log that is not zstd at all is not claimed to be one', () => {
  assert.deepEqual(frameStarts(Buffer.from('not compressed')), [])
  assert.deepEqual(decodeLog(Buffer.from('not compressed')), [])
})
