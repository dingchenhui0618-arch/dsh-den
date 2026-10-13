/**
 * Audit the gate's tool table against the tools this Host actually exposes.
 *
 * The gate is only as good as its coverage. An unlisted tool is not ignored — it
 * fails closed to `ask` — but in a session with approval prompts disabled, `ask`
 * means an automatic `user rejected`. So "fail closed" and "silently unusable"
 * are the same outcome from the human's side, and which tools land there is a real
 * decision that should be made deliberately rather than by omission.
 *
 * The measured incident this guards against: `read`, `write` and `edit` were
 * absent, fell to `ask`, and became automatic rejections — a gate that cannot be
 * worked with, which is the pressure that makes a human disable it entirely.
 *
 * The tool list below is read from the Host, not guessed:
 *   cordis_inspect_query(platform: host, provider: Tool, method: listTools)
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const { classifyCall, RISK } = await import('../src/gate.js')
// The credential-shaped path is shared with `gate-installed.test.mjs` so the name is
// assembled from parts in exactly one place. See `support/fixtures.mjs`.
const { secretShapedPath } = await import('./support/fixtures.mjs')

/**
 * Every tool the Host reported as callable by this Agent. Kept verbatim so a new
 * tool appearing in the profile shows up here as a failing expectation rather than
 * as a silent behaviour change.
 */
const HOST_TOOLS = [
  // the den's own surface
  'den_status',
  'den_schedule_check',
  'den_schedule_list',
  'den_schedule_delete',
  'den_set_autonomy',
  'den_configure',
  'den_explain_gate',
  'den_remember',
  'den_recall',
  'den_forget',
  'den_scenarios',
  // files and search
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'read_image',
  // execution
  'pwsh',
  // network
  'web_search',
  'web_fetch',
  // session and coordination
  'list_agents',
  'send_message',
  'interrupt_agent',
  'spawn_teammate',
  'subagent',
  'subagent_fork',
  'wait_agent',
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',
  'todo_write',
  'job_list',
  'job_output',
  'job_kill',
  'skill',
  'present',
  // goals, planning, questions
  'get_goal',
  'create_goal',
  'update_goal',
  'ask_user_question',
  'exit_plan_mode',
  // inspection and orchestration
  'cordis_inspect_list',
  'cordis_inspect_query',
  'load_workspace_dependencies',
  'workflow',
  'ship_receipt',
  'vision_diff',
]

/**
 * Tools deliberately left on the fail-closed default. Every entry is a recorded
 * decision: these either change the den's own state, change a permission, or reach
 * outside the machine.
 *
 * Note what is NOT here: `pwsh`, `workflow` and `ship_receipt`. They can run
 * commands, but the deny and ask rules above them are pattern-based rather than
 * tool-based, so a credential read or an outbound action is caught whichever tool
 * carries it. Blocking the tool instead would only push the work through a
 * different one while making the gate unusable.
 */
const DELIBERATELY_ASK = new Set([
  'den_set_autonomy',
  'den_configure',
  'den_schedule_check',
  'den_schedule_delete',
  'den_remember',
  'den_forget',
  'web_fetch',
])

/** The execution shape `classifyCall` consumes, and the decision its risk implies. */
function classify(name, args = {}) {
  const result = classifyCall({ name, arguments: args })
  const decision = result.risk >= RISK.deny ? 'deny' : result.risk >= RISK.ask ? 'ask' : 'allow'
  return { ...result, decision }
}

function riskOf(name) {
  return classify(name)
}

test('every tool the Host exposes is classified, and none is unknown by accident', () => {
  const unexpected = []
  for (const name of HOST_TOOLS) {
    const classification = riskOf(name)
    if (classification.rule === 'unknown-tool' && !DELIBERATELY_ASK.has(name)) {
      unexpected.push(`${name} (risk ${classification.risk})`)
    }
  }
  assert.deepEqual(
    unexpected,
    [],
    `these tools fall to the fail-closed default without a recorded decision:\n    ${unexpected.join('\n    ')}`,
  )
})

test('the tools that were measured as broken are allowed, so the gate is usable', () => {
  for (const name of ['read', 'write', 'edit', 'grep', 'glob', 'pwsh']) {
    assert.equal(riskOf(name).risk, RISK.allow, `${name} must not stop and ask`)
  }
})

test('the secret-path rule outranks the tool allowlist', () => {
  // This is what makes allowing write/edit safe: the deny is path-based, so it does
  // not depend on the tool name being in a table.
  const path = secretShapedPath()
  for (const tool of ['read', 'write', 'edit']) {
    const denied = classify(tool, { file_path: path })
    assert.equal(denied.risk, RISK.deny, `${tool} on a credential-shaped path must be denied`)
    assert.equal(denied.decision, 'deny')
  }
})

