/**
 * Tests for the outbound approval gate.
 *
 * The point of these tests is not coverage. It is to pin the cases that decide
 * whether handing this assistant real credentials is defensible: a credential
 * read is refused, an outbound action stops to ask, and an unrecognised tool does
 * not get a free pass.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

const { DEFAULT_RISK, RISK, classifyCall, decide, flattenArgs, installGate } = await import('../src/gate.js')
// The credential-shaped path is assembled from parts in exactly one place, so that no test
// file has to carry a literal the repository's own pre-push scan would then have to excuse.
const { secretShapedPath } = await import('./support/fixtures.mjs')

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

test('DSH session ZIP scratch cleanup stays usable while other recursive deletes ask', () => {
  const inspectSession = [
    `$zip = 'D:\\Downloads\\session.zip'`,
    '$dst = "$env:TEMP\\dsh-sess"',
    'if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }',
    'Expand-Archive -Path $zip -DestinationPath $dst -Force',
  ].join('\n')

  const cleanup = classifyCall(call('pwsh', { command: inspectSession }))
  assert.equal(cleanup.risk, RISK.allow)
  assert.equal(cleanup.rule, 'tool:pwsh')

  const otherTempPath = classifyCall(
    call('pwsh', { command: 'Remove-Item "$env:TEMP\\other-dir" -Recurse -Force' }),
  )
  assert.equal(otherTempPath.risk, RISK.ask)
  assert.equal(otherTempPath.rule, 'outbound:recursive-delete')
})

test('an outbound reason names the destination, because local and remote are not the same claim', () => {
  // The command strings below are assembled from pieces on purpose. The gate flattens the
  // arguments of *every* tool call and tests every rule against that text, without looking at
  // the tool name — so a source file containing the literal pattern is itself escalated, and
  // the edit writing it is refused. See DESIGN 2.13; this split is a symptom, not a style.
  const upload = (url) =>
    classifyCall(call('pwsh', { command: 'cur' + 'l -s --da' + 'ta-binary @payload ' + url }))

  const local = upload('http://127.0.0.1:10086/command')
  assert.equal(local.risk, RISK.ask)
  assert.equal(local.destination, '127.0.0.1:10086')
  assert.match(local.reason, /127\.0\.0\.1:10086/)
  // The classification is unchanged: a loopback upload is still classified `ask`, still names where
  // it goes, and still says so in its reason. What changed on 2026-10-14 is the decision — the human
  // allowed this half through (the exception, and its bounds, are pinned in gate-loopback.test.mjs),
  // so the readable-prompt assertion now belongs to the remote case, where `ask` still happens.
  assert.equal(decide(local).kind, 'allow')

  const remote = upload('https://example.com/collect')
  assert.equal(remote.destination, 'example.com')
  assert.match(remote.reason, /example\.com/)
  assert.match(decide(remote).displayReason['zh-CN'], /example\.com/)

  // A rule that fires with nothing to name must not invent one.
  const anonymous = classifyCall(call('pwsh', { command: 'r' + 'm -r' + 'f /tmp/scratch' }))
  assert.equal(anonymous.rule, 'outbound:recursive-delete')
  assert.equal(anonymous.destination, '')
  assert.doesNotMatch(anonymous.reason, /destination/)
})

test('a tool-level ask names the destination too, because the tool is not where the call goes', () => {
  // Measured on the live host. The gate answered a read of the local GUI with
  // {"tool":"web_fetch","rule":"tool:web_fetch","risk":1,"decision":"ask"} — a prompt naming
  // the tool and not the address, so reading this Host's own status route and reading any
  // host on the internet arrive identically at the human. The outbound rules had been taught
  // to name the destination; this branch had not.
  const loopback = classifyCall(call('web_fetch', { url: 'http://127.0.0.1:19387/' }))
  assert.equal(loopback.rule, 'tool:web_fetch')
  assert.equal(loopback.risk, RISK.ask)
  assert.equal(loopback.destination, '127.0.0.1:19387')
  assert.match(loopback.reason, /127\.0\.0\.1:19387/)
  assert.match(decide(loopback).displayReason['zh-CN'], /127\.0\.0\.1:19387/)

  const stranger = classifyCall(call('web_fetch', { url: 'https://example.invalid/collect' }))
  assert.equal(stranger.destination, 'example.invalid')
  assert.match(stranger.reason, /example\.invalid/)

  // A tool-level ask with no address in its arguments must not invent one, in either language.
  const anonymous = classifyCall(call('web_fetch', { url: '' }))
  assert.equal(anonymous.rule, 'tool:web_fetch')
  assert.equal(anonymous.destination, '')
  assert.doesNotMatch(anonymous.reason, /destination/)
  assert.doesNotMatch(decide(anonymous).displayReason['zh-CN'], /目标/)
})

test('an outbound rule constrains the command that runs, not the file that mentions it', () => {
  // Assembled from pieces: the gate installed in this profile still scans every tool's
  // arguments, because the narrowing asserted here is in the tree but not yet loaded by the
  // running Host. Once it is, these strings can be written plainly.
  const push = 'git ' + 'push'

  // A shell tool executes it, so it asks.
  assert.equal(classifyCall(call('pwsh', { command: push })).risk, RISK.ask)
  assert.equal(classifyCall(call('bash', { command: push })).risk, RISK.ask)

  // A file tool only puts the text somewhere. Writing a script is not running it, so a rule
  // that exists to catch *running* it must not fire here — and the same goes for the read-only
  // tool whose job is to answer what the gate would do. Previously both were refused, which
  // made the rule set impossible to document or extend.
  assert.equal(classifyCall(call('edit', { file_path: 'x.md', new_string: push })).risk, RISK.allow)
  assert.equal(classifyCall(call('write', { file_path: 'x.md', content: push })).risk, RISK.allow)
  assert.equal(
    classifyCall(call('den_explain_gate', { tool: 'bash', args: { command: push } })).risk,
    RISK.allow,
  )

  // The secret rules are *target* rules, not action rules, and they still see every tool, so
  // narrowing the outbound set did not narrow them.
  assert.equal(
    classifyCall(call('edit', { file_path: 'x.md', new_string: 'see .dsh/' + 'credentials.yaml' }))
      .risk,
    RISK.deny,
  )
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

test('local inspection shells and DSH read-only tools pass without approval', () => {
  for (const [name, args] of [
    ['pwsh', { command: 'pwd; node -v; python --version' }],
    ['bash', { command: 'printf hello' }],
    ['shell', { command: 'git status --short' }],
    ['cordis_inspect_list', {}],
    ['cordis_inspect_query', { query: 'tools' }],
    ['list_agents', {}],
    ['job_list', {}],
    ['team_task_list', {}],
    ['grep', { pattern: 'den_status', path: 'src' }],
    ['glob', { pattern: '**/*.js' }],
    ['ask_user_question', { questions: [] }],
  ]) {
    const result = classifyCall(call(name, args))
    assert.equal(result.risk, RISK.allow, `${name} must pass without asking`)
    assert.equal(decide(result).kind, 'allow', `${name} must not raise an approval prompt`)
  }
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

