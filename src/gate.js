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
  /**
   * The store names below were found by listing the credential stores **this machine
   * actually has** — including the ones the user's own home-level instructions enumerate —
   * and asking the gate about each one. Measured before they were added: all five existed,
   * and `read` was **allowed** on every one of them, while two rules guarded paths that do
   * not exist here at all.
   *
   * That is the failure mode this list had: it was written from what credential files
   * generally look like, never audited against what is on the disk. A table built from
   * recollection protects the recollection. `test/gate-coverage.test.mjs` now asserts the
   * stores that exist, so one appearing later fails a test instead of going unnoticed.
   */
  { id: 'codex-sandbox-secrets', pattern: /\.codex[/\\]\.sandbox-secrets/i },
  // This file carries the user's own rule set and, per their home instructions, a live token
  // inside it. Reading it to understand one's own constraints is a real want and it is still
  // refused: the token comes with it, and the human can read their own file.
  { id: 'codex-rules-embedded-token', pattern: /\.codex[/\\]rules[/\\]default\.rules/i },
  { id: 'tokenrouter-config', pattern: /tokenrouter\.config\.toml/i },
  { id: 'kimi-code-credentials', pattern: /\.kimi-code[/\\]credential/i },
  { id: 'container-registry-auth', pattern: /\.docker[/\\]config\.json/i },
  /**
   * Two locations, and only one of them is on this machine — which is the point.
   *
   * The first form is what `gh` uses on POSIX and it does **not** exist here; the second is
   * `%APPDATA%\\GitHub CLI\\hosts.yml`, which does, and which a rule written from recollection
   * would have missed. Measured, after the recollection-shaped rule was already written once.
   */
  { id: 'gh-cli-hosts', pattern: /(\.config[/\\]gh[/\\]hosts\.ya?ml|GitHub CLI[/\\]hosts\.ya?ml)/i },
]

/**
 * Credential *values*, as opposed to the paths that hold them.
 *
 * A deliberately small set: prefixes specific enough to be worth acting on, common enough to
 * matter. A match **asks** rather than denies, because a shape is weaker evidence than a
 * filename — `id_rsa` names a key, while `sk-` followed by thirty characters only looks like
 * one, and a person may legitimately be searching for documentation about keys. The reason
 * carries which family matched, so that difference is visible where the decision is made.
 *
 * This closes the reflexive path — a model pasting a key into a search query — and leaves a
 * line in the audit either way. It does not stop an obfuscated secret, and nothing here
 * claims it does; see DESIGN 2.14.
 */
const SECRET_VALUE_PATTERNS = [
  { id: 'openai-key', pattern: /\bsk-[A-Za-z0-9_-]{16,}/, what: 'send an API key' },
  { id: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/, what: 'send a repository token' },
  { id: 'slack-token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/, what: 'send a workspace token' },
  { id: 'aws-key-id', pattern: /\bAKIA[0-9A-Z]{16}\b/, what: 'send a cloud access key id' },
  { id: 'google-key', pattern: /\bAIza[0-9A-Za-z_-]{30,}/, what: 'send an API key' },
  { id: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: 'send a private key' },
]

/**
 * The verbs that reach another host, recognised by **what they are aimed at**.
 *
 * A bare word is not enough: `ssh`, `scp` and `ftp` are ordinary words too, and this project has
 * already refused its own documentation twice for naming a rule's own text.
 *
 * Position is not enough either, and the reason is worth keeping: `flattenArgs` prefixes every
 * argument with its key, so the text a rule sees for a shell call begins `command …` and never
 * begins with the command. An anchored rule matches nothing in production while passing any
 * test that feeds the pattern directly — which is exactly how the first version of this was
 * written and "verified". So these require a remote-looking operand: a `user@host`, a
 * `host:path`, or a dotted hostname.
 */
function aimedAtRemote(verbs) {
  return new RegExp(
    `(?:^|[\\s;&|])(?:${verbs})\\s[^|]*(?:\\S+@\\S+|[A-Za-z0-9._-]+:\\S+|[A-Za-z0-9.-]+\\.[A-Za-z]{2,})`,
    'i',
  )
}

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

  /**
   * The platform the author was imagining, versus the platform this runs on.
   *
   * Everything above is shaped like a Unix CLI tool. This plugin ships to Windows and its shell
   * is PowerShell, where the reflex for "send this somewhere" is a cmdlet — and not one of them
   * was covered. Measured before these were added: twelve distinct ways to move data off this
   * machine, every one of them `allow`, while the same intent through `curl` asked. The control
   * case (`Get-ChildItem`) was also allowed, so the classifier was working; the table was simply
   * written for somewhere else.
   */
  { id: 'ps-web-send', pattern: /\b(Invoke-RestMethod|Invoke-WebRequest|irm|iwr|wget)\b[^|]*(\s-Method\s+(POST|PUT|PATCH|DELETE)\b|-InFile\b|-BodyInFile\b|-Body\b|--post-data|--post-file)/i, what: 'send data to a web server' },
  { id: 'ps-download', pattern: /\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm|wget)\b[^|]*-OutFile\b|\bcertutil\b[^|]*-urlcache/i, what: 'download a payload from a server' },
  { id: 'ps-bits-upload', pattern: /\bStart-BitsTransfer\b[^|]*-TransferType\s+Upload/i, what: 'upload a file to a server' },
  { id: 'dotnet-webclient', pattern: /New-Object\s+Net\.Web(Client|Request)\b|\.(UploadFile|UploadData|UploadString|UploadValues|DownloadFile|DownloadString)\s*\(/i, what: 'move a file over the network from a script' },
  { id: 'ps-mail', pattern: /\bSend-MailMessage\b/i, what: 'send mail outside this machine' },
  { id: 'ps-remoting', pattern: /\bInvoke-Command\b[^|]*-ComputerName\b/i, what: 'run a command on another host' },
  { id: 'remote-transfer', pattern: aimedAtRemote('scp|sftp|rsync|ftp'), what: 'reach another host' },
  { id: 'remote-shell', pattern: aimedAtRemote('ssh|telnet'), what: 'run a command on another host' },
  { id: 'netcat', pattern: /(?:^|[\s;&|])(?:nc|ncat|netcat)\s+\S+\s+\d+/i, what: 'open a raw connection to another host' },
]

