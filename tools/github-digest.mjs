/**
 * github-digest — a read-only digest of the GitHub work waiting on the human.
 *
 * Why the allowlist is the whole point of this file: den's boundary is "read
 * everything, draft everything, never perform the act". A boundary that lives in
 * a comment is not a boundary, so gh arguments are never built inline. The tool
 * asks `planCommands` for a fixed set, and `runPlannedCommand` refuses to execute
 * anything `isReadOnlyCommand` rejects. There is no code path here that can
 * comment, review, merge, close, edit or push; the drafts it renders are text on
 * stdout, and nothing in this file transmits them anywhere.
 *
 * The parser/renderer half is exported as pure functions so tests can feed it fake
 * gh output without a network, an account, or the gh binary.
 */

import { execFile } from 'node:child_process'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

/** Printed verbatim wherever a draft appears, so no reader can mistake it for a sent reply. */
export const DRAFT_LABEL = '草稿，未发送'

export const DEFAULT_LIMIT = 20

/** The three buckets the human asked for, in the order they should read them. */
export const SECTIONS = [
  { key: 'reply', title: '等你回的' },
  { key: 'review', title: '等你审的' },
  { key: 'mine', title: '你自己的' },
]

const PR_FIELDS = 'number,title,repository,updatedAt,author,url,isDraft,state'
const ISSUE_FIELDS = 'number,title,repository,updatedAt,author,url,state'

/**
 * One jq projection instead of the raw notifications payload: every notification
 * carries a whole repository object, so the unfiltered response is roughly fifty
 * times larger than the seven fields the digest actually reads.
 */
const NOTIFICATIONS_JQ =
  'map({id, reason, unread, updatedAt: .updated_at, title: .subject.title, type: .subject.type, url: .subject.url, repo: .repository.full_name})'

/**
 * `gh` flags that turn a read into a write. Checked against every planned command
 * rather than trusted, because one prefix match is what separates a digest from a
 * bot that posts.
 */
const GH_WRITE_FLAGS = new Set(['-X', '--method', '-f', '--field', '-F', '--raw-field', '--input'])

const WRITE_VERBS =
  'comment|review|merge|close|reopen|edit|create|delete|push|sync|approve|revert|transfer|rename|lock|unlock|archive|upload|release'

/**
 * Command-shaped strings that must never appear in this tool's output. Matched
 * against rendered output as a last line of defence: if a future edit ever made
 * this file emit a posting command, the run fails instead of printing it. These
 * match command syntax only — the Chinese notice "草稿，未发送" is not a command
 * and must not be flagged, or the guard would be useless.
 */
export const FORBIDDEN_OUTPUT_PATTERNS = [
  new RegExp(`\\bgh\\s+(?:pr|issue|repo|release|label|gist)\\b[^\\n]*\\b(?:${WRITE_VERBS})\\b`, 'i'),
  new RegExp(`\\bgh\\s+api\\b[^\\n]*(?:--method|-X|--field|--raw-field|--input)`, 'i'),
  /\bgit\s+push\b/i,
  /\bcurl\b[^\n]*-X\s*(?:POST|PUT|PATCH|DELETE)/i,
]

const MISSING_GH_HINT =
  '找不到 gh 命令:gh CLI 没有安装,或者不在 PATH 里。补救:安装 GitHub CLI(https://cli.github.com),Windows 上可以 winget install GitHub.cli,装完重开终端再跑一次。'

const UNAUTHENTICATED_HINT =
  'gh 当前没有登录,读不到任何数据。补救:运行 gh auth login 完成登录(需要 repo scope 才能读 PR 和 issue);只想补权限的话用 gh auth refresh -s repo。'

const USAGE = `github-digest —— 只读的 GitHub 工作摘要

用法:
  node tools/github-digest.mjs [--json] [--limit <n>] [--repo <owner/name>]

参数:
  --json               只往 stdout 输出 JSON(给程序消费,stdout 里没有别的内容)
  --limit <n>          每个分区的最大条数,默认 ${DEFAULT_LIMIT},范围 1..1000
  --repo <owner/name>  只汇总指定仓库
  -h, --help           显示这段用法

退出码:
  0  成功(允许未读通知等单个数据源降级)
  2  gh 不存在或未登录
  1  其他失败(例如所有查询都失败)

边界:本工具只读 —— 只汇总信息、只起草回复,绝不评论、绝不改 issue、绝不推送、绝不发任何东西。`

// ---------------------------------------------------------------------------
// gh command plan
// ---------------------------------------------------------------------------

