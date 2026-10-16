/**
 * Tests for the read-only GitHub digest.
 *
 * The load-bearing test is the read-only one. "den drafts, never performs the
 * act" is only worth anything if it is enforced in code, so this file asserts both
 * that no rendered output contains a posting command and that the guard doing the
 * asserting actually rejects a real one — a guard nobody has seen fail is not
 * evidence. Nothing here shells out to gh: every call goes through an injected
 * fake, so the suite runs without a network, an account or the gh binary.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DRAFT_LABEL,
  buildDigest,
  collectDigest,
  containsWriteCommand,
  draftFor,
  isReadOnlyCommand,
  main,
  parseArgs,
  planCommands,
  renderJson,
  renderMarkdown,
  runPlannedCommand,
  sortByUpdatedDesc,
  truncate,
} from '../tools/github-digest.mjs'

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

const AUTH_OK = {
  raw: [
    'github.com',
    '  ✓ Logged in to github.com account tester (keyring)',
    '  - Active account: true',
    "  - Token scopes: 'gist', 'read:org', 'repo'",
    '',
  ].join('\n'),
}

const raw = (stdout) => ({ raw: stdout })
const failing = (stderr = 'boom', code = 1) => ({ fail: true, code, stderr })

/** Routes a gh argument array to the same block names the tool uses. */
function routeOf(args) {
  if (args[0] === 'auth') return 'auth'
  if (args[0] === 'api') return 'notifications'
  if (args[0] === 'search' && args[1] === 'prs') {
    return args.includes('--review-requested') ? 'reviewRequested' : 'myPulls'
  }
  if (args[0] === 'search' && args[1] === 'issues') {
    return args.includes('--assignee') ? 'assignedIssues' : 'mentionedIssues'
  }
  return 'unknown'
}

/**
 * A fake gh: `overrides` maps a block name to either a JSON-able array, `raw(...)`
 * for literal stdout, or `failing(...)`. Unlisted blocks answer with an empty list.
 */
function fakeGh(overrides = {}) {
  const calls = []
  const exec = async (args) => {
    calls.push(args)
    const entry = overrides[routeOf(args)]
    if (entry === undefined) return { ok: true, code: 0, stdout: '[]', stderr: '' }
    if (entry.fail) {
      return {
        ok: false,
        code: entry.code ?? 1,
        // Mirrors the real runner: a spawn failure surfaces as ENOENT either way.
        missing: entry.missing === true || entry.code === 'ENOENT',
        stdout: entry.stdout ?? '',
        stderr: entry.stderr ?? '',
      }
    }
    if (typeof entry.raw === 'string') return { ok: true, code: 0, stdout: entry.raw, stderr: '' }
    return { ok: true, code: 0, stdout: JSON.stringify(entry), stderr: '' }
  }
  exec.calls = calls
  return exec
}

function fakeIo() {
  let out = ''
  let err = ''
  return {
    stdout: { write: (chunk) => { out += chunk } },
    stderr: { write: (chunk) => { err += chunk } },
    stdoutText: () => out,
    stderrText: () => err,
  }
}

const pr = (number, updatedAt, over = {}) => ({
  number,
  title: `PR ${number}`,
  repository: { nameWithOwner: 'acme/widgets' },
  updatedAt,
  author: { login: 'someone' },
  url: `https://github.com/acme/widgets/pull/${number}`,
  isDraft: false,
  state: 'open',
  ...over,
})

const issue = (number, updatedAt, over = {}) => ({
  number,
  title: `Issue ${number}`,
  repository: { nameWithOwner: 'acme/widgets' },
  updatedAt,
  author: { login: 'someone' },
  url: `https://github.com/acme/widgets/issues/${number}`,
  state: 'open',
  ...over,
})

const notification = (over = {}) => ({
  id: '9001',
  reason: 'mention',
  unread: true,
  updatedAt: '2026-02-01T00:00:00Z',
  title: '通知标题',
  type: 'Issue',
  url: 'https://api.github.com/repos/acme/widgets/issues/7',
  repo: 'acme/widgets',
  ...over,
})

// ---------------------------------------------------------------------------
// shape of an empty digest
// ---------------------------------------------------------------------------