/**
 * The tools whose arguments are a command line the Host will actually execute.
 *
 * The outbound rules describe **actions** — uploading, publishing, deleting a tree. A tool that
 * executes nothing cannot take the action, so applying these rules to its arguments accuses it
 * of something it cannot do: an `edit` writing a file that *documents* a rule was refused for
 * containing the rule's own text, and `den_explain_gate`, the read-only tool whose job is to
 * answer what the gate would do, could not be asked about the gate. That is not strictness, it
 * is the wrong category. See DESIGN 2.13.
 *
 * Safety is unchanged: every way to actually run a command goes through one of these tools, and
 * they are still scanned in full. Writing a dangerous script has no effect by itself; running it
 * is still caught. Anything this list does not recognise falls through to the fail-closed
 * default, so an unknown execution surface still asks.
 */
const EXECUTING_TOOLS = new Set(['bash', 'pwsh', 'shell'])

/**
 * The tools whose *arguments are the payload* and leave this machine.
 *
 * `web_search` is `allow`, and that stays: a resident assistant that cannot search is less
 * useful, and `ask` in a profile with approvals off is a silent refusal rather than a
 * question. But that decision rested on a claim written into
 * `test/gate-coverage.test.mjs` — that a credential is caught "whichever tool carries it" —
 * and for this tool the claim was false. The path rules match *paths* (`.env`, `id_rsa`), so
 * a credential *value* was invisible to them; the outbound action rules never ran, because a
 * search does not push code to a remote. The reflexive path — paste the key into a query —
 * therefore had neither a decision nor a trace, while the same key carried by a shell command
 * that uploads a body asked and was logged.
 *
 * Scoped to these tools and deliberately not to shell text. A value-shape rule applied to
 * commands would fire on the text of the scanner itself: this repository's own pre-push scan
 * greps for the OpenAI key prefix followed by characters, which is precisely the shape being
 * looked for. That is the same mistake as gating a delete rule on the word for deleting,
 * which was measured here once already.
 */