/**
 * The complete set of gh invocations this tool can ever make. Fixed and small on
 * purpose: a reviewer can read this one function and know the tool's entire reach.
 */
export function planCommands({ limit = DEFAULT_LIMIT, repo = '' } = {}) {
  const scope = repo ? ['--repo', repo] : []
  const search = (kind, ...extra) => [
    'search',
    kind,
    ...extra,
    '--state',
    'open',
    '--limit',
    String(limit),
    '--json',
    kind === 'prs' ? PR_FIELDS : ISSUE_FIELDS,
    ...scope,
  ]
  return [
    { key: 'auth', args: ['auth', 'status'] },
    { key: 'reviewRequested', args: search('prs', '--review-requested', '@me') },
    { key: 'myPulls', args: search('prs', '--author', '@me') },
    { key: 'assignedIssues', args: search('issues', '--assignee', '@me') },
    { key: 'mentionedIssues', args: search('issues', '--mentions', '@me') },
    // No repository filter exists for notifications, so that one is filtered
    // client-side in buildDigest instead of being silently ignored.
    { key: 'notifications', args: ['api', `notifications?per_page=${limit}`, '--jq', NOTIFICATIONS_JQ] },
  ]
}

/** True only for the read-only shapes above; every other gh invocation is refused. */
export function isReadOnlyCommand(args) {
  if (!Array.isArray(args) || args.length === 0) return false
  // A write flag anywhere makes the call a write, whatever the subcommand says.
  if (args.some((arg) => typeof arg === 'string' && (GH_WRITE_FLAGS.has(arg) || arg.startsWith('--method=')))) {
    return false
  }
  const [head, second] = args
  if (head === 'auth') return second === 'status'
  if (head === 'search') return second === 'prs' || second === 'issues'
  if (head === 'api') return typeof second === 'string' && /^notifications(\?|$)/.test(second)
  return false
}

/** Whether rendered output contains a posting command. Used as a pre-print guard. */
export function containsWriteCommand(text) {
  const haystack = String(text ?? '')
  return FORBIDDEN_OUTPUT_PATTERNS.some((pattern) => pattern.test(haystack))
}

/**
 * Runs one planned command, refusing anything off the allowlist. The refusal is
 * the enforcement: it does not depend on the caller having remembered the rule.
 */
export async function runPlannedCommand(entry, exec = ghExec) {
  const args = entry?.args ?? []
  if (!isReadOnlyCommand(args)) {
    return {
      ok: false,
      code: 1,
      refused: true,
      stdout: '',
      stderr: `拒绝执行非只读命令:gh ${args.join(' ')}`,
    }
  }
  return exec(args)
}

/** The real gh runner: argument array, never a shell string, so nothing can be injected. */
export function ghExec(args) {
  return new Promise((resolve) => {
    execFile('gh', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error?.code ?? 0,
        missing: error?.code === 'ENOENT',
        stdout: stdout ?? '',
        stderr: stderr ?? '',
      })
    })
  })
}

/**
 * "gh is not installed" is read off the error code as well as the flag, because the
 * exit-2 remedy must not depend on an injected runner having set that flag.
 */
export function isMissingGh(result) {
  return result?.missing === true || result?.code === 'ENOENT'
}

// ---------------------------------------------------------------------------
// small pure helpers
// ---------------------------------------------------------------------------

const text = (value) => (typeof value === 'string' ? value.trim() : '')

const numberOrNull = (value) => (Number.isInteger(value) ? value : null)

const firstLine = (value) => {
  const line = String(value ?? '')
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0)
  return line ?? ''
}

/** A stable dedup key. Notifications lack `number` for some subject types, hence the fallback. */
export function itemId(repo, number) {
  return repo && Number.isInteger(number) ? `${repo}#${number}` : ''
}

const isoOrNull = (value) => (Number.isFinite(Date.parse(value ?? '')) ? String(value) : null)

const loginOf = (author) => {
  if (typeof author === 'string') return author
  return text(author?.login ?? author?.name) || null
}

const repoNameOf = (raw) =>
  text(raw?.repository?.nameWithOwner ?? raw?.repository?.full_name ?? raw?.repo ?? raw?.nameWithOwner)

/** UTC on purpose: a digest that shifts by timezone is a digest two people disagree about. */
export function formatTimestamp(iso) {
  const parsed = Date.parse(iso ?? '')
  if (!Number.isFinite(parsed)) return '未知'
  const date = new Date(parsed)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
}