// Assembled rather than written out, for two reasons that both matter: the repository's own
// pre-push scan looks for exactly these shapes and would report this file, and a test file
// full of things that look like live credentials is a trap for whoever reads it next.
const openAiShaped = `sk-${'A'.repeat(4)}${'b'.repeat(20)}`
const gitHubShaped = `ghp_${'a'.repeat(30)}`

test('a credential value aimed at a network tool is caught, and the rule says which shape', () => {
  // `web_search` is `allow`, and the justification for that — written in this file's own
  // header — was that a credential is caught "whichever tool carries it". For this tool the
  // claim was false: the path rules match paths, so a *value* was invisible, and the outbound
  // action rules never ran because a search does not push code anywhere. Measured: pasting a
  // key into a query was allowed, with no decision and no audit line, while the same key
  // carried by a shell command that uploads a body asked and was logged.
  const searched = classify('web_search', { query: `leaked key ${openAiShaped}` })
  assert.equal(searched.decision, 'ask', 'a query carrying a key shape must stop, not run')
  assert.match(searched.rule, /^outbound:secret-value:/, 'the audit line must name the mechanism')
  assert.ok(searched.rule.includes('openai-key'), 'and which family matched')

  const fetched = classify('web_fetch', { url: `https://example.invalid/?k=${gitHubShaped}` })
  assert.equal(fetched.decision, 'ask')
  assert.ok(fetched.rule.includes('github-token'), 'a token in a URL is attributed too')
})

test('an ordinary search is still allowed, because a resident assistant that cannot search is not one', () => {
  // The cheap fix here was to make `web_search` ask like `web_fetch`. That closes the hole by
  // removing the capability, and in a profile with approvals off `ask` is a silent refusal —
  // the pressure that makes a human turn the gate off entirely. So the shape rule asks and
  // ordinary searching is untouched. If this test ever fails, the fix was applied too broadly.
  for (const query of ['weather in Shanghai', 'how do I rotate an API key', 'sk- prefix openai']) {
    assert.equal(classify('web_search', { query }).decision, 'allow', `"${query}" must remain searchable`)
  }
})

test('the value rule is scoped to network payloads, so it never fires on the scanner itself', () => {
  // Applying it to shell text was measured against, not imagined: the pre-push scan in this
  // repository greps for the OpenAI key prefix followed by characters, so a value-shape rule
  // over commands would refuse the scan that exists to find credentials. That is the same
  // mistake as gating a delete rule on the word for deleting. Network tools have no other
  // mechanism; shells have the outbound action rules, which do not misfire on their own text.
  const scanning = classify('pwsh', { command: `git grep -nE "sk-[A-Za-z0-9]{16,}"` })
  assert.equal(scanning.decision, 'allow', 'the credential scanner must be runnable')

  const documenting = classify('edit', { file_path: 'DESIGN.md', old_string: 'a', new_string: 'the gate would push code' })
  assert.equal(documenting.decision, 'allow', 'and documenting a rule is not performing it')
})

test('changing the den\'s own authority is never a plain allow', () => {
  // The whole design rests on this: the assistant cannot grant itself standing
  // autonomy, and a timer or a subagent cannot either.
  for (const name of ['den_set_autonomy', 'den_configure', 'den_schedule_check', 'den_schedule_delete']) {
    assert.notEqual(riskOf(name).risk, RISK.allow, `${name} must not be silently allowed`)
  }
})

test('an unrecognised capability fails closed', () => {
  const unknown = riskOf('some_tool_this_profile_has_never_seen')
  assert.equal(unknown.risk, RISK.ask)
  assert.equal(unknown.rule, 'unknown-tool')
})

test('the gate never returns a decision the host layer cannot act on', () => {
  for (const name of HOST_TOOLS) {
    const classification = riskOf(name)
    assert.ok(
      ['allow', 'ask', 'deny'].includes(classification.decision),
      `${name} produced decision ${JSON.stringify(classification.decision)}`,
    )
  }
})

test('every allowed tool is declared as an allow literal in the gate source', () => {
  // A cheap guard against this audit drifting away from the table it audits.
  const source = readFileSync(join(root, 'src', 'gate.js'), 'utf8')
  const allowed = HOST_TOOLS.filter((name) => riskOf(name).risk === RISK.allow)
  assert.ok(allowed.length > 10, 'the allowlist should be more than a handful of tools')
  for (const name of allowed) {
    assert.ok(
      new RegExp(`\\b${name}:\\s*RISK\\.allow`).test(source),
      `${name} is allowed but is not declared as an allow literal in gate.js`,
    )
  }
})
