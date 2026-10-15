/**
 * den reads the other conversations without becoming one of them: the scan is cheap, the first sighting of a
 * session is a baseline rather than news, and the only thing a sighting can produce is a wake in den's own
 * conversation.
 *
 * Two of these tests exist because re-reading the reader found defects a passing suite had not: a tail window
 * smaller than a single frame hid a failing turn, and an alert keyed on the file size re-reported the same old
 * error whenever the conversation moved on. Both are pinned here.
 *
 * ASCII only, deliberately: a PowerShell round trip mangled non-ASCII comments in a sibling test once.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const {
  MAX_TAIL_BYTES,
  alertKey,
  observeSessionActivity,
  scanSessionLogs,
  shouldAlert,
  summariseTail,
  tailEvents,
  watchWakeFor,
} = await import('../src/watcher.js')
const { normalizeTrigger } = await import('../src/triggers.js')

function frame(events) {
  return zstdCompressSync(Buffer.from(events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8'))
}

/** A session store of its own, with one or two sessions in it. */
function withStore(run) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-den-watch-'))
  try {
    const dirOf = (id) => join(root, '--C-Users-someone-project--', id)
    const logOf = (id) => join(dirOf(id), 'session.v4.jsonl.zstd')
    const write = (id, events) => {
      mkdirSync(dirOf(id), { recursive: true })
      writeFileSync(logOf(id), frame(events))
    }
    const append = (id, events) => appendFileSync(logOf(id), frame(events))
    return run({ root, dirOf, logOf, write, append })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const asked = (text, at = 1) => ({ type: 'user/message', time: at, data: { content: [{ type: 'text', text }] } })
const answered = (text, at = 2) => ({
  type: 'assistant/message',
  time: at,
  data: { message: { content: [{ type: 'text', text }] } },
})
const failed = (message, at = 3) => ({
  type: 'turn/end',
  time: at,
  data: { reason: { kind: 'error', error: { message } } },
})
const fine = (at = 3) => ({ type: 'turn/end', time: at, data: { reason: { kind: 'completed' } } })

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
  withStore(({ root, write, append }) => {
    write('sess-1', [asked('hi'), fine()])
    const first = observeSessionActivity({ root, seen: {}, now: 1000 })
    const second = observeSessionActivity({ root, seen: first.seen, now: 2000 })
    assert.deepEqual(second.changes, [], 'nothing changed, so nothing was read')

    append('sess-1', [failed('boom', 4)])
    const third = observeSessionActivity({ root, seen: first.seen, now: 3000 })
    assert.equal(third.attention.length, 1)
    assert.equal(third.attention[0].error, 'boom')
    assert.equal(shouldAlert(third.attention[0], {}), true)
    const alerted = { [alertKey(third.attention[0])]: 1 }
    assert.equal(shouldAlert(third.attention[0], alerted), false, 'alerted once is alerted')
  })
})

test('a healthy turn produces no attention at all', () => {
  withStore(({ root, write, append }) => {
    write('sess-2', [asked('hi')])
    const first = observeSessionActivity({ root, seen: {}, now: 1000 })
    append('sess-2', [answered('hello'), fine()])
    const second = observeSessionActivity({ root, seen: first.seen, now: 2000 })
    assert.equal(second.changes.length, 1)
    assert.equal(second.changes[0].spoke, true)
    assert.deepEqual(second.attention, [])
  })
})