export function updatedValue(item) {
  const parsed = Date.parse(item?.updatedAt ?? '')
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
}

/** Newest first; items with no usable timestamp sink to the bottom, ties broken by id for stability. */
export function sortByUpdatedDesc(items = []) {
  return [...items].sort(
    (a, b) => updatedValue(b) - updatedValue(a) || String(a?.id ?? '').localeCompare(String(b?.id ?? '')),
  )
}

export function truncate(items = [], limit = DEFAULT_LIMIT) {
  const size = Number.isInteger(limit) && limit >= 0 ? limit : DEFAULT_LIMIT
  return items.slice(0, size)
}

/** The notifications API hands back api.github.com URLs; a human wants the web URL. */
export function apiUrlToHtml(url) {
  const raw = text(url)
  const match = /^https?:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/([a-z_]+)\/(.+)$/.exec(raw)
  if (!match) return ''
  const [, owner, repo, kind, rest] = match
  const path = kind === 'pulls' ? 'pull' : kind === 'commits' ? 'commit' : kind
  return `https://github.com/${owner}/${repo}/${path}/${rest}`
}

// ---------------------------------------------------------------------------
// normalisation
// ---------------------------------------------------------------------------

export function normalizePullRequest(raw, { bucket = 'mine', reason = '' } = {}) {
  const repo = repoNameOf(raw)
  const number = numberOrNull(raw?.number)
  return {
    kind: 'pr',
    bucket,
    number,
    title: text(raw?.title) || '(无标题)',
    repo,
    updatedAt: isoOrNull(raw?.updatedAt ?? raw?.updated_at),
    author: loginOf(raw?.author),
    url: text(raw?.url),
    draft: raw?.isDraft === true,
    id: itemId(repo, number) || `pr:${text(raw?.title)}`,
    reason,
  }
}

export function normalizeIssue(raw, { bucket = 'reply', reason = '' } = {}) {
  const repo = repoNameOf(raw)
  const number = numberOrNull(raw?.number)
  return {
    kind: 'issue',
    bucket,
    number,
    title: text(raw?.title) || '(无标题)',
    repo,
    updatedAt: isoOrNull(raw?.updatedAt ?? raw?.updated_at),
    author: loginOf(raw?.author),
    url: text(raw?.url),
    draft: false,
    id: itemId(repo, number) || `issue:${text(raw?.title)}`,
    reason,
  }
}

/**
 * Which bucket a notification reason belongs in. `subscribed` and `manual` are
 * watch signals rather than someone blocked on the human, so they land under
 * "你自己的" and never inflate "等你回的".
 */
const NOTIFICATION_BUCKETS = {
  review_requested: 'review',
  approval_requested: 'reply',
  mention: 'reply',
  team_mention: 'reply',
  assign: 'reply',
  comment: 'reply',
  author: 'mine',
  state_change: 'mine',
  ci_activity: 'mine',
  subscribed: 'mine',
  manual: 'mine',
  invitation: 'mine',
  security_alert: 'mine',
}

const NOTIFICATION_REASONS_ZH = {
  review_requested: '有人请求你评审',
  approval_requested: '有人在等你批准',
  mention: '有人在正文里 @ 了你',
  team_mention: '有人 @ 了你所在的团队',
  assign: '有人把它指派给你',
  comment: '你参与的线索有新留言',
  author: '你是作者,这条有新动态',
  state_change: '你关注的条目状态变了',
  ci_activity: '你关注的 CI 有结果',
  subscribed: '你订阅的线索有新动静',
  manual: '你手动订阅了这条线索',
  invitation: '有一个待处理的邀请',
  security_alert: '有一条安全告警',
}

export function notificationBucket(reason) {
  return NOTIFICATION_BUCKETS[reason] ?? 'mine'
}

export function notificationReasonZh(reason) {
  return NOTIFICATION_REASONS_ZH[reason] ?? `通知原因:${reason || '未标注'}`
}

/**
 * Only issue and pull URLs carry a number. Reading trailing digits off any subject
 * URL would invent a 编号 for commit notifications whose SHA happens to end in
 * digits, which is worse than admitting the number is unknown.
 */
export function subjectNumberFromUrl(url) {
  const match = /^https?:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/(?:pulls|issues)\/(\d+)$/.exec(text(url))
  return match ? Number(match[1]) : null
}