const NETWORK_PAYLOAD_TOOLS = new Set(['web_search', 'web_fetch'])

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

  // The den's own tools are not in this table at all: they are declared in
  // `OWNED_TOOLS`, one reason each, because "allowed" and "read-only" stopped being
  // the same claim. The read-only ones were listed here first, and the reason they
  // were listed is the reason the rest followed —
  //
  //   an assistant whose *every* attempt to look at its own status raises an approval
  //   dialog trains the human to click approve without reading. Approval fatigue is a
  //   security failure, and it was self-inflicted — the gate was treating its own
  //   tools as unknown foreign capabilities.
  //
  // Measured on 2026-10-13, that treatment applied to the den's *durable* tools meant
  // they never happened at all. The profile's `defaultPreset: danger-full-access`
  // implies `approval: never` (DESIGN §2.28), so `ask` is not "a human will decide
  // later" but "this never runs", and it is rendered as a refusal by nobody:
  //
  //   den_remember     -> Error: the user rejected tool "den_remember"
  //   den_set_autonomy -> Error: the user rejected tool "den_set_autonomy"
  //
  // The plugin's memory, its self-checks and its authority were all unreachable on
  // the configuration it ships to. See DESIGN §2.29.

  // The rest of this profile's tool surface, classified by the same rule the block
  // above states: reading and local bookkeeping are allowed, and anything with a
  // durable or outbound effect is not.
  //
  // Measured against the Host's own tool list, 17 exposed tools were landing on
  // `defaultRisk: ask` with no recorded decision. In a session with approval prompts
  // disabled that made `skill`, `create_goal`, `todo_write`, `wait_agent`,
  // `spawn_teammate` and `subagent` fail with `user rejected` — the same
  // self-inflicted approval fatigue the file tools produced, and for the same
  // reason: the gate was treating the profile's own vocabulary as foreign.
  //
  // Allowed: reads, and bookkeeping that only affects this conversation's own
  // working state.
  read_image: RISK.allow,
  job_output: RISK.allow,
  get_goal: RISK.allow,
  create_goal: RISK.allow,
  update_goal: RISK.allow,
  todo_write: RISK.allow,
  skill: RISK.allow,
  present: RISK.allow,
  team_task_get: RISK.allow,
  // Delegation and coordination are local: they start work inside this host and
  // cannot send, spend, or publish on their own. Whatever the delegate then
  // attempts passes through this same gate, so allowing the spawn does not
  // pre-authorise the effect.
  send_message: RISK.allow,
  spawn_teammate: RISK.allow,
  subagent: RISK.allow,
  subagent_fork: RISK.allow,
  wait_agent: RISK.allow,
  interrupt_agent: RISK.allow,
  team_task_create: RISK.allow,
  team_task_update: RISK.allow,
  job_kill: RISK.allow,
  load_workspace_dependencies: RISK.allow,
  exit_plan_mode: RISK.allow,
  vision_diff: RISK.allow,
  // These two orchestrate work rather than perform it. `workflow` runs subagents,
  // and `ship_receipt` runs commands the caller supplies — but neither adds a
  // capability this gate does not already see in its own right: the subagents'
  // tool calls and the supplied commands both pass through here. So they are
  // classified like the shell, not privileged above it.
  workflow: RISK.allow,
  ship_receipt: RISK.allow,

  // Deliberately still absent, and therefore still `ask`: none. Every tool the host
  // reported is now classified explicitly, so a tool appearing in a future profile
  // is a new decision rather than an accident. `test/gate-coverage.test.mjs` fails
  // if one appears without one.
}

/** The fallback for a tool this gate has never seen. */
export const DEFAULT_RISK = RISK.ask

/**
 * The tools this plugin owns, and what bounds each one.
 *
 * A gate that exists to watch *outbound* effects has no business asking a human to approve
 * the assistant remembering a fact — but that is not why these are here. The reason is that
 * they were being treated as unrecognised: `den_remember` reached the fail-closed default,
 * which under `approval: never` is not a prompt but a silent, permanent refusal that names
 * a rejecting human who never existed. An assistant that cannot remember, cannot schedule,
 * and cannot be authorized is not a safer assistant; it is a broken one, and being unusable
 * is the pressure that gets a gate switched off wholesale rather than reviewed.
 *
 * What makes each entry safe is not that den wrote it. It is that the effect is bounded
 * inside the tool, and the bound is stated here so a reader can check it rather than trust
 * the name:
 *
 *   - the authority tool refuses unless the panel minted a request *and* a human message
 *     quotes its token, verified against the immutable session log (`setGrant`), so this
 *     entry grants the model nothing it could not already do alone;
 *   - a stored self-check cannot act until a human has granted standing autonomy, so
 *     scheduling is not doing;
 *   - memory is scenario-scoped and local, readable back through the panel;
 *   - pacing changes the den's own cadence and nothing else.
 *
 * The rules above this table still run first and do not care about the tool's name: a
 * credential-shaped path or a secret-shaped value inside a den tool's arguments is still
 * denied, and the shell and network rules are untouched. `test/gate-coverage.test.mjs`
 * asserts that, and asserts this map covers every tool the plugin registers, so a new tool
 * cannot join the surface by falling through.
 */
