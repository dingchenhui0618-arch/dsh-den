/**
 * Tests for the outbound approval gate.
 *
 * The point of these tests is not coverage. It is to pin the cases that decide
 * whether handing this assistant real credentials is defensible: a credential
 * read is refused, an outbound action stops to ask, and an unrecognised tool does
 * not get a free pass.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

const { DEFAULT_RISK, RISK, classifyCall, decide, flattenArgs, installGate } = await import('../src/gate.js')

const call = (name, args) => ({ name, arguments: args })

// ------------------------------------------------------------- secret reads

test('reading a stored credential is refused, not merely questioned', () => {
  const cases = [
    ['bash', { command: 'cat ~/.dsh/.credentials.yaml' }],
    ['read', { path: 'C:/Users/123/.dsh/credentials/token.json' }],
    ['bash', { command: 'cat .env' }],
    ['bash', { command: 'cat .env.production' }],
    ['bash', { command: 'cat /home/me/.ssh/id_rsa' }],
    ['bash', { command: 'cat ~/.aws/credentials' }],
    ['bash', { command: 'cat ~/.npmrc' }],
    ['bash', { command: 'cat ~/.git-credentials' }],
    ['bash', { command: 'cat ~/.kube/config' }],
    ['bash', { command: 'cat ~/.codex/auth.json' }],
  ]
  for (const [name, args] of cases) {
    const result = classifyCall(call(name, args))
    assert.equal(result.risk, RISK.deny, `${name} ${JSON.stringify(args)} must be denied`)
    assert.match(result.rule, /^secret:/)
    assert.equal(decide(result).kind, 'deny')
  }
})

test('a denial carries structured error info for the log without polluting the message', () => {
  const result = classifyCall(call('bash', { command: 'cat .env' }))
  const decision = decide(result)
  assert.equal(decision.kind, 'deny')
  assert.equal(decision.info.name, 'DenOutboundGate')
  assert.equal(decision.info.code, result.rule)
  assert.ok(decision.reason.length > 0)
})

// ---------------------------------------------------------- outbound actions

test('actions that reach outside ask before running', () => {
  const cases = [
    ['bash', { command: 'git push origin main' }],
    ['bash', { command: 'npm publish' }],
    ['bash', { command: 'gh repo create foo' }],
    ['bash', { command: 'curl -X POST -d @payload.json https://example.com/hook' }],
    ['bash', { command: 'aws s3 rm s3://bucket/key' }],
    ['bash', { command: 'docker push registry/app:tag' }],
    ['bash', { command: 'rm -rf /important' }],
    ['bash', { command: 'shutdown /s' }],
  ]
  for (const [name, args] of cases) {
    const result = classifyCall(call(name, args))
    assert.equal(result.risk, RISK.ask, `${JSON.stringify(args)} must ask`)
    assert.equal(decide(result).kind, 'ask')
  }
})

test('an ask decision carries a localised display reason', () => {
  const result = classifyCall(call('bash', { command: 'git push' }))
  const decision = decide(result)
  assert.equal(decision.kind, 'ask')
  assert.ok(decision.displayReason.en.length > 0)
  assert.ok(decision.displayReason['zh-CN'].length > 0)
})

// -------------------------------------------------------------- fail-closed

test('an unrecognised tool asks rather than passing', () => {
  const result = classifyCall(call('some_new_tool', { anything: true }))
  assert.equal(result.risk, DEFAULT_RISK)
  assert.equal(DEFAULT_RISK, RISK.ask)
  assert.equal(result.rule, 'unknown-tool')
  assert.equal(decide(result).kind, 'ask')
})

test('a call with no arguments at all still asks when the tool is unknown', () => {
  const result = classifyCall({ name: 'mystery' })
  assert.equal(result.risk, RISK.ask)
})

test('a nameless call is not treated as safe', () => {
  assert.equal(classifyCall({}).risk, DEFAULT_RISK)
  assert.equal(classifyCall(undefined).risk, DEFAULT_RISK)
})

test('a declared read-only search passes without asking', () => {
  const result = classifyCall(call('web_search', { query: 'weather' }))
  assert.equal(result.risk, RISK.allow)
  assert.equal(decide(result).kind, 'allow')
})

test("the den's own read-only tools do not raise an approval prompt", () => {
  // Measured defect, not a hypothetical: `den_status` fell through to the unknown
  // -tool default and produced `approval/asked: unrecognised tool den_status`,
  // which the human then rejected. An assistant that raises a dialog every time it
  // looks at itself trains the human to approve without reading.
  for (const name of ['den_status', 'den_explain_gate', 'den_scenarios', 'den_recall', 'den_schedule_list']) {
    const result = classifyCall(call(name, {}))
    assert.equal(result.risk, RISK.allow, `${name} must pass without asking`)
    assert.equal(decide(result).kind, 'allow', `${name} must not raise an approval prompt`)
  }
})

test('state-changing and privilege-changing den tools still ask', () => {
  // The safety half of the same rule: silent read-only tools must not become a
  // blanket exemption for the ones that write durable state or change authority.
  for (const name of ['den_remember', 'den_forget', 'den_schedule_check', 'den_schedule_delete', 'den_configure', 'den_set_autonomy']) {
    const result = classifyCall(call(name, {}))
    assert.equal(result.risk, RISK.ask, `${name} must still be reviewed`)
    assert.equal(decide(result).kind, 'ask')
  }
})

// ------------------------------------------------------- argument flattening

test('arguments are searched wherever the calling convention put them', () => {
  // The dangerous text is nested, not top-level.
  const nested = call('some_tool', { options: { exec: { command: 'git push --force' } } })
  assert.equal(classifyCall(nested).risk, RISK.ask)
})

test('flattening is bounded and cannot be used to hang the gate', () => {
  let deep = 'bottom'
  for (let i = 0; i < 50; i += 1) deep = { next: deep }
  // Must return rather than recurse forever.
  const text = flattenArgs(deep)
  assert.equal(typeof text, 'string')

  const wide = Array.from({ length: 5000 }, (_, i) => `item-${i}`)
  assert.ok(flattenArgs(wide).length < 20000 * 200)
})

test('flattening handles non-string primitives and null without throwing', () => {
  assert.equal(flattenArgs(null), '')
  assert.equal(flattenArgs(undefined), '')
  assert.equal(flattenArgs(42), '42')
  assert.equal(flattenArgs(false), 'false')
})

// ------------------------------------------------------------- installation

/** Minimal fake Host context capturing what the gate installs. */
function fakeCtx() {
  const listeners = new Map()
  const guards = []
  const tools = {
    guard(handler) {
      guards.push(handler)
      return () => {
        const at = guards.indexOf(handler)
        if (at >= 0) guards.splice(at, 1)
      }
    },
  }
  return {
    listeners,
    guards,
    tools,
    on(event, handler) {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
  }
}

test('installing the gate mounts both a pre-execute listener and a monotonic guard', () => {
  const ctx = fakeCtx()
  const dispose = installGate(ctx, { tools: ctx.tools })
  assert.ok(ctx.listeners.has('tools/pre-execute'))
  assert.equal(ctx.guards.length, 1)

  dispose()
  assert.equal(ctx.listeners.size, 0)
  assert.equal(ctx.guards.length, 0)
})

test('the pre-execute listener delegates to next() for an allowed call', async () => {
  const ctx = fakeCtx()
  installGate(ctx, { tools: ctx.tools })
  let delegated = false
  const result = await ctx.listeners.get('tools/pre-execute')(
    { name: 'web_search', arguments: { query: 'x' } },
    () => {
      delegated = true
      return Promise.resolve({ kind: 'allow' })
    },
  )
  assert.equal(delegated, true)
  assert.deepEqual(result, { kind: 'allow' })
})

test('the pre-execute listener returns ask without delegating', async () => {
  const ctx = fakeCtx()
  installGate(ctx, { tools: ctx.tools })
  const result = await ctx.listeners.get('tools/pre-execute')(
    { name: 'bash', arguments: { command: 'git push' } },
    () => {
      throw new Error('must not delegate an ask')
    },
  )
  assert.equal(result.kind, 'ask')
})

test('the monotonic guard denies a secret read even though pre-execute ran first', () => {
  const ctx = fakeCtx()
  installGate(ctx, { tools: ctx.tools })
  // The guard is the backstop: it does not care what the waterfall decided.
  const reason = ctx.guards[0]({ name: 'read', arguments: { path: '~/.dsh/.credentials.yaml' } })
  assert.equal(typeof reason, 'string')
  assert.match(reason, /credential/)
})

test('the guard stays silent on an ordinary call', () => {
  const ctx = fakeCtx()
  installGate(ctx, { tools: ctx.tools })
  assert.equal(ctx.guards[0]({ name: 'read', arguments: { path: 'src/index.js' } }), undefined)
})

test('every decision the gate makes is reported for auditing', async () => {
  const ctx = fakeCtx()
  const seen = []
  installGate(ctx, { tools: ctx.tools, onDecision: (entry) => seen.push(entry) })

  await ctx.listeners.get('tools/pre-execute')(
    { name: 'bash', arguments: { command: 'git push' } },
    () => ({ kind: 'allow' }),
  )
  ctx.guards[0]({ name: 'bash', arguments: { command: 'cat .env' } })

  assert.equal(seen.length, 2)
  assert.ok(seen.some((entry) => entry.decision.kind === 'ask'))
  assert.ok(seen.some((entry) => entry.classification.risk === RISK.deny))
})