export function normalizeNotification(raw) {
  const repo = repoNameOf(raw)
  const url = text(raw?.url)
  const number = subjectNumberFromUrl(url)
  const reason = text(raw?.reason)
  return {
    kind: 'notification',
    bucket: notificationBucket(reason),
    number,
    title: text(raw?.title) || '(无标题)',
    repo,
    updatedAt: isoOrNull(raw?.updatedAt ?? raw?.updated_at),
    author: null,
    url: apiUrlToHtml(url) || text(raw?.html_url),
    draft: false,
    unread: raw?.unread !== false,
    notificationReason: reason || null,
    id: itemId(repo, number) || `notification:${text(raw?.id) || text(raw?.title)}`,
    reason: notificationReasonZh(reason),
  }
}

// ---------------------------------------------------------------------------
// drafts — text only, and nothing here sends it
// ---------------------------------------------------------------------------

const DRAFT_TEMPLATES = {
  review: () => [
    '我先通读这个 PR 的改动,重点看行为变化和边界情况。',
    '有疑问我在评审里列出来;没问题我就明说可以合。',
  ],
  reply: () => [
    '我先把这件事的范围和当前进度确认一下。',
    '我这边给结论和下一步,今天内回在这里。',
  ],
  mine: () => [
    '这个我自己推着走,先看 CI 和评论。',
    '有需要我改的地方,我在这里回。',
  ],
}

/** A draft is at most three short lines; longer than that is a reply, not a starting point. */
export function draftFor(item) {
  const template = DRAFT_TEMPLATES[item?.bucket] ?? DRAFT_TEMPLATES.mine
  return template().slice(0, 3)
}

// ---------------------------------------------------------------------------
// digest assembly
// ---------------------------------------------------------------------------

export function notificationsUnavailableText(reason) {
  const detail = text(reason) ? `gh 返回:${text(reason)}` : 'gh 没有返回可用数据'
  return `未读通知不可用 —— 这个 scope 不可用(${detail})。读通知需要 token 带 notifications 或 repo scope;补救:gh auth refresh -s notifications。`
}

