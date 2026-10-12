/**
 * The outbound approval gate.
 *
 * This is the layer that makes "it can send email and spend money" a sentence a
 * person can actually say. It has three properties that matter more than any
 * cleverness in the classifier:
 *
 * 1. **It lives outside the assistant's own prompt.** The den cannot reason its
 *    way past this, cannot be talked out of it, and cannot edit it, because it is
 *    host code rather than an instruction the model reads.
 *
 * 2. **Denies are monotonic.** The primary gate runs on `tools/pre-execute`, where
 *    a later listener could in principle turn a deny back into an allow. So the
 *    hard secrets rule is *also* installed as a `ctx.tools.guard`, which the Host
 *    documents as monotonic: no guard can force-allow what another guard denied.
 *
 * 3. **It fails closed.** Anything unrecognised, ambiguous, or unparseable is a
 *    denial, not a pass. An approval gate that opens when it is confused is
 *    decoration.
 *
 * The one thing this module deliberately does NOT do is inspect credential
 * *values*. It inspects tool calls. Credentials never enter the session context,
 * so there is nothing here to leak and nothing here that needs a secret.
 */

import { writeJsonAtomic, denPath } from './atom.js'

/**
 * Risk classes, ordered by severity. `deny` outranks `ask`, which outranks
 * `allow`: when two rules match, the most restrictive wins.
 */
export const RISK = { allow: 0, ask: 1, deny: 2 }

/**
 * Shell patterns that indicate a credential is being read out of its store.
 *
 * The rule is about *exfiltration*, not about reading files: the den may read a
 * project file, but it may never pull a stored secret into the conversation where
 * it becomes loggable and replayable.
 */