test('the tail reader stays bounded in bytes but grows until it holds a turn ending', () => {
  withStore(({ root, write }) => {
    // One frame, six events: bigger than the starting window below, small enough to hold the ending.
    write('sess-3', [asked('first'), answered('a'), fine(), asked('second'), answered('b'), fine(9)])
    const log = scanSessionLogs({ root })[0]
    const whole = tailEvents(log.path, log.size, { keep: 50 })
    assert.equal(whole.length, 6)

    // A 64-byte starting window cannot hold that frame, and a fixed window would have answered "no ending".
    const grown = tailEvents(log.path, log.size, { tailBytes: 64, keep: 50 })
    assert.equal(grown.length, 6, 'the window grew because it held no turn ending')

    // And the growth is bounded: with the ceiling at the same 64 bytes it gives up instead of reading it all.
    const capped = tailEvents(log.path, log.size, { tailBytes: 64, maxTailBytes: 64, keep: 50 })
    assert.deepEqual(capped, [], 'a bounded reader answers empty rather than decompressing a whole log')
  })
})

test('the summary reads both message shapes and names the failing turn', () => {
  const healthy = summariseTail([asked('hello'), answered('hi'), fine()])
  assert.equal(healthy.spoke, true)
  assert.equal(healthy.error, '')
  assert.equal(healthy.errorAt, 0, 'a turn that completed is not a failing turn')

  const broken = summariseTail([asked('x'), failed('nope', 7)])
  assert.equal(broken.error, 'nope')
  assert.equal(broken.errorAt, 7, 'the instant of the failing turn, which is what the alert is keyed on')
  assert.equal(broken.lastAt, 7)
})

test('the same failing turn is not reported twice just because the log grew', () => {
  withStore(({ root, write, append }) => {
    write('sess-4', [asked('hi'), fine()])
    const first = observeSessionActivity({ root, seen: {}, now: 1000 })
    append('sess-4', [failed('same old error', 4)])
    const second = observeSessionActivity({ root, seen: first.seen, now: 2000 })
    assert.equal(second.attention.length, 1)
    const alerted = { [alertKey(second.attention[0])]: 1 }

    // The human replies. The size changes; the failing turn does not.
    append('sess-4', [asked('are you there', 5)])
    const third = observeSessionActivity({ root, seen: second.seen, now: 3000 })
    assert.equal(third.changes.length, 1, 'the append was seen')
    assert.equal(third.changes[0].errorAt, 4, 'and the last turn ending is still the same failure')
    assert.equal(shouldAlert(third.changes[0], alerted), false, 'so it is not reported again')

    // A genuinely new failure does get through.
    append('sess-4', [answered('yes', 6), failed('a new failure', 8)])
    const fourth = observeSessionActivity({ root, seen: third.seen, now: 4000 })
    assert.equal(fourth.attention.length, 1)
    assert.equal(fourth.attention[0].error, 'a new failure')
    assert.equal(shouldAlert(fourth.attention[0], alerted), true)
  })
})

test('a half-written frame is not lost, only deferred until it is complete', () => {
  withStore(({ root, write, logOf }) => {
    write('sess-5', [asked('hi'), fine()])
    const first = observeSessionActivity({ root, seen: {}, now: 1000 })

    // A write caught mid-flight: the first half of a frame that ends in a failure.
    const complete = frame([answered('working', 4), failed('late failure', 5)])
    const half = Math.floor(complete.length / 2)
    appendFileSync(logOf('sess-5'), complete.subarray(0, half))
    const partial = observeSessionActivity({ root, seen: first.seen, now: 2000 })
    assert.equal(partial.changes.length, 1, 'the growth was seen')
    assert.equal(partial.changes[0].error, '', 'but a frame that will not decompress is never trusted')
    assert.deepEqual(partial.attention, [], 'so nothing is reported from it yet')

    // The rest of the frame lands. The same bytes now decompress, and the failure is found exactly once.
    appendFileSync(logOf('sess-5'), complete.subarray(half))
    const finished = observeSessionActivity({ root, seen: partial.seen, now: 3000 })
    assert.equal(finished.attention.length, 1, 'the deferred failure arrived')
    assert.equal(finished.attention[0].error, 'late failure')
  })
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
  assert.equal(stored.maySpeak, true, 'a once trigger defaults to silent, which this one must override')
  assert.equal(MAX_TAIL_BYTES, 4 * 1024 * 1024)
})