export const OWNED_TOOLS = {
  den_status: "reports the den's own state and changes nothing",
  den_explain_gate: 'reports what the gate would decide and changes nothing',
  den_scenarios: "lists the den's own memory scenarios and changes nothing",
  den_recall: "reads the den's own scenario-scoped memory and changes nothing",
  den_schedule_list: "lists the den's own self-checks and changes nothing",
  den_schedule_delete: 'removes one self-check, which can only reduce what the den would do',
  den_remember: "writes one entry into the den's own scenario-scoped memory, which the panel reads back",
  den_forget: 'deletes one entry the den itself stored, in one scenario',
  den_schedule_check:
    'stores a self-check that cannot act until a human grants standing autonomy, so scheduling is not doing',
  den_configure: "changes the den's own pacing — daily budget, quiet hours, cadence — and nothing else",
  den_set_autonomy:
    'changes authority, and refuses unless the panel minted a request and a human message quotes its token',
}

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

  // Tools whose arguments are the payload and leave this machine. There is no other
  // mechanism for these: the path rules cannot see a value, and the action rules below
  // describe actions a search cannot take. See NETWORK_PAYLOAD_TOOLS.
  if (NETWORK_PAYLOAD_TOOLS.has(name)) {
    for (const rule of SECRET_VALUE_PATTERNS) {
      if (rule.pattern.test(text)) {
        return {
          risk: RISK.ask,
          rule: `outbound:secret-value:${rule.id}`,
          what: rule.what,
          reason: `this sends something shaped like a credential (${rule.id}) to a third party; confirm before it runs`,
        }
      }
    }
  }

  // Only where the arguments are a command line that runs. See EXECUTING_TOOLS.
  if (EXECUTING_TOOLS.has(name)) {
    for (const rule of OUTBOUND_PATTERNS) {
      if (rule.pattern.test(text)) {
        const destination = destinationOf(text)
        return {
          risk: RISK.ask,
          rule: `outbound:${rule.id}`,
          reason: destination
            ? `this call appears to ${rule.what} (destination ${destination}); confirm before it runs`
            : `this call appears to ${rule.what}; confirm before it runs`,
          what: rule.what,
          destination,
        }
      }
    }
  }

  if (Object.hasOwn(OWNED_TOOLS, name)) {
    return { risk: RISK.allow, rule: `owned:${name}`, reason: OWNED_TOOLS[name] }
  }

  if (Object.hasOwn(TOOL_RISK, name)) {
    const risk = TOOL_RISK[name]
    if (risk === RISK.allow) return { risk, rule: `tool:${name}`, reason: 'read-only by declaration' }
    // A tool-level rule knows *which tool* and nothing about *where the call goes*, and the
    // person answering the prompt is the one who has to decide. The outbound rules were
    // already taught to name the destination; this branch was not, so `web_fetch` against a
    // loopback address and `web_fetch` against a stranger produced the same sentence. Naming
    // the target adds information without moving the risk, which stays with the human.
    const destination = destinationOf(text)
    return {
      risk,
      rule: `tool:${name}`,
      reason: destination
        ? `${name} can have side effects and would reach ${destination}; confirm before it runs`
        : `${name} can have side effects; confirm before it runs`,
      destination,
    }
  }

  return {
    risk: DEFAULT_RISK,
    rule: 'unknown-tool',
    reason: `unrecognised tool ${name || '(unnamed)'}; confirm before it runs`,
  }
}

/**
 * The host a command is aimed at, when the command names one.
 *
 * "upload data to a server" is true both of an HTTP POST carrying a body to a public host
 * and of the same POST aimed at 127.0.0.1, and those are different propositions: the second
 * cannot leave this machine. The rule deliberately fires on both — a loopback service can
 * relay, so it is not automatically safe — but a reader deciding whether to approve should
 * not have to guess which one they are looking at. Naming the destination adds information
 * without moving the risk; the decision still belongs to the human.
 */
function destinationOf(text) {
  const match = String(text ?? '').match(/https?:\/\/([^\s/"'`)]+)/i)
  return match ? match[1] : ''
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
  const destination = classification.destination
  if (what) {
    const target = destination ? `（目标 ${destination}）` : ''
    return `这个调用看起来要${what === 'push code to a remote' ? '把代码推到远端' : what}${target}；请先确认。`
  }
  // No `what` means the rule matched the tool rather than a pattern in a command line. The
  // destination is computed centrally and must survive this branch too, or the translated
  // prompt is strictly less informative than the English one it sits beside.
  if (destination) return `这个调用可能有副作用，目标是 ${destination}；请先确认。`
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
 * Deliberately stores the tool name, the rule that matched, the destination when the call
 * named one, and the verdict — never the arguments themselves. An audit log that copies tool
 * arguments is a second place secrets can leak from.
 */
export function recordAudit(entry, existing = []) {
  const record = {
    at: Date.now(),
    tool: typeof entry.tool === 'string' ? entry.tool.slice(0, 120) : '(unknown)',
    rule: entry.rule,
    risk: entry.risk,
    decision: entry.decision,
    sessionId: entry.sessionId ?? null,
    // The rule says why, this says where. Without it the durable answer to "why was this
    // refused?" cannot tell a fetch of the local GUI from a fetch of a stranger — the same
    // information gap the prompt had, one layer further out, in the surface that outlives
    // the process. It is a derived host and port, not the arguments, and it is bounded.
    destination: typeof entry.destination === 'string' ? entry.destination.slice(0, 200) : '',
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