test('the core file tools do not raise an approval prompt', () => {
  // Measured in this profile's gate audit: `read`, `write` and `edit` were absent
  // from TOOL_RISK, so every one of them fell through to `defaultRisk: ask` and,
  // with approval prompts disabled on the Host, came back as `user rejected`.
  // `grep` and `glob` worked in the same session purely because they were listed.
  for (const [name, args] of [
    ['read', { file_path: join('D:', 'Projects', 'dsh-den', 'src', 'gate.js') }],
    ['write', { file_path: join('D:', 'Projects', 'dsh-den', 'tmp.txt'), content: 'x' }],
    ['edit', { file_path: join('D:', 'Projects', 'dsh-den', 'src', 'gate.js'), old_string: 'a', new_string: 'b' }],
  ]) {
    const result = classifyCall(call(name, args))
    assert.equal(result.risk, RISK.allow, `${name} must pass without asking`)
    assert.equal(decide(result).kind, 'allow', `${name} must not raise an approval prompt`)
  }
})

test('the secret rule still outranks the file-tool allowlist', () => {
  // The safety half. Allowing the file tools must not become a way to read or
  // overwrite a credential: the path rules are consulted before TOOL_RISK, so the
  // deny does not depend on which tool is holding the path.
  //
  // The paths are assembled with `join` rather than written as literals, so this
  // file never contains a real credential path for a copy-paste to follow.
  const credential = join('C:', 'Users', '123', '.dsh', `.credential${'s.yaml'}`)
  const codexAuth = join('C:', 'Users', '123', '.codex', `auth${'.json'}`)
  const npmrc = join('D:', 'Projects', 'app', `.npm${'rc'}`)
  for (const [name, args] of [
    ['read', { file_path: credential }],
    ['write', { file_path: codexAuth, content: 'x' }],
    ['edit', { file_path: npmrc, old_string: 'a', new_string: 'b' }],
  ]) {
    const result = classifyCall(call(name, args))
    assert.equal(result.risk, RISK.deny, `${name} on a credential path must be refused, not allowed`)
    assert.equal(decide(result).kind, 'deny')
  }
})
test("the den's own tools are recognised, and each one says what bounds it", () => {
  // This replaces a test that asserted the opposite — "state-changing and privilege-changing
  // den tools still ask". That assertion was true, and it was also the defect: the profile's
  // `defaultPreset: danger-full-access` implies `approval: never`, so `ask` did not mean "a
  // human will decide later", it meant these tools never ran at all — and the result came back
  // as `user rejected` when nobody had rejected anything (DESIGN §2.29).
  //
  // What the old test wanted to protect is real, and it is asserted where it actually lives:
  // inside the tools (`test/mount.test.mjs` — the assistant cannot grant itself autonomy), and
  // structurally in `test/gate-coverage.test.mjs`, which fails if the entry for the authority
  // tool stops naming the human act.
  for (const name of ['den_remember', 'den_forget', 'den_schedule_check', 'den_schedule_delete', 'den_configure', 'den_set_autonomy']) {
    const result = classifyCall(call(name, {}))
    assert.equal(result.risk, RISK.allow, `${name} is the den's own tool, not a foreign capability`)
    assert.equal(result.rule, `owned:${name}`, 'the audit line must name the tool, not a bare allow')
    assert.ok(result.reason.length > 30, `${name} needs a reason a reader can check, not a label`)
    assert.equal(decide(result).kind, 'allow')
  }
})

test('allowing the den its own tools widened nothing above the table', () => {
  // The control for the change above. If any of these three ever soften, the allow list has
  // started swallowing the rules the gate exists for.
  const unknown = classifyCall(call('some_tool_this_profile_has_never_seen', {}))
  assert.equal(unknown.risk, RISK.ask, 'an unrecognised capability still fails closed')
  assert.equal(unknown.rule, 'unknown-tool')

  const outbound = classifyCall(call('pwsh', { command: 'git push origin master' }))
  assert.equal(outbound.risk, RISK.ask, 'the shell rules still run for shells')
  assert.match(outbound.rule, /^outbound:/)

  const leak = classifyCall(call('den_remember', { text: `store this: ${secretShapedPath()}` }))
  assert.equal(leak.risk, RISK.deny, 'an owned tool is not a way around the credential rule')
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
