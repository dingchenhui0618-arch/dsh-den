/**
 * The gate is on by default and can be switched off from one file, because a gate that turns risky
 * tool calls into `ask` decisions becomes a gate that refuses them outright wherever the host has
 * approval prompts disabled — which is a setting the person, not the plugin, gets to choose.
 *
 * The direction that matters is fail-closed: only an explicit "off" disables anything.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { approvalEnabled, installGate } = await import('../src/gate.js')

function withSwitch(value, run) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-den-approval-'))
  try {
    if (value !== undefined) {
      writeFileSync(join(dir, 'approval.json'), typeof value === 'string' ? value : JSON.stringify(value))
    }
    return run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('no file at all leaves the gate on, because a missing switch is not permission', () => {
  withSwitch(undefined, (dir) => assert.equal(approvalEnabled(dir), true))
})

test('only an explicit off switches it off, and case does not decide that', () => {
  withSwitch({ approval: 'off' }, (dir) => assert.equal(approvalEnabled(dir), false))
  withSwitch({ approval: 'OFF' }, (dir) => assert.equal(approvalEnabled(dir), false))
  withSwitch({ approval: ' on ' }, (dir) => assert.equal(approvalEnabled(dir), true))
  withSwitch({ approval: true }, (dir) => assert.equal(approvalEnabled(dir), true))
  withSwitch({ somethingElse: 'off' }, (dir) => assert.equal(approvalEnabled(dir), true))
})

test('a file that cannot be understood keeps the gate on', () => {
  withSwitch('{ not json', (dir) => assert.equal(approvalEnabled(dir), true))
  withSwitch('', (dir) => assert.equal(approvalEnabled(dir), true))
  withSwitch([1, 2, 3], (dir) => assert.equal(approvalEnabled(dir), true))
})

test('the installer registers nothing at all when the switch says off', () => {
  withSwitch({ approval: 'off' }, (dir) => {
    const registered = []
    const ctx = { on: () => registered.push('event') }
    const tools = { guard: () => registered.push('guard') }
    assert.equal(installGate(ctx, { tools, dir }), null)
    assert.deepEqual(registered, [], 'not one listener, not one guard')
  })
  withSwitch({ approval: 'on' }, (dir) => {
    const ctx = { on: () => () => {} }
    const tools = { guard: () => () => {} }
    assert.equal(typeof installGate(ctx, { tools, dir }), 'function', 'and on still installs')
  })
})