export function buildDigest(input = {}) {
  const {
    me = '',
    limit = DEFAULT_LIMIT,
    repo = '',
    now = new Date().toISOString(),
    reviewRequested = [],
    assignedIssues = [],
    mentionedIssues = [],
    myPulls = [],
    notifications = [],
    notificationsStatus = { available: true, reason: '' },
    scopes = [],
    failures = [],
  } = input

  const buckets = { reply: [], review: [], mine: [] }
  const seen = new Map()
  const add = (item) => {
    if (!item || !item.id || seen.has(item.id)) return
    seen.set(item.id, item)
    ;(buckets[item.bucket] ?? buckets.mine).push(item)
  }

  // Explicit queries are added before notifications, so a first-party hit keeps its
  // better "why you" line and a notification only fills gaps.
  for (const raw of reviewRequested) add(normalizePullRequest(raw, { bucket: 'review', reason: '有人点名请你评审' }))
  for (const raw of assignedIssues) add(normalizeIssue(raw, { bucket: 'reply', reason: '指派给你,等你回' }))
  for (const raw of mentionedIssues) add(normalizeIssue(raw, { bucket: 'reply', reason: '正文里 @ 了你' }))
  for (const raw of myPulls) add(normalizePullRequest(raw, { bucket: 'mine', reason: '你自己开的,等你的后续动作' }))
  for (const raw of notifications) {
    const item = normalizeNotification(raw)
    if (repo && item.repo && item.repo !== repo) continue
    add(item)
  }

  const sections = SECTIONS.map(({ key, title }) => ({
    key,
    title,
    items: truncate(sortByUpdatedDesc(buckets[key]), limit).map((item) => ({
      ...item,
      draft: draftFor(item),
      draftStatus: DRAFT_LABEL,
    })),
  }))

  const notices = []
  if (failures.length > 0) {
    notices.push(`有 ${failures.length} 个数据源查询失败,下面的分区可能不完整:`)
    for (const failure of failures) notices.push(`- ${failure.label}:${failure.message}`)
  }
  if (!notificationsStatus.available) notices.push(notificationsUnavailableText(notificationsStatus.reason))

  const counts = {}
  for (const section of sections) counts[section.key] = section.items.length

  return {
    readOnly: true,
    generatedAt: now,
    me: me || '(未知账号)',
    scopeLabel: repo || '全部仓库',
    limit,
    scopes,
    sections,
    notices,
    counts,
    total: sections.reduce((sum, section) => sum + section.items.length, 0),
  }
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

const bulletList = (items) => items.map((line) => `  ${line}`).join('\n')

export function renderMarkdown(digest) {
  const lines = [
    '# GitHub 工作摘要(只读)',
    '',
    `- 账号:${digest.me}`,
    `- 生成时间:${formatTimestamp(digest.generatedAt)}`,
    `- 范围:${digest.scopeLabel}`,
    `- 每个分区最多:${digest.limit} 条`,
  ]
  if (digest.scopes.length > 0) lines.push(`- gh token scopes:${digest.scopes.join(', ')}`)
  lines.push('', '> 只汇总、只起草,不评论、不改动、不推送、不发送。', '')

  for (const section of digest.sections) {
    lines.push(`## ${section.title}(${section.items.length})`, '')
    if (section.items.length === 0) {
      lines.push('(无)', '')
      continue
    }
    section.items.forEach((item, index) => {
      lines.push(`### ${index + 1}. ${item.title}`)
      lines.push(`- 编号:${item.number === null ? '(无编号)' : `#${item.number}`}`)
      lines.push(`- 仓库:${item.repo || '(未知仓库)'}`)
      lines.push(`- 最后更新:${formatTimestamp(item.updatedAt)}`)
      lines.push(`- 为什么需要你:${item.reason}`)
      if (item.draft === true) lines.push('- 状态:草稿')
      if (item.url) lines.push(`- 链接:${item.url}`)
      lines.push('', `回复草稿(${DRAFT_LABEL}):`, bulletList(item.draft.map((line, i) => `${i + 1}. ${line}`)), '')
    })
    lines.push('')
  }

  if (digest.notices.length > 0) {
    lines.push('## 说明', '')
    for (const notice of digest.notices) lines.push(notice.startsWith('- ') ? notice : `- ${notice}`)
    lines.push('')
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
}

export function renderJson(digest) {
  return JSON.stringify(digest, null, 2)
}

// ---------------------------------------------------------------------------
// argument parsing
// ---------------------------------------------------------------------------

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/

export function parseArgs(argv = []) {
  const options = { json: false, limit: DEFAULT_LIMIT, repo: '', help: false, error: '' }
  const readValue = (arg, inlineValue, index) => {
    if (inlineValue !== undefined) return { value: inlineValue, next: index }
    return { value: argv[index + 1], next: index + 1 }
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i])
    if (arg === '--json') {
      options.json = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--limit' || arg.startsWith('--limit=')) {
      const inline = arg.startsWith('--limit=') ? arg.slice('--limit='.length) : undefined
      const { value, next } = readValue(arg, inline, i)
      i = next
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
        options.error = `--limit 需要 1..1000 之间的整数,收到:${value === undefined ? '(缺失)' : value}`
        return options
      }
      options.limit = parsed
    } else if (arg === '--repo' || arg.startsWith('--repo=')) {
      const inline = arg.startsWith('--repo=') ? arg.slice('--repo='.length) : undefined
      const { value, next } = readValue(arg, inline, i)
      i = next
      if (typeof value !== 'string' || !REPO_PATTERN.test(value)) {
        options.error = `--repo 需要 owner/name 形式,收到:${value === undefined ? '(缺失)' : value}`
        return options
      }
      options.repo = value
    } else {
      options.error = `未知参数:${arg}(用 --help 看用法)`
      return options
    }
  }
  return options
}

// ---------------------------------------------------------------------------
// collection
// ---------------------------------------------------------------------------

export function parseScopes(text) {
  const match = /Token scopes:\s*(.+)/.exec(String(text ?? ''))
  if (!match) return []
  return match[1]
    .split(',')
    .map((scope) => scope.trim().replace(/^'|'$/g, ''))
    .filter(Boolean)
}

export function accountFrom(text) {
  return /Logged in to \S+ account (\S+)/.exec(String(text ?? ''))?.[1] ?? ''
}

const SEARCH_BLOCKS = [
  { key: 'reviewRequested', label: '待评审的 PR' },
  { key: 'assignedIssues', label: '指派给我的 issue' },
  { key: 'mentionedIssues', label: '@ 到我的 issue' },
  { key: 'myPulls', label: '我自己的 PR' },
]

/**
 * Runs the plan and normalises every partial failure into a notice rather than an
 * exception: a missing notification scope or one rate-limited query must still
 * produce a usable digest.
 */