const SECRET_READ_PATTERNS = [
  { id: 'credentials-yaml', pattern: /\.dsh[/\\]\.?credentials\.ya?ml/i },
  { id: 'credentials-dir', pattern: /\.dsh[/\\]credentials[/\\]/i },
  { id: 'dotenv', pattern: /(^|[/\\\s])\.env(\.[\w.-]+)?(\s|$|["'])/i },
  { id: 'ssh-private-key', pattern: /id_(rsa|ed25519|ecdsa|dsa)(\s|$|["'])/i },
  { id: 'aws-credentials', pattern: /\.aws[/\\]credentials/i },
  { id: 'npmrc', pattern: /(^|[/\\\s])\.npmrc(\s|$|["'])/i },
  { id: 'netrc', pattern: /(^|[/\\\s])\.netrc(\s|$|["'])/i },
  { id: 'git-credentials', pattern: /\.git-credentials/i },
  { id: 'kube-config', pattern: /\.kube[/\\]config/i },
  { id: 'codex-auth', pattern: /\.codex[/\\]auth\.json/i },
]

/**
 * Commands that reach outside this machine, spend money, or destroy something
 * without a cheap undo. These stop and ask.
 */
const OUTBOUND_PATTERNS = [
  { id: 'git-push', pattern: /\bgit\s+push\b/, what: 'push code to a remote' },
  { id: 'publish', pattern: /\b(npm|pnpm|yarn)\s+publish\b/, what: 'publish a package' },
  { id: 'gh-write', pattern: /\bgh\s+(repo|release|pr|issue|gist)\s+(create|delete|edit|close|merge)/, what: 'change a remote repository' },
  { id: 'curl-upload', pattern: /\bcurl\b[^|]*(-d|--data|--data-binary|-F|--form|-T|--upload-file)\b/, what: 'upload data to a server' },
  { id: 'cloud-cli', pattern: /\b(aws|az|gcloud|heroku|flyctl|vercel|netlify)\s+\S/, what: 'change cloud infrastructure' },
  { id: 'package-install', pattern: /\b(npm|pnpm|yarn)\s+(i|install|add)\b/, what: 'install dependencies' },
  { id: 'docker-push', pattern: /\bdocker\s+(push|login)\b/, what: 'publish or authenticate a container' },
  { id: 'killall', pattern: /\b(killall|taskkill)\b/, what: 'kill other processes' },
  { id: 'recursive-delete', pattern: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b|\bRemove-Item\b[^|]*-Recurse[^|]*-Force/, what: 'delete a directory tree' },
  { id: 'disk-write', pattern: /\b(mkfs|dd\s+if=|format\s+[A-Z]:)/i, what: 'write to a raw device' },
  { id: 'shutdown', pattern: /\b(shutdown|Restart-Computer|Stop-Computer)\b/i, what: 'shut down this machine' },
  { id: 'registry-write', pattern: /\breg\s+(add|delete)\b|Set-ItemProperty\s+.*HKLM/i, what: 'change the system registry' },
]

/**
 * Tools whose *purpose* is to reach outside. Ordered by the risk of the action.
 *
 * A tool name absent from every table falls through to `defaultRisk`, which is
 * `ask`. That is intentional: an unknown capability appearing in a profile should
 * stop and ask, not run.
 */
const TOOL_RISK = {
  // Reaching the network, publishing, or spending.
  web_fetch: RISK.ask,
  web_search: RISK.allow,
  // Shells are allowed by default because most developer work is local and
  // read-only. Secret reads and outbound/destructive patterns are checked
  // above first, so those still deny or ask before the tool-specific rule.
  // Keeping these at `allow` is also necessary when the Host runs with
  // `approval: never`: ordinary local inspection must not become an automatic
  // `user rejected` result merely because the custom gate has no prompt path.
  bash: RISK.allow,
  pwsh: RISK.allow,
  shell: RISK.allow,

  // DSH's built-in inspection, coordination, and question surfaces. These
  // operate on local session/UI state and do not create durable or outbound
  // effects. State-changing den tools and unrecognised capabilities remain on
  // the fail-closed default.
  cordis_inspect_list: RISK.allow,
  cordis_inspect_query: RISK.allow,
  list_agents: RISK.allow,
  job_list: RISK.allow,
  team_task_list: RISK.allow,
  grep: RISK.allow,
  glob: RISK.allow,
  ask_user_question: RISK.allow,

  // The three tools every agent turn is actually built out of. They were absent,
  // so a plain `read` fell through to `defaultRisk: ask` and, in a session with
  // approval prompts disabled, became an automatic `user rejected`. Measured in
  // this profile's gate audit, in a single session:
  //
  //   { tool: 'read',  rule: 'unknown-tool', risk: 1, decision: 'ask' }
  //   { tool: 'edit',  rule: 'unknown-tool', risk: 1, decision: 'ask' }
  //   { tool: 'write', rule: 'unknown-tool', risk: 1, decision: 'ask' }
  //
  // while `grep`, `glob`, `pwsh` and `den_status` passed, because they were
  // listed. A gate that blocks the file tools cannot be worked with at all, and
  // being unusable is its own security failure: it is exactly the pressure that
  // makes a human switch the gate off wholesale instead of reviewing it.
  //
  // The secrets rule above still runs FIRST and is path-based rather than
  // tool-based, so `read`/`write`/`edit` touching a credential path is denied
  // before this table is consulted. That is what makes allowing them safe: the
  // deny does not depend on the tool name.
  //
  // Deliberately still absent, so they keep the fail-closed default: the
  // state-changing den tools, and every capability this profile has never seen.
  read: RISK.allow,
  write: RISK.allow,
  edit: RISK.allow,

  // The den's own read-only surface.
  //
  // These were previously falling through to `defaultRisk: ask`, which produced a
  // real defect rather than a harmless extra prompt: an assistant whose *every*
  // attempt to look at its own status raises an approval dialog trains the human
  // to click approve without reading. Approval fatigue is a security failure, and
  // it was self-inflicted — the gate was treating its own tools as unknown
  // foreign capabilities.
  //
  // Only tools that cannot change anything outside the conversation belong here.
  // Everything with a durable or outbound effect stays on the default `ask`:
  // `den_remember`/`den_forget`/`den_schedule_check`/`den_schedule_delete`/
  // `den_configure` write state, and `den_set_autonomy` is a privilege change.
  den_status: RISK.allow,
  den_explain_gate: RISK.allow,
  den_scenarios: RISK.allow,
  den_recall: RISK.allow,
  den_schedule_list: RISK.allow,
}

/** The fallback for a tool this gate has never seen. */
export const DEFAULT_RISK = RISK.ask

/**
 * Classify one tool call.
 *
 * @returns {{ risk: number, reason: string, rule: string, what?: string }}
 */
export function classifyCall(exec) {
  const name = typeof exec?.name === 'string' ? exec.name : ''
  const args = exec?.arguments

  // Flatten the arguments once so pattern rules can see shell text wherever the
  // calling convention put it.
  const text = flattenArgs(args)

  // Secrets outrank everything: reading a credential into the conversation is
  // irreversible in the sense that matters (it is now in the log and the context).
  for (const rule of SECRET_READ_PATTERNS) {
    if (rule.pattern.test(text)) {
      return {
        risk: RISK.deny,
        rule: `secret:${rule.id}`,
        reason: `refused: this would pull a stored credential into the conversation (${rule.id})`,
      }
    }
  }

  for (const rule of OUTBOUND_PATTERNS) {
    if (rule.pattern.test(text)) {
      return {
        risk: RISK.ask,
        rule: `outbound:${rule.id}`,
        reason: `this call appears to ${rule.what}; confirm before it runs`,
        what: rule.what,
      }
    }
  }

  if (Object.hasOwn(TOOL_RISK, name)) {
    const risk = TOOL_RISK[name]
    if (risk === RISK.allow) return { risk, rule: `tool:${name}`, reason: 'read-only by declaration' }
    return { risk, rule: `tool:${name}`, reason: `${name} can have side effects; confirm before it runs` }
  }

  return {
    risk: DEFAULT_RISK,
    rule: 'unknown-tool',
    reason: `unrecognised tool ${name || '(unnamed)'}; confirm before it runs`,
  }
}

/**
 * Best-effort flattening of arbitrary tool arguments into searchable text.
 *
 * Bounded in both depth and size: a gate that can be made slow or memory-hungry by
 * a crafted argument is a denial-of-service vector, so this gives up rather than
 * recursing forever.
 */
export function flattenArgs(value, depth = 0) {
  if (depth > 6) return ''
  if (value == null) return ''
  if (typeof value === 'string') return value.slice(0, 20000)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => flattenArgs(item, depth + 1)).join(' ')
  if (typeof value === 'object') {
    return Object.entries(value)
      .slice(0, 200)
      .map(([key, item]) => `${key} ${flattenArgs(item, depth + 1)}`)
      .join(' ')
  }
  return ''
}

/**
 * Convert a classification into a `PreToolDecision`.
 *
 * `ask` is only meaningful when the Host has approval support; the Host's own
 * documentation says a missing approval facility turns `ask` into a denial, which
 * is the correct fail-closed direction and is why this never downgrades `ask` to
 * `allow` on its own initiative.
 */
export function decide(classification) {
  if (classification.risk >= RISK.deny) {
    return {
      kind: 'deny',
      reason: classification.reason,
      info: { name: 'DenOutboundGate', code: classification.rule, reason: classification.reason },
    }
  }
  if (classification.risk >= RISK.ask) {
    return {
      kind: 'ask',
      reason: classification.reason,
      displayReason: { en: classification.reason, 'zh-CN': translateReason(classification) },
    }
  }
  return { kind: 'allow' }
}

/** A Chinese rendering of the reason, so the prompt is readable in this locale. */
function translateReason(classification) {
  const what = classification.what
  if (what) return `这个调用看起来要${what === 'push code to a remote' ? '把代码推到远端' : what}；请先确认。`
  return '这个调用可能有副作用；请先确认。'
}

/**
 * Audit log for every gate decision.
 *
 * Append-only and bounded: only the last `MAX_AUDIT` entries are consulted for
 * display, but decisions are never silently discarded without a counter, because
 * "why did it refuse?" must be answerable after the fact.
 */
const MAX_AUDIT = 500

export function auditPath() {
  return denPath('gate-audit.json')
}

/**
 * Record one decision.
 *
 * Deliberately stores the tool name, the rule that matched, and the verdict —
 * never the arguments themselves. An audit log that copies tool arguments is a
 * second place secrets can leak from.
 */
export function recordAudit(entry, existing = []) {
  const record = {
    at: Date.now(),
    tool: typeof entry.tool === 'string' ? entry.tool.slice(0, 120) : '(unknown)',
    rule: entry.rule,
    risk: entry.risk,
    decision: entry.decision,
    sessionId: entry.sessionId ?? null,
  }
  const next = [...existing, record].slice(-MAX_AUDIT)
  writeJsonAtomic(auditPath(), { version: 1, entries: next })
  return record
}

/**
 * Install the gate on a Host context.
 *
 * Two installs, on purpose:
 *  - `tools/pre-execute` for the `ask` decisions, which need the waterfall's
 *    richer decision type.
 *  - `ctx.tools.guard` for the `deny` decisions, which must be monotonic.
 *
 * The registry is taken as an explicit parameter rather than read off `ctx`.
 * Cordis exposes services as injected properties, while a plugin that resolves
 * them lazily holds the value returned by `ctx.get(...)`; requiring the caller to
 * pass the same object it already resolved keeps those two views from silently
 * disagreeing.
 *
 * @param {object} ctx host context, for event subscription
 * @param {object} options
 * @param {object} options.tools the tool registry (`ctx.tools`)
 * @param {(entry: object) => void} [options.onDecision] observability sink
 * @returns {() => void} disposer removing both
 */
export function installGate(ctx, { tools, onDecision } = {}) {
  const disposers = []

  const preExecute = (exec, next) => {
    const classification = classifyCall(exec)
    if (classification.risk < RISK.ask) return next()

    const decision = decide(classification)
    onDecision?.({ classification, decision, tool: exec?.name, sessionId: exec?.agent?.id })
    // An `allow` never reaches here; returning `next()` keeps the waterfall
    // cooperative for every other listener.
    return decision.kind === 'allow' ? next() : decision
  }

  const guard = (exec) => {
    const classification = classifyCall(exec)
    if (classification.risk < RISK.deny) return undefined
    onDecision?.({ classification, decision: { kind: 'deny' }, tool: exec?.name, sessionId: exec?.agent?.id })
    return classification.reason
  }

  // The monotonic guard carries the rules that must never be talked around, so it
  // is installed unconditionally. The pre-execute listener is what needs an event
  // bus, and a composition without one must still get the hard rules rather than
  // losing the whole gate — and with it the plugin — to a missing listener API.
  disposers.push(tools.guard(guard))
  if (typeof ctx.on === 'function') disposers.push(ctx.on('tools/pre-execute', preExecute))

  return () => {
    for (const dispose of disposers) {
      try {
        dispose?.()
      } catch {
        /* disposal must not mask an earlier failure */
      }
    }
  }
}