test('空输入不抛异常,并且仍然给出三个分区,每区写「无」', async () => {
  const result = await collectDigest({ exec: fakeGh({ auth: AUTH_OK }) })
  assert.equal(result.status, 'ok')

  const markdown = renderMarkdown(result.digest)
  for (const title of ['等你回的', '等你审的', '你自己的']) assert.match(markdown, new RegExp(title))
  assert.equal(result.digest.total, 0)
  assert.equal((markdown.match(/\(无\)/g) ?? []).length, 3)
})

test('一条待评审的 PR 落在「等你审的」,并带上编号、仓库和原因', async () => {
  const exec = fakeGh({ auth: AUTH_OK, reviewRequested: [pr(42, '2026-03-01T10:00:00Z')] })
  const { digest } = await collectDigest({ exec })

  const review = digest.sections.find((section) => section.key === 'review')
  assert.equal(review.items.length, 1)
  assert.equal(review.items[0].number, 42)
  assert.equal(review.items[0].repo, 'acme/widgets')
  assert.equal(review.items[0].reason, '有人点名请你评审')

  const markdown = renderMarkdown(digest)
  assert.match(markdown, /#42/)
  assert.match(markdown, /acme\/widgets/)
})

test('一条指派给我的 issue 落在「等你回的」', async () => {
  const exec = fakeGh({ auth: AUTH_OK, assignedIssues: [issue(7, '2026-03-02T10:00:00Z')] })
  const { digest } = await collectDigest({ exec })

  const reply = digest.sections.find((section) => section.key === 'reply')
  assert.equal(reply.items.length, 1)
  assert.equal(reply.items[0].kind, 'issue')
  assert.equal(reply.items[0].reason, '指派给你,等你回')
})

test('@ 到我的 issue 也算「等你回的」,并且和指派去重', async () => {
  const duplicated = issue(7, '2026-03-02T10:00:00Z')
  const exec = fakeGh({ auth: AUTH_OK, assignedIssues: [duplicated], mentionedIssues: [duplicated] })
  const { digest } = await collectDigest({ exec })

  const reply = digest.sections.find((section) => section.key === 'reply')
  assert.equal(reply.items.length, 1, '同一个 issue 被两个查询命中时只算一条')
})

// ---------------------------------------------------------------------------
// degradation
// ---------------------------------------------------------------------------

test('通知 scope 不可用时降级成一句可读说明,而不是抛异常或谎报空收件箱', async () => {
  const exec = fakeGh({
    auth: AUTH_OK,
    notifications: failing('HTTP 404: Not Found (notifications scope missing)', 1),
    myPulls: [pr(1, '2026-03-01T10:00:00Z')],
  })
  const result = await collectDigest({ exec })

  assert.equal(result.status, 'ok', '通知读不到不该让整次运行失败')
  const notice = result.digest.notices.join('\n')
  assert.match(notice, /这个 scope 不可用/)
  assert.match(notice, /notifications/)

  const markdown = renderMarkdown(result.digest)
  assert.match(markdown, /这个 scope 不可用/)
  assert.match(markdown, /gh auth refresh -s notifications/)
})

test('通知输出不是合法 JSON 时也只降级,不崩', async () => {
  const exec = fakeGh({ auth: AUTH_OK, notifications: raw('<html>rate limited</html>') })
  const { digest } = await collectDigest({ exec })
  assert.match(digest.notices.join('\n'), /不是合法 JSON|这个 scope 不可用/)
})

test('所有查询都失败时状态是 all-failed,但说明仍然可读', async () => {
  const exec = fakeGh({
    auth: AUTH_OK,
    reviewRequested: failing('rate limit'),
    myPulls: failing('rate limit'),
    assignedIssues: failing('rate limit'),
    mentionedIssues: failing('rate limit'),
  })
  const result = await collectDigest({ exec })

  assert.equal(result.status, 'all-failed')
  assert.match(renderMarkdown(result.digest), /数据源查询失败/)
})

// ---------------------------------------------------------------------------
// limit and ordering
// ---------------------------------------------------------------------------

test('--limit 截断每个分区,并且真的把 limit 传给了 gh', async () => {
  const exec = fakeGh({
    auth: AUTH_OK,
    myPulls: [pr(1, '2026-03-01T10:00:00Z'), pr(2, '2026-03-02T10:00:00Z'), pr(3, '2026-03-03T10:00:00Z')],
  })
  const { digest } = await collectDigest({ exec, limit: 2 })

  const mine = digest.sections.find((section) => section.key === 'mine')
  assert.equal(mine.items.length, 2)
  assert.equal(mine.items[0].number, 3, '截断发生在排序之后,保留的应该是最新的两条')

  const search = exec.calls.find((args) => args[1] === 'prs' && args.includes('--author'))
  assert.ok(search.includes('--limit') && search.includes('2'), '截断不能只做在本地,要顺手少拉数据')
})

test('最近更新的排在最前面,没有时间的沉到最后', async () => {
  const exec = fakeGh({
    auth: AUTH_OK,
    myPulls: [
      pr(1, '2026-03-01T10:00:00Z'),
      pr(2, '2026-03-05T10:00:00Z'),
      pr(3, null),
      pr(4, '2026-03-03T10:00:00Z'),
    ],
  })
  const { digest } = await collectDigest({ exec })
  const mine = digest.sections.find((section) => section.key === 'mine')

  assert.deepEqual(mine.items.map((item) => item.number), [2, 4, 1, 3])
})

test('排序是纯函数,且不改动传入的数组', () => {
  const input = [{ id: 'a', updatedAt: '2026-01-01T00:00:00Z' }, { id: 'b', updatedAt: '2026-02-01T00:00:00Z' }]
  assert.deepEqual(sortByUpdatedDesc(input).map((item) => item.id), ['b', 'a'])
  assert.equal(input[0].id, 'a', '纯函数不该把调用方的数组排乱')
  assert.equal(truncate([1, 2, 3], 2).length, 2)
})

// ---------------------------------------------------------------------------
// the read-only guarantee
// ---------------------------------------------------------------------------

test('任何输出里都不出现评论或发送类命令,而且这个断言不是空转', async () => {
  const exec = fakeGh({
    auth: AUTH_OK,
    myPulls: [pr(1, '2026-03-01T10:00:00Z')],
    reviewRequested: [pr(2, '2026-03-02T10:00:00Z')],
    assignedIssues: [issue(3, '2026-03-03T10:00:00Z')],
    mentionedIssues: [issue(4, '2026-03-04T10:00:00Z')],
    notifications: [notification()],
  })
  const { digest, commands } = await collectDigest({ exec })

  const markdown = renderMarkdown(digest)
  const json = renderJson(digest)
  assert.equal(containsWriteCommand(markdown), false, 'Markdown 里出现了写命令')
  assert.equal(containsWriteCommand(json), false, 'JSON 里出现了写命令')

  // The guard has to be able to fail, or the two assertions above prove nothing.
  assert.equal(containsWriteCommand('gh pr comment 12 --body "lgtm"'), true)
  assert.equal(containsWriteCommand('gh issue close 3'), true)
  assert.equal(containsWriteCommand('gh pr review 12 --approve'), true)
  assert.equal(containsWriteCommand('gh api -X POST /repos/o/n/issues/1/comments -f body=hi'), true)
  assert.equal(containsWriteCommand('git push origin main'), true)

  // And it must not cry wolf over the tool's own honest labelling.
  assert.match(markdown, /未发送/)
  assert.equal(containsWriteCommand(`草稿，未发送`), false)

  for (const entry of commands) {
    assert.equal(isReadOnlyCommand(entry.args), true, `计划里混进了写命令:${entry.args.join(' ')}`)
  }
})

test('写命令会被执行层直接拒绝,而不是靠调用方自觉', async () => {
  const exec = fakeGh({ auth: AUTH_OK })
  const refused = await runPlannedCommand({ key: 'evil', args: ['pr', 'comment', '12', '--body', 'hi'] }, exec)
  assert.equal(refused.ok, false)
  assert.equal(refused.refused, true)
  assert.match(refused.stderr, /拒绝执行非只读命令/)
  assert.equal(exec.calls.length, 0, '被拒的命令绝不能真的跑出去')

  assert.equal(isReadOnlyCommand(['pr', 'comment', '12']), false)
  assert.equal(isReadOnlyCommand(['api', 'repos/o/n/issues', '--method', 'POST']), false)
  assert.equal(isReadOnlyCommand(['api', 'notifications?per_page=5', '--jq', 'map(.)']), true)
  assert.equal(isReadOnlyCommand(['auth', 'status']), true)
})

test('计划里的命令集合是固定的,不随参数长出新的写入口', () => {
  const keys = planCommands({ limit: 5, repo: 'acme/widgets' }).map((entry) => entry.key)
  assert.deepEqual(keys, ['auth', 'reviewRequested', 'myPulls', 'assignedIssues', 'mentionedIssues', 'notifications'])
})

// ---------------------------------------------------------------------------
// drafts
// ---------------------------------------------------------------------------

test('每条都带一份三行以内的中文草稿,并明确标着未发送', async () => {
  const exec = fakeGh({
    auth: AUTH_OK,
    myPulls: [pr(1, '2026-03-01T10:00:00Z')],
    reviewRequested: [pr(2, '2026-03-02T10:00:00Z')],
    assignedIssues: [issue(3, '2026-03-03T10:00:00Z')],
  })
  const { digest } = await collectDigest({ exec })

  const items = digest.sections.flatMap((section) => section.items)
  assert.ok(items.length >= 3)
  for (const item of items) {
    assert.ok(item.draft.length >= 1 && item.draft.length <= 3, '草稿要短,超过三行就是回复了')
    for (const line of item.draft) assert.match(line, /[\u4e00-\u9fa5]/, '草稿用中文')
    assert.equal(item.draftStatus, DRAFT_LABEL)
  }
  assert.equal(draftFor({ bucket: 'review' }).length <= 3, true)
  assert.match(renderMarkdown(digest), new RegExp(DRAFT_LABEL))
})

// ---------------------------------------------------------------------------
// CLI contract
// ---------------------------------------------------------------------------

test('--json 时 stdout 只有 JSON,没有别的行', async () => {
  const io = fakeIo()
  const code = await main(['--json', '--limit', '3'], {
    ...io,
    exec: fakeGh({ auth: AUTH_OK, myPulls: [pr(1, '2026-03-01T10:00:00Z')] }),
  })

  assert.equal(code, 0)
  const parsed = JSON.parse(io.stdoutText())
  assert.equal(parsed.readOnly, true)
  assert.equal(parsed.limit, 3)
  assert.equal(parsed.sections.find((section) => section.key === 'mine').items.length, 1)
  assert.equal(io.stderrText(), '')
})

test('无参数时输出人类可读的 Markdown', async () => {
  const io = fakeIo()
  const code = await main([], { ...io, exec: fakeGh({ auth: AUTH_OK }) })

  assert.equal(code, 0)
  assert.match(io.stdoutText(), /^# GitHub 工作摘要/)
  assert.throws(() => JSON.parse(io.stdoutText()), '默认输出不该是 JSON')
})

test('gh 不存在时退出码是 2,并给出补救提示', async () => {
  const io = fakeIo()
  const code = await main([], { ...io, exec: fakeGh({ auth: failing('spawn gh ENOENT', 'ENOENT') }) })

  assert.equal(code, 2)
  assert.match(io.stderrText(), /找不到 gh 命令/)
  assert.match(io.stderrText(), /cli\.github\.com/)
  assert.equal(io.stdoutText(), '')
})

test('gh 未登录时退出码是 2,并给出补救提示', async () => {
  const io = fakeIo()
  const exec = fakeGh({ auth: failing('gh: not logged in to any hosts', 1) })
  // `missing` is set only by the real runner's ENOENT branch, so a plain failure
  // here is exactly the "installed but unauthenticated" case.
  const code = await main([], { ...io, exec })

  assert.equal(code, 2)
  assert.match(io.stderrText(), /没有登录/)
  assert.match(io.stderrText(), /gh auth login/)
  assert.equal(io.stdoutText(), '')
})

test('所有查询都失败时退出码是 1,但说明照样打印出来', async () => {
  const io = fakeIo()
  const code = await main([], {
    ...io,
    exec: fakeGh({
      auth: AUTH_OK,
      reviewRequested: failing('rate limit'),
      myPulls: failing('rate limit'),
      assignedIssues: failing('rate limit'),
      mentionedIssues: failing('rate limit'),
    }),
  })

  assert.equal(code, 1)
  assert.match(io.stdoutText(), /数据源查询失败/)
})

test('参数错误退出码是 1,而且一个 gh 调用都不发', async () => {
  const exec = fakeGh({ auth: AUTH_OK })
  const io = fakeIo()
  assert.equal(await main(['--limit', 'abc'], { ...io, exec }), 1)
  assert.equal(await main(['--limit', '0'], { ...io, exec }), 1)
  assert.equal(await main(['--repo', 'not-a-repo'], { ...io, exec }), 1)
  assert.equal(await main(['--nope'], { ...io, exec }), 1)
  assert.equal(exec.calls.length, 0)

  assert.equal(parseArgs(['--json', '--limit=5', '--repo=acme/widgets']).limit, 5)
  assert.equal(parseArgs(['--repo=acme/widgets']).repo, 'acme/widgets')
  assert.equal(parseArgs(['--limit']).error !== '', true)
})

test('--repo 传给每个搜索,并把别的仓库的通知过滤掉', async () => {
  const exec = fakeGh({
    auth: AUTH_OK,
    notifications: [
      notification({ id: '1', repo: 'acme/widgets' }),
      notification({ id: '2', repo: 'other/thing', url: 'https://api.github.com/repos/other/thing/issues/8' }),
    ],
  })
  const { digest } = await collectDigest({ exec, repo: 'acme/widgets' })

  for (const args of exec.calls.filter((call) => call[0] === 'search')) {
    assert.ok(args.includes('--repo') && args.includes('acme/widgets'), `缺少 --repo:${args.join(' ')}`)
  }
  const ids = digest.sections.flatMap((section) => section.items).map((item) => item.id)
  assert.equal(ids.length, 1)
  assert.match(ids[0], /acme\/widgets#7/)
})

test('不会从 commit 的 SHA 尾部数字里编出一个编号', async () => {
  const exec = fakeGh({
    auth: AUTH_OK,
    notifications: [
      notification({
        id: '31',
        reason: 'ci_activity',
        title: 'CI 有结果',
        url: 'https://api.github.com/repos/acme/widgets/commits/9f2c1b7a42',
      }),
    ],
  })
  const { digest } = await collectDigest({ exec })

  const item = digest.sections.flatMap((section) => section.items)[0]
  assert.equal(item.number, null, 'SHA 末尾是数字,但它不是编号')
  assert.match(item.id, /^notification:31$/)
  assert.match(renderMarkdown(digest), /\(无编号\)/)
})

test('通知按原因归类,并且不会盖掉第一方查询给出的原因', async () => {
  const exec = fakeGh({
    auth: AUTH_OK,
    myPulls: [pr(9, '2026-03-09T10:00:00Z')],
    notifications: [
      notification({ id: '11', reason: 'review_requested', title: '请你评审', url: 'https://api.github.com/repos/acme/widgets/pulls/5' }),
      notification({ id: '12', reason: 'author', title: '你自己的 PR 有新动态', url: 'https://api.github.com/repos/acme/widgets/pulls/9' }),
    ],
  })
  const { digest } = await collectDigest({ exec })

  const review = digest.sections.find((section) => section.key === 'review')
  assert.equal(review.items.length, 1)
  assert.equal(review.items[0].number, 5)
  assert.equal(review.items[0].url, 'https://github.com/acme/widgets/pull/5')

  const mine = digest.sections.find((section) => section.key === 'mine')
  assert.equal(mine.items.length, 1, 'PR 9 已经由第一方查询给出,通知不该重复计数')
  assert.equal(mine.items[0].reason, '你自己开的,等你的后续动作')
})

test('scope 会被读出来放进摘要,账号也是', async () => {
  const { digest } = await collectDigest({ exec: fakeGh({ auth: AUTH_OK }) })
  assert.deepEqual(digest.scopes, ['gist', 'read:org', 'repo'])
  assert.equal(digest.me, 'tester')
  assert.match(renderMarkdown(digest), /gh token scopes:gist, read:org, repo/)
})

test('buildDigest 对缺字段的输入是防御的,不会伪造仓库或编号', () => {
  const digest = buildDigest({ myPulls: [{ title: '没有仓库也没有编号' }] })
  const item = digest.sections.find((section) => section.key === 'mine').items[0]
  assert.equal(item.repo, '')
  assert.equal(item.number, null)
  assert.equal(item.updatedAt, null)
  assert.match(renderMarkdown(digest), /\(未知仓库\)/)
  assert.match(renderMarkdown(digest), /\(无编号\)/)
})