export async function collectDigest({ limit = DEFAULT_LIMIT, repo = '', exec = ghExec } = {}) {
  const commands = planCommands({ limit, repo })
  const byKey = new Map(commands.map((entry) => [entry.key, entry]))
  const run = (key) => runPlannedCommand(byKey.get(key), exec)

  const auth = await run('auth')
  if (isMissingGh(auth)) return { status: 'missing-gh', commands }
  if (auth.refused) return { status: 'refused', commands, detail: firstLine(auth.stderr) }
  if (!auth.ok) {
    return { status: 'unauthenticated', commands, detail: firstLine(auth.stderr || auth.stdout) }
  }

  const scopes = parseScopes(`${auth.stdout}\n${auth.stderr}`)
  const failures = []
  const readJsonList = async (key, label) => {
    const result = await run(key)
    if (isMissingGh(result)) {
      failures.push({ key, label, message: '找不到 gh 命令' })
      return []
    }
    if (result.refused) {
      failures.push({ key, label, message: firstLine(result.stderr) })
      return []
    }
    if (!result.ok) {
      failures.push({ key, label, message: firstLine(result.stderr || result.stdout) || `gh 退出码 ${result.code}` })
      return []
    }
    try {
      const parsed = JSON.parse(result.stdout || '[]')
      if (!Array.isArray(parsed)) {
        failures.push({ key, label, message: 'gh 返回的不是数组' })
        return []
      }
      return parsed
    } catch (error) {
      failures.push({ key, label, message: `gh 输出不是合法 JSON:${error.message}` })
      return []
    }
  }

  const collected = {}
  for (const block of SEARCH_BLOCKS) {
    collected[block.key] = await readJsonList(block.key, block.label)
  }

  // Notifications are optional by design: the feature must survive a token that
  // cannot read them, and say so rather than quietly reporting an empty inbox.
  let notifications = []
  let notificationsStatus = { available: true, reason: '' }
  const notificationResult = await run('notifications')
  if (!notificationResult.ok) {
    notificationsStatus = {
      available: false,
      reason: firstLine(notificationResult.stderr || notificationResult.stdout) || `gh 退出码 ${notificationResult.code}`,
    }
  } else {
    try {
      const parsed = JSON.parse(notificationResult.stdout || '[]')
      if (Array.isArray(parsed)) notifications = parsed
      else notificationsStatus = { available: false, reason: 'gh 返回的不是数组' }
    } catch (error) {
      notificationsStatus = { available: false, reason: `gh 输出不是合法 JSON:${error.message}` }
    }
  }

  const failedKeys = new Set(failures.map((failure) => failure.key))
  const allSearchesFailed = SEARCH_BLOCKS.every((block) => failedKeys.has(block.key))

  const digest = buildDigest({
    me: accountFrom(auth.stdout),
    limit,
    repo,
    now: new Date().toISOString(),
    ...collected,
    notifications,
    notificationsStatus,
    scopes,
    failures,
  })

  return { status: allSearchesFailed ? 'all-failed' : 'ok', digest, commands }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * `io` and `exec` are injectable so tests can drive the real code path — exit
 * codes, JSON purity, the read-only guard — without gh, a network, or an account.
 */
export async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? process.stdout
  const stderr = io.stderr ?? process.stderr
  const exec = io.exec ?? ghExec

  const options = parseArgs(argv)
  if (options.error) {
    stderr.write(`${options.error}\n`)
    return 1
  }
  if (options.help) {
    stdout.write(`${USAGE}\n`)
    return 0
  }

  const result = await collectDigest({ limit: options.limit, repo: options.repo, exec })

  if (result.status === 'missing-gh') {
    stderr.write(`${MISSING_GH_HINT}\n`)
    return 2
  }
  if (result.status === 'unauthenticated') {
    stderr.write(`${UNAUTHENTICATED_HINT}${result.detail ? `\n(gh 说:${result.detail})` : ''}\n`)
    return 2
  }
  if (result.status === 'refused') {
    stderr.write(`只读自检失败,拒绝继续:${result.detail}\n`)
    return 1
  }

  const output = options.json ? renderJson(result.digest) : renderMarkdown(result.digest)

  // Last line of defence. If this tool ever produced a posting command, the run
  // fails loudly instead of printing instructions the den might then execute.
  if (containsWriteCommand(output)) {
    stderr.write('只读自检失败:输出里出现了写操作命令,已拒绝打印。\n')
    return 1
  }

  stdout.write(output.endsWith('\n') ? output : `${output}\n`)
  return result.status === 'all-failed' ? 1 : 0
}

const isDirectRun =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  main().then((code) => {
    process.exitCode = code
  })
}
