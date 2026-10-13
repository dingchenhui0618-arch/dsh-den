/**
 * The installed gate, driven the way the Host drives it.
 *
 * `gate-coverage.test.mjs` proves every tool is *classified*, and `gate.test.mjs` proves
 * the classifier's decisions. Neither proves the gate the plugin actually **installed**
 * will stop a call, because the shared `fakeHost` records guards into an array and never
 * invokes one. That is the fifth instance of a single recurring mistake:
 *
 *   **the fixture stands in for a caller in a way the real caller never behaves.**
 *
 * The four previous instances were the heartbeat with no agent, the reply that
 * `sendMessage` does not return, the empty string that meant two different things, and
 * the cold resume spent on unauthorized conversations. Each was found by asking what the
 * *production* caller does and noticing the test did something else.
 *
 * So the guard is taken back out of the registry here and called with an object shaped
 * like the one the Host passes. The assertions are about the installed artefact: a guard
 * registered but not reachable, or the wrong disposer, fails here even while
 * `classifyCall` stays perfect.
 *
 * Measured against the live `tools` service contract (host Service provider):
 *
 *   guard(guard: ToolGuard): () => void
 *   type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined
 *   interface ToolExecution { callId, name, arguments, agent?, signal, ... }
 *
 * "A returned string denies the execution." The `tools/pre-execute` listener is the
 * second install and carries the `ask` decisions, which the waterfall types differently.
 *
 * This file deliberately contains no credential-shaped literal. The path the secret rule
 * must refuse is imported from the module that already builds it from parts, because
 * writing it out here would trip that same rule — which is the gate working, and not a
 * reason to weaken the test.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const sandboxHome = mkdtempSync(join(tmpdir(), 'dsh-den-gatewire-'))
process.env.DSH_HOME = sandboxHome
test.after(() => rmSync(sandboxHome, { recursive: true, force: true }))

const { apply } = await import('../src/index.js')
const { fakeHost } = await import('./support/host.mjs')
const { secretShapedPath } = await import('./support/fixtures.mjs')

/**
 * Build an execution input the way the Host would.
 *
 * `arguments` is a parsed object, not a string: the registry parses the model's JSON
 * before dispatch, and `classifyCall` flattens whatever shape it finds.
 */
function execution(name, args, agent) {
  return {
    callId: 'call-1',
    rootCallId: 'call-1',
    name,
    arguments: args,
    agent,
    signal: new AbortController().signal,
  }
}

/** The guard the plugin actually registered, as the Host would hold it. */
function installedGuard(state) {
  assert.equal(state.guards.length, 1, 'exactly one monotonic guard is installed')
  return state.guards[0]
}

test('the installed guard refuses a credential-shaped read, as the Host calls it', () => {
  const { ctx, state } = fakeHost()
  apply(ctx)
  const guard = installedGuard(state)

  const verdict = guard(execution('read', { file_path: secretShapedPath() }))

  assert.equal(typeof verdict, 'string', 'a returned string is how a guard denies')
  assert.match(verdict, /^refused:/)
  assert.match(verdict, /credential/)
})

test('the installed guard permits an ordinary call and still refuses the hard rule', () => {
  const { ctx, state } = fakeHost()
  apply(ctx)
  const guard = installedGuard(state)

  // `undefined` means "this guard has no objection" — not "allow". The Host falls
  // through to its remaining guards, and none may force-allow what another denied.
  const fine = guard(execution('read', { file_path: 'README.md' }))
  assert.equal(fine, undefined, 'an ordinary read must pass this guard untouched')

  const denied = guard(execution('read', { file_path: secretShapedPath() }))
  assert.equal(typeof denied, 'string', 'the same guard still refuses the hard rule')
})

test('a deny risk does not depend on the pre-execute listener being installed', () => {
  // The plugin installs the monotonic guard unconditionally and the `ask` listener only
  // when the context has an event bus. That asymmetry is deliberate: a composition
  // without a listener API must still get the hard rules, rather than losing the whole
  // gate — and with it the plugin — to a missing method.
  const { ctx, state } = fakeHost()
  delete ctx.on
  apply(ctx)

  const guard = installedGuard(state)
  const verdict = guard(execution('read', { file_path: secretShapedPath() }))
  assert.match(String(verdict), /^refused:/, 'the hard rules must survive a missing event bus')
})

test('a refusal reaches the durable audit trail, not only the in-memory ring', () => {
  // Two surfaces record the same decision and only one of them survives the process, so
  // wiring one and not the other fails silently. It did: `onDecision` announced the
  // decision through `noteEvent` and never called `recordAudit`, while `gateAudit()` reads
  // `gate-audit.json` — a file nothing wrote. The panel's gate surface therefore reported
  // "no decisions" forever, including while three real ones had just been made on the live
  // Host, and it looked exactly like a gate that had never fired.
  //
  // This is the same shape as the `statusSnapshot` allow-list: one `status()` field plus
  // one plumbing site, where forgetting the second produces an empty result rather than an
  // error. So the seam is pinned from both ends — the service reader and the file itself.
  const { ctx, state } = fakeHost()
  apply(ctx)
  const guard = installedGuard(state)
  const service = state.provided.get('den')

  // The sandbox home is shared by every test in this file, and the tests above each make a
  // refusal, so the trail is not empty here. Assert the *growth* rather than a clean slate;
  // it would be a weaker test to reset state and then claim the reader works.
  const before = service.gateAudit().length

  const verdict = guard(execution('read', { file_path: secretShapedPath() }))
  assert.match(String(verdict), /^refused:/)

  const trail = service.gateAudit()
  assert.equal(trail.length, before + 1, 'a refusal must reach the durable audit, not only the ring')
  const entry = trail.at(-1)
  assert.equal(entry.tool, 'read')
  assert.equal(entry.rule, 'secret:credentials-yaml')
  assert.equal(entry.risk, 2)
  assert.equal(entry.decision, 'deny')

  // Read the file directly as well: `gateAudit()` is the reader, so asserting only through
  // it would pass even if reader and writer were the same piece of memory.
  const onDisk = JSON.parse(readFileSync(join(sandboxHome, 'den', 'gate-audit.json'), 'utf8'))
  assert.equal(onDisk.entries.length, before + 1, 'the audit must be on disk, where a restart can find it')
  assert.equal(onDisk.entries.at(-1).rule, 'secret:credentials-yaml')

  // The audit deliberately records the verdict and never the arguments: an audit log that
  // copies tool arguments is a second place a secret can leak from.
  const serialised = JSON.stringify(onDisk)
  assert.equal(/credentials\.ya?ml/.test(serialised), false, 'the audit must not quote the path it refused')
})

test('disposing the plugin withdraws the guard, so it cannot outlive its effect', () => {
  // Guards are monotonic: the Host lets any guard deny, and no guard can force-allow.
  // That makes an undisposed guard a permanent, invisible veto on every future tool call,
  // including the Host's own. The registry must be handed back.
  const { ctx, state } = fakeHost()
  const dispose = apply(ctx)
  assert.equal(state.guards.length, 1)

  assert.equal(typeof dispose, 'function', 'apply must return the effect disposer')
  dispose()
  assert.equal(state.guards.length, 0, 'the guard must be withdrawn with the plugin')
})
