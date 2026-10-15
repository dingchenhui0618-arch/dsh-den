/**
 * den reads the other conversations without becoming one of them: the scan is cheap, the first
 * sighting of a session is a baseline rather than news, and the only thing a sighting can produce is a
 * wake in den's own conversation.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const { alertKey, observeSessionActivity, scanSessionLogs, shouldAlert, summariseTail, tailEvents, watchWakeFor } = await import('../src/watcher.js')
const { normalizeTrigger } = await import('../src/triggers.js')

const CWD = 'C:\\Users\\someone\\project'

function frame(events) {
  return zstdCompressSync(Buffer.from(events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8'))
}

/** A session store of its own, with one or two sessions in it. */
function withStore(run) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-den-watch-'))
  try {
    const dirOf = (id) => join(root, '--C-Users-someone-project--', id)
    const write = (id, events) => {
      mkdirSync(dirOf(id), { recursive: true })
      writeFileSync(join(dirOf(id), 'session.v4.jsonl.zstd'), frame(events))
    }
    return run({ root, dirOf, write })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const asked = (text) => ({ type: 'user/message', time: 1, data: { content: [{ type: 'text', text }] } })
const answered = (text) => ({ type: 'assistant/message', time: 2, data: { message: { content: [{ type: 'text', text }] } } })
const failed = (message) => ({ type: 'turn/end', time: 3, data: { reason: { kind: 'error', error: { message } } } })
const fine = () => ({ type: 'turn/end', time: 3, data: { reason: { kind: 'completed' } } })

test('every session log on disk is found, newest first, and an exclusion is honoured', () => {
  withStore(({ root, write }) => {
    write('sess-old', [asked('a')])
    write('sess-new', [asked('b')])
    const found = scanSessionLogs({ root })
    assert.equal(found.length, 2)
    assert.ok(found.every((log) => log.size > 0 && log.path.endsWith('session.v4.jsonl.zstd')))
    assert.deepEqual(scanSessionLogs({ root, exclude: ['sess-new'] }).map((l) => l.sessionId), ['sess-old'])
  })
})

test('the first sighting of a session is a baseline, not an accusation', () => {
  withStore(({ root, write }) => {
    write('sess-broken', [asked('hi'), failed('prompt variable "{{cwd}}" has no value')])
    const first = observeSessionActivity({ root, seen: {}, now: 1000 })
    assert.equal(first.adopted, 1)
    assert.deepEqual(first.attention, [], 'history is not news')
    assert.deepEqual(first.changes[0].error, '', 'and nothing was even read for it')
  })
})

test('a turn that fails after den starts watching is attention, exactly once', () => {
  withStore(({ root, dirOf, write }) => {
    write('sess-1', [asked('hi'), fine()])
    const first = observeSessionActivity({ root, seen: {}, now: 1000 })
    const second = observeSessionActivity({ root, seen: first.seen, now: 2000 })
    assert.deepEqual(second.changes, [], 'nothing changed, so nothing was read')

    appendFileSync(join(dirOf('sess-1'), 'session.v4.jsonl.zstd'), frame([failed('boom')]))
    const third = observeSessionActivity({ root, seen: first.seen, now: 3000 })
    assert.equal(third.attention.length, 1)
    assert.equal(third.attention[0].error, 'boom')
    assert.equal(shouldAlert(third.attention[0], {}), true)
    assert.equal(shouldAlert(third.attention[0], { [alertKey(third.attention[0])]: 1 }), false, 'alerted once is alerted')
  })
})

test('a healthy turn produces no attention at all', () => {
  withStore(({ root, dirOf, write }) => {
    write('sess-2', [asked('hi')])
    const first = observeSessionActivity({ root, seen: {}, now: 1000 })
    appendFileSync(join(dirOf('sess-2'), 'session.v4.jsonl.zstd'), frame([answered('hello'), fine()]))
    const second = observeSessionActivity({ root, seen: first.seen, now: 2000 })
    assert.equal(second.changes.length, 1)
    assert.equal(second.changes[0].spoke, true)
    assert.deepEqual(second.attention, [])
  })
})

test('the tail reader is bounded: it reads a window, not the file', () => {
  withStore(({ root, write }) => {
    write('sess-3', [asked('first'), answered('a'), fine(), asked('second'), answered('b'), fine()])
    const log = scanSessionLogs({ root })[0]
    const whole = tailEvents(log.path, log.size, { keep: 50 })
    assert.equal(whole.length, 6)
    const tiny = tailEvents(log.path, log.size, { tailBytes: 90, keep: 50 })
    assert.ok(tiny.length < whole.length, 'a 90-byte window cannot hold six events')
  })
})

test('the summary reads both message shapes and the last ending', () => {
  const summary = summariseTail([asked('hello'), answered('hi'), fine()])
  assert.equal(summary.spoke, true)
  assert.equal(summary.error, '')
  assert.equal(summariseTail([asked('x'), failed('nope')]).error, 'nope')
})

test('a sighting becomes a wake in the den conversation, never in the watched one', () => {
  const item = { sessionId: 'watched-session-id', size: 120, error: 'prompt variable "{{cwd}}" has no value' }
  const wake = watchWakeFor(item, { sessionId: 'den-own-id', now: 5000 })
  assert.equal(wake.sessionId, 'den-own-id', 'authority is per conversation; the watched one would refuse forever')
  assert.equal(wake.kind, 'once')
  assert.equal(wake.maxRuns, 1)
  assert.equal(wake.at, 5000)
  assert.match(wake.prompt, /\{\{cwd\}\}/, 'the facts travel in the prompt, which is what the wake carries')
  assert.match(wake.prompt, /Do not write into the other session/)
  // The host has to accept this shape, or the wake silently never exists.
  const stored = normalizeTrigger(wake)
  assert.equal(stored.sessionId, 'den-own-id')
  assert.equal(stored.maxRuns, 1)
  assert.equal(typeof stored.prompt, 'string', 'the schema requires it, so it must be there')
})
