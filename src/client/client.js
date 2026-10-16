/* dsh-den resident status panel — browser half of the plugin.
 *
 * This file is loaded by the DSH shell's module loader, not by Node. It is a
 * single hand-written lazy-CJS bundle with no build step: the loader's only
 * requirements are that the bundle calls `window.__ModuleLoader__.load({id,
 * factory})` with an `id` equal to the package name, and that every side effect
 * (including style injection) happens inside the factory so nothing runs before
 * the module is materialised.
 *
 * The host half is `src/index.js`. The two communicate over one JSON route,
 * `POST /dsh-den`, mounted in `src/panel-route.js` on the host's web server — the
 * same `/<package name>` convention the other client plugins in this profile use.
 * Nothing here can change the den's authority on its own; the few verbs the panel
 * does carry are dispatched and validated on the host side.
 *
 * Loading contract, verified against the shipped client-module system:
 *   package.json needs `exports["./client"]` and `dsh.client = {platform: 'web'}`.
 *   There is no `entry` field; the bundle path comes from the export map only.
 *   `sidebar.panellist`'s `id` must equal `main`'s `key`, or selecting the icon
 *   throws without changing the panel.
 */
window.__ModuleLoader__.load({
  id: 'dsh-den',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    var NS = 'dsh.den'
    /* Sidebar entry id and main-panel key. These MUST be the same value. */
    var PANEL_KEY = 'dsh-den.status'
    /** Its own seat in the composer dock: a fresh id adds an entry rather than replacing the shell's. */
    /**
     * The host route. Must equal the `path` the host hands to `webServer.register`,
     * which is `/<package name>` by the convention every client plugin here follows
     * (dsh-warden -> '/dsh-warden', dsh-daily -> '/dsh-daily', dsh-vision-diff ->
     * '/dsh-vision-diff'). `test/client-contract.test.mjs` compares the two files.
     */
    var API = '/dsh-den'
    /* The shipped Plugins panel sits at order 0; dsh-bot uses 250. */
    var ORDER = 245

    /* ------------------------------------------------------------- locale */

    var STRINGS = {
      en: {
        nav: 'den',
        title: 'den — resident assistant',
        panelEyebrow: 'RESIDENT CONTROL',
        panelSubtitle: 'Signals first. Details when you need them.',
        refreshing: 'refreshing…',
        refresh: 'Refresh',
        autonomy: 'acting on my own',
        autonomyOn: 'I may act on my own here',
        autonomyOff: 'I will not act on my own here',
        autonomyUnknown: 'cannot be judged from here',
        nextCheck: 'Next self-check',
        turns: "Today's self-initiated turns",
        notices: 'Pending notices',
        gate: 'Approval gate',
        gateMounted: 'armed',
        gateUnmounted: 'tools unguarded',
        gateArmed: 'tools guarded',
        gateDirect: 'tools pass through',
        gateDirectHint: 'Approval gate is off for this profile.',
        gateArmedHint: 'Risky or remote actions stay behind the gate.',
        scenarios: 'Memory scenarios',
        kernel: 'Heartbeat',
        kernelOn: 'running',
        kernelOff: 'stopped',
        lastTick: 'last tick',
        none: 'none',
        never: 'never',
        recovered: 'crash litter reclaimed',
    /** Whether this process loaded the code this panel is drawn from. */
        codeFreshness: 'running code',
        freshCurrent: 'current',
        freshStale: 'older than the tree - restart DSH',
        freshUnknown: 'cannot be judged by this instance',
        reapedNotices: 'expired reminders reclaimed',
        unavailable: 'The host did not answer',
        errors: 'Last error',
        working: 'working…',
        autonomyGrant: 'Grant',
        autonomyRevoke: 'Revoke',
        autonomyNoSession:
          'this page has no conversation bound to it — grant from the floating window; one grant covers every conversation',
        grantDock: 'Standing autonomy · this conversation',
        sayYou: 'you',
        residentDeferred: 'waiting for a way to speak',
        budgetShort: 'turns',
        budgetOff: 'proactivity off',
        hostOlder: 'host needs a restart',
        sayDen: 'den',
        sayPlaceholder: 'say something to den…',
        saySend: 'Send',
        sayEmpty: 'no conversation yet — say something to start one',
        sayFailed: 'the last turn did not finish: ',
        saySending: 'sending…',
        petTypeBelow: 'type below to add to it',
        sayTail: 'only the latest messages are shown; the rest are still in the transcript',
        sayHostOld: 'the host has not loaded this half yet — restart DSH and this becomes the conversation',
        grantDockGranted: 'granted for this conversation',
        grantDockNotGranted: 'not granted for this conversation',
        grantDockUnknown: 'state unknown',
        autonomyTokenHint:
          'Paste this token to the assistant as your next message; it will grant access with that message as proof. The token is single-use and expires.',
        autonomyCopied: 'token ready',
        autonomyCopyToken: 'copy token',
        autonomyCopyDone: 'copied — paste it as your next message',
        autonomyCopyFailed: 'copy failed — select the token above by hand',
        schedules: 'Self-checks',
        noticesOwed: 'while you were away:',
        noticeReadIt: 'read it',
        residentOn: 'resident · heartbeat fine',
        residentOff: 'resident · not running',
        wokeShort: 'woke itself today',
        owedShort: 'things to tell you',
        collapse: 'shut it',
        openPanel: 'Open den panel',
        floatingLabel: 'standing chat',
        resizeHint: 'Drag the corner to resize',
        dragHint: 'Hold the top bar to move',
        tasksShort: 'in progress',
        tasksStuck: 'stuck',
        tasksWaiting: 'waiting on you',
        petActivity: 'Activity',
        petConversation: 'Conversation',
        petSignals: 'signals',
        petNoSignals: 'no new signals',
        petWatching: 'watching',
        petStateRunning: 'running',
        petStateWaiting: 'waiting for you',
        petStateQuiet: 'quiet',
        petModeUnknown: 'no snapshot yet',
        petComposerPlaceholder: 'ask den something…',
        petShortcutActivity: 'what happened',
        petShortcutStatus: 'explain status',
        petShortcutSelfCheck: 'run self-check',
        petReadFromStore: 'from the session store',
        petReadFromLog: 'read back from the log on disk',
        petReadFromNone: 'the host handed back no transcript',
        petMoreOnDisk: 'older messages are still in the transcript on disk',
        details: 'details',
        scheduleNone: 'none — say "check CI every 30 minutes" in the conversation and the den will add it',
        scheduleNew: 'New',
        scheduleClose: 'Close',
        scheduleTitle: 'Title',
        schedulePrompt: 'What to check',
        scheduleMinutes: 'Every (minutes)',
        scheduleAdd: 'Add self-check',
        howToAsk: 'How to ask: just say it in the message box below — for example a request to handle something, or a question about what I remember.',
        scheduleAddElsewhere: 'Creating one works the same way — say it in the message box.',
        scheduleRemove: 'remove',
        scheduleCreateHint: 'Not a permission grant: each run still re-checks autonomy, budget and quiet hours.',
        dueNow: 'due now',
        kernelWaiting: 'waiting for a delivery path',
        kernelStandby: 'standby - another host on this home holds residency',
        kernelGaveUp: 'gave up after',
        attempts: 'attempts',
        footNote:
          'Granting happens in the floating window: mint a token, paste it into any conversation, and every conversation is awake from then on.',
      },
      zh: {
        nav: 'den',
        title: 'den —— 常驻助理',
        panelEyebrow: '常驻控制台',
        panelSubtitle: '先看信号，再决定是否展开细节。',
        refreshing: '刷新中…',
        refresh: '刷新',
        autonomy: '能不能自己动手',
        autonomyOn: '这个会话我可以自己动',
        autonomyOff: '这个会话我不自己动',
        autonomyUnknown: '这里判断不了',
        nextCheck: '下次自检',
        turns: '今日自发起轮次',
        notices: '待处理提醒',
        gate: '审批闸门',
        gateMounted: '已装载',
        gateUnmounted: '工具直通',
        gateArmed: '工具受保护',
        gateDirect: '工具直通',
        gateDirectHint: '当前 profile 已关闭审批闸门，工具调用不会被拦截。',
        gateArmedHint: '危险或远端操作会留在审批门后。',
        scenarios: '记忆场景',
        kernel: '心跳',
        kernelOn: '运行中',
        kernelOff: '已停止',
        lastTick: '上次心跳',
        none: '无',
        never: '从未',
        recovered: '回收的崩溃残留',
        /** 这个进程是否加载了画这块面板的代码。 */
        codeFreshness: '运行中的代码',
        freshCurrent: '与代码树一致',
        freshStale: '比代码树旧 —— 需要重启 DSH',
        freshUnknown: '这个实例判断不了',
        reapedNotices: '回收的过期提醒',
        unavailable: '宿主未应答',
        errors: '最近错误',
        working: '处理中…',
        autonomyGrant: '授予',
        autonomyRevoke: '撤销',
        autonomyNoSession:
          '这个页面没有被绑定任何会话 —— 在浮窗里授予就行（收起时是右上角那颗带小圆点的 ◈ 圆钮），一次授权对所有会话生效',
        grantDock: '常驻自治 · 本会话',
        sayYou: '你',
        residentDeferred: '等待投递',
        budgetShort: '回合',
        budgetOff: '自治已关',
        hostOlder: '宿主待重启',
        sayDen: 'den',
        sayPlaceholder: '直接跟 den 说一句…',
        saySend: '发送',
        sayEmpty: '还没有对话 —— 说一句就开始',
        sayFailed: '上一回合没能完成:',
        saySending: '发送中…',
        petTypeBelow: '在下面输入框里接着说',
        sayTail: '只显示最近的消息，更早的都还在转录里',
        sayHostOld: '宿主还没加载会话这一半 —— 重启 DSH 后这里就是对话',
        noticesOwed: '你不在的时候：',
        noticeReadIt: '读过了',
        residentOn: '常驻中 · 心跳运行中',
        residentOff: '常驻中 · 已停',
        wokeShort: '自己醒来',
        owedShort: '有话想跟你说',
        collapse: '收起',
        openPanel: '打开 den 面板',
        floatingLabel: '常驻会话',
        resizeHint: '拖动右下角调整大小',
        dragHint: '按住顶部条拖动',
        tasksShort: '进行中',
        tasksStuck: '卡住',
        tasksWaiting: '等你',
        petActivity: '活动',
        petConversation: '对话',
        petSignals: '个信号',
        petNoSignals: '没有新信号',
        petWatching: '正在观察',
        petStateRunning: '运行中',
        petStateWaiting: '等待你',
        petStateQuiet: '安静',
        petModeUnknown: '还没有状态快照',
        petComposerPlaceholder: '问 den 一句…',
        petShortcutActivity: '查看活动',
        petShortcutStatus: '解释状态',
        petShortcutSelfCheck: '运行自检',
        petReadFromStore: '来自会话存储',
        petReadFromLog: '从磁盘日志回读',
        petReadFromNone: '宿主没有交回转录',
        petMoreOnDisk: '更早的消息仍在磁盘转录里',
        details: '详情',
        grantDockGranted: '本会话已授予',
        grantDockNotGranted: '本会话未授予',
        grantDockUnknown: '状态未知',
        autonomyTokenHint:
          '把这个令牌作为你的下一条消息发给助理，它会以那条消息作为证据完成写入。令牌一次性有效并会过期。',
        // 这一条以前在 zh 里缺失，于是中文面板显示的是英文兜底串。
        autonomyCopied: '令牌已就绪',
        autonomyCopyToken: '复制令牌',
        autonomyCopyDone: '已复制 —— 粘贴到下面的输入框发送',
        autonomyCopyFailed: '复制失败 —— 请手动选中上面的令牌',
        schedules: '自检',
        scheduleNone: '无 —— 在对话里说「每 30 分钟看一眼 CI」，助理就会加上',
        scheduleNew: '新建',
        scheduleClose: '收起',
        scheduleTitle: '名称',
        schedulePrompt: '检查什么',
        scheduleMinutes: '每（分钟）',
        scheduleAdd: '新建自检',
        howToAsk: '怎么用：在下面的消息框里直接说一句就行 —— 比如「帮我办 X」或「你记得我什么」。',
        scheduleAddElsewhere: '创建自检也是在消息框里说一句 —— 比如「每 30 分钟看一眼 CI」。',
        scheduleRemove: '删除',
        scheduleCreateHint: '这不是权限授予：每次运行仍会重新检查授权、预算与免打扰时段。',
        dueNow: '待触发',
        kernelWaiting: '等待投递通道',
        kernelStandby: '待命 —— 同一 home 上另一个宿主持有驻留权',
        kernelGaveUp: '已放弃，尝试',
        attempts: '次',
        footNote:
          '授予在浮窗里做：铸一个令牌，把它贴到任意一个会话里发出去，之后所有会话都算醒着。',
      },
    }

    function pick(locale) {
      var tag = String(locale || '').toLowerCase()
      // The den's own panel speaks Chinese by default and switches to English only when the host
      // *explicitly* says English. The reason is the person rather than the framework: the profile's
      // first line records that this user works in Chinese, so a panel that answers in English is a
      // panel they have to translate before they can read it. A screenshot of the English panel is
      // what produced this change.
      return tag.indexOf('en') === 0 ? STRINGS.en : STRINGS.zh
    }

    /* ------------------------------------------------------------ helpers */

    function fmtTime(ms, t) {
      if (!ms) return t('never')
      try {
        return new Date(ms).toLocaleString()
      } catch (error) {
        return String(ms)
      }
    }

    /* The one-click copy control for a minted token.
     *
     * Written once because this strip renders in two branches of the same component — the dock
     * above the composer, which is the one a human actually uses, and the full page — and the
     * two had already drifted: the page grew a copy control while the dock, the one on the
     * critical path, still offered only `userSelect: all`.
     *
     * Why it exists at all: the token is long, single-use and wrapped across lines, and a copy
     * missing one character is refused downstream as "the message does not quote the token" — a
     * sentence that names no character and leaves the human with nothing to correct, at the cost
     * of another round trip. So the control is guarded, and a clipboard that is missing, refuses,
     * or throws synchronously is reported as a failure rather than as a copy the human cannot
     * trust. The token still goes nowhere else: this is the same string already shown on the
     * page, and no page-global is involved. */
    function copyControl(t, token, note, setNote) {
      return React.createElement(
        'button',
        {
          key: 'copy',
          type: 'button',
          onClick: function () {
            var fail = function () { setNote('copy-failed') }
            var clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null
            if (!clipboard || typeof clipboard.writeText !== 'function') {
              fail()
              return
            }
            try {
              clipboard.writeText(token).then(
                function () { setNote('copied') },
                fail,
              )
            } catch (error) {
              fail()
            }
          },
          style: {
            background: 'transparent',
            border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: 4,
            color: 'var(--dsw-alias-label-primary)',
            cursor: 'pointer',
            fontSize: 12,
            padding: '2px 8px',
            whiteSpace: 'nowrap',
          },
        },
        t(note === 'copied' ? 'autonomyCopyDone' : note === 'copy-failed' ? 'autonomyCopyFailed' : 'autonomyCopyToken'),
      )
    }

    /* Status tones resolve through an explicit table rather than string
     * concatenation. A mistyped `var()` name is silently ignored by CSS, so a
     * built-up token name would fail invisibly; a wrong table entry is at least
     * greppable, and tools/check-client-bundle.mjs validates the names. */
    var TONE_TOKEN = {
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
    }

    /**
     * Compact status language for the panel header and the floating window.
     *
     * The dot is deliberately a semantic token rather than a hard-coded colour: the host owns
     * the light/dark palette, while den owns the meaning of the state. A single status primitive
     * also keeps the main page and the floating surface from drifting apart again.
     */
    function StatusBadge(props) {
      var color = TONE_TOKEN[props.tone || 'success'] || TONE_TOKEN.success
      return React.createElement(
        'span',
        {
          role: 'status',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            minHeight: 24,
            padding: '3px 9px',
            borderRadius: 999,
            border: '1px solid var(--dsw-alias-border-l2)',
            background: 'var(--dsw-alias-bg-layer-2)',
            color: 'var(--dsw-alias-label-secondary)',
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.01em',
            whiteSpace: 'nowrap',
          },
        },
        React.createElement('span', {
          'aria-hidden': true,
          style: { width: 7, height: 7, borderRadius: 999, background: color, boxShadow: '0 0 0 3px var(--dsw-alias-bg-layer-2)' },
        }),
        React.createElement('span', null, props.label),
        props.detail
          ? React.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontWeight: 400 } }, props.detail)
          : null,
      )
    }

    /** A small signal card; values lead, labels recede, and the detail line explains the number. */
    function Metric(props) {
      var tone = props.tone ? TONE_TOKEN[props.tone] : null
      return React.createElement(
        'div',
        {
          style: {
            minWidth: 0,
            padding: '10px 11px',
            borderRadius: 10,
            border: '1px solid var(--dsw-alias-border-l2)',
            background: 'var(--dsw-alias-bg-layer-2)',
          },
        },
        React.createElement(
          'div',
          { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' } },
          props.label,
        ),
        React.createElement(
          'div',
          { style: { marginTop: 4, color: tone || 'var(--dsw-alias-label-primary)', fontSize: 16, fontWeight: 700, lineHeight: 1.2, fontVariantNumeric: 'tabular-nums' } },
          props.value,
        ),
        props.detail
          ? React.createElement(
              'div',
              { style: { marginTop: 4, color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, lineHeight: 1.35, wordBreak: 'break-word' } },
              props.detail,
            )
          : null,
      )
    }

    function Row(props) {
      var tone = props.tone ? TONE_TOKEN[props.tone] : null
      if (props.tone && !tone) throw new Error('unknown status tone: ' + props.tone)
      return React.createElement(
        'div',
        { style: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '5px 0' } },
        React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, props.label),
        React.createElement(
          'span',
          { style: { color: tone || 'var(--dsw-alias-label-primary)', textAlign: 'right' } },
          props.value,
        ),
      )
    }

    /**
     * A labelled text input for the schedule form.
     *
     * Kept local because the bundle has no component library and a plain input is
     * the whole requirement.
     */
    function Field(props) {
      return React.createElement(
        'label',
        { style: { display: 'block', margin: '6px 0' } },
        React.createElement(
          'span',
          { style: { display: 'block', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
          props.label,
        ),
        React.createElement('input', {
          value: props.value,
          type: props.type || 'text',
          placeholder: props.placeholder || '',
          onChange: function (event) {
            props.onChange(event.target.value)
          },
          style: {
            width: '100%',
            boxSizing: 'border-box',
            marginTop: 2,
            padding: '4px 6px',
            background: 'var(--dsw-alias-bg-layer-2)',
            color: 'var(--dsw-alias-label-primary)',
            border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: 4,
            font: 'inherit',
          },
        }),
      )
    }

    function Button(props) {
      return React.createElement(
        'button',
        {
          type: 'button',
          disabled: props.disabled ? true : undefined,
          onClick: props.onClick,
          title: props.title,
          'aria-label': props['aria-label'],
          'aria-busy': props.busy ? true : undefined,
          style: {
            minHeight: 30,
            padding: props.compact ? '3px 8px' : '5px 10px',
            marginRight: 6,
            borderRadius: 7,
            border: '1px solid var(--dsw-alias-border-l2)',
            background: props.primary ? 'var(--dsw-alias-bg-layer-3)' : 'var(--dsw-alias-bg-layer-2)',
            color: props.disabled ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-label-primary)',
            cursor: props.disabled ? 'default' : 'pointer',
            font: 'inherit',
            fontSize: 12,
            fontWeight: props.primary ? 600 : 500,
            transition: 'border-color 120ms ease, background 120ms ease, transform 120ms ease',
          },
        },
        props.children,
      )
    }

/** How often the shut pill refreshes itself: slower than the open panel, never stopped. */
    var MINI_POLL_MS = 2000
    /**
     * The preference shape, bumped whenever the window's own size changes.
     *
     * Version 3's 260×180 was the built-in default until the pet was redrawn at 286×216. A stored
     * size is the human's decision and outlives a redesign, so the reset is keyed on the *old default*
     * rather than on the version number alone: a footprint somebody dragged to by hand is kept, and
     * only the window nobody ever resized follows the new design.
     */
    var MINI_SIZE_VERSION = 4
    var MINI_DEFAULT_WIDTH = 286
    var MINI_DEFAULT_HEIGHT = 216
    var MINI_LEGACY_DEFAULT_WIDTH = 260
    var MINI_LEGACY_DEFAULT_HEIGHT = 180
    var MINI_LEGACY_SIZE_VERSION = 3
    var MINI_MIN_WIDTH = 240
    var MINI_MIN_HEIGHT = 170
    /** The shut control: a rounded square, so the status dot can still show in the corner. */
    var MINI_PILL_SIZE = 44
    var MINI_PILL_RADIUS = 15
    var MINI_MARGIN = 14
    var MINI_TOP_SAFE = 72

    /**
     * Where the floating window remembers that it was shut.
     *
     * Storage is best-effort. A browser that refuses it leaves the window open, which is the
     * harmless direction: being shut is a preference, and nothing depends on it.
     */
    function miniPref(key) {
      try {
        var raw = window.localStorage.getItem('dsh-den.mini')
        if (!raw) return undefined
        return JSON.parse(raw)[key]
      } catch (e) { return undefined }
    }

    function setMiniPref(key, value) {
      try {
        var raw = window.localStorage.getItem('dsh-den.mini')
        var prefs = raw ? JSON.parse(raw) : {}
        prefs[key] = value
        window.localStorage.setItem('dsh-den.mini', JSON.stringify(prefs))
      } catch (e) { void e }
    }

    function DenPanel(props) {
      var t = props.t
      var state = React.useState({ phase: 'loading', data: null, error: null })
      var view = state[0]
      var setView = state[1]

      /* Action feedback is kept separate from the snapshot so a failed click never
       * blanks the numbers the human is looking at. */
      var actionState = React.useState({ busy: null, error: null, note: null, token: null })
      var action = actionState[0]
      var setAction = actionState[1]

      // Offline harnesses have no DOM, so the only way to observe internal state
      // from a test is to let the host inject a sink. Harmless in the shell: with no
      // sink installed this is a no-op.
      var sink = (typeof window !== 'undefined' && window.__dshDenDebug) || null

      var schedState = React.useState({ list: [], error: null })
      var sched = schedState[0]
      var setSched = schedState[1]

      var formState = React.useState({ title: '', prompt: '', minutes: '30' })
      var form = formState[0]
      var setForm = formState[1]

      /* Whether the self-check form is open in the dock.
       *
       * Collapsed by default, and that is a correction rather than a preference. The dock sits
       * in the conversation, directly above the message box, and a permanently open form — three
       * labelled inputs and a button — is what made this panel cost the human half the screen.
       * The state is declared here rather than inside `schedulesBlock` so the hook is
       * unconditional: that block is called from both seats, and only the dock can create. */
      var schedOpenState = React.useState(false)
      var schedOpen = schedOpenState[0]
      var setSchedOpen = schedOpenState[1]

      /**
       * The technical half of the panel, folded away by default.
       *
       * The user's report: "你这个 den 的状态有点复杂了". The rows were all true and none of them
       * were readable at a glance — residency, ledger, approval gate and memory scenarios are the
       * words of this plugin's insides, not of a person deciding whether to let it act. Folding them
       * is not hiding them: the measurements are one press away, for whoever wants to audit.
       */
      var detailOpenState = React.useState(false)
      var detailOpen = detailOpenState[0]
      var setDetailOpen = detailOpenState[1]

      var sessionId = props.sessionId
      var act = props.act
      /**
       * Compact mode renders only what needs a conversation, for the floating window.
       *
       * The seat is `shell.overlay`: session-scoped, outside every conversation frame, and its live
       * catalog lists `sessionId: SessionId` among the standard props. That is the whole reason the
       * control can work at all - a status page in `main` has no conversation to name.
       *
       * This used to say `conversation.input.dock`, a seat ① removed; the code moved and the comment
       * did not. Left visible on purpose: a comment that explains a real decision is trusted, so a
       * stale one is worse than none.
       */
      var compact = !!props.compact
      var stripOnly = !!props.stripOnly

      var load = React.useCallback(function () {
        setView(function (prev) {
          return { phase: prev.data ? 'refreshing' : 'loading', data: prev.data, error: null }
        })
        props
          .act('status', {}, sessionId)
          .then(function (value) {
            setView({ phase: 'ready', data: value, error: null })
          })
          .catch(function (error) {
            setView(function (prev) {
              return { phase: 'error', data: prev.data, error: String((error && error.message) || error) }
            })
          })
      }, [sessionId])

      React.useEffect(function () {
        load()
        var timer = setInterval(load, 15000)
        return function () {
          clearInterval(timer)
        }
      }, [load])

      var loadSchedules = React.useCallback(function () {
        // No conversation is no longer a reason to show nothing: the host answers with every
        // schedule when none is bound (panel-api: `liveSessionId ? filter : all`), and with the
        // composer dock gone this is the only place the list can be seen at all.
        act('schedules/list', {}, sessionId)
          .then(function (value) {
            setSched({ list: (value && value.schedules) || [], error: null })
          })
          .catch(function (error) {
            setSched({ list: [], error: String((error && error.message) || error) })
          })
      }, [act, sessionId])

      React.useEffect(function () {
        loadSchedules()
      }, [loadSchedules])

      /** Run one panel action, keeping every failure visible instead of silent. */
      function run(kind, promise) {
        if (sink) sink({ phase: 'run', kind: kind })
        setAction({ busy: kind, error: null, note: null, token: null })
        return promise
          .then(function (value) {
            // Report only the shape of the reply, never its contents. An earlier
            // version handed the whole value to the sink, which meant the freshly
            // minted autonomy token was written to a page-global hook for no reason:
            // a script that could install the sink could already read the token off
            // the screen, so there was nothing to gain and a secret to leak.
            if (sink) sink({ phase: 'resolved', kind: kind, keys: value && typeof value === 'object' ? Object.keys(value) : null })
            setAction({ busy: null, error: null, note: null, token: null })
            return value
          })
          .catch(function (error) {
            if (sink) sink({ phase: 'rejected', kind: kind, error: String((error && error.message) || error) })
            setAction({ busy: null, error: String((error && error.message) || error), note: null, token: null })
            return null
          })
      }

      function onGrant(want) {
        run('grant', act('autonomy/request', { autonomy: want }, sessionId)).then(function (value) {
          if (!value) return
          setAction({ busy: null, error: null, note: 'requested', token: value.token })
          // The request is only a request: the snapshot still reports the truth
          // until the token is confirmed in the conversation.
          load()
        })
      }

      /**
       * "Read it" — the human says they saw what the den said while they were away.
       *
       * This is the only thing that marks a notice delivered, and it has to come from the human:
       * a panel render is not a human reading it, so inferring one from the other would make the
       * count lie in the opposite direction to the bug it fixes.
       */
      function onAckNotice(id) {
        run('notice', act('notices/ack', { id: id }, sessionId)).then(function () { load() })
      }

      function onAddSchedule() {
        var minutes = Number(form.minutes)
        if (!form.title || !form.prompt) {
          setAction({ busy: null, error: 'a schedule needs a title and a prompt', note: null, token: null })
          return
        }
        if (!isFinite(minutes) || minutes < 5) {
          setAction({ busy: null, error: 'interval must be at least 5 minutes', note: null, token: null })
          return
        }
        run('schedule', act('schedules/create', {
          kind: 'interval',
          title: form.title,
          prompt: form.prompt,
          everySeconds: Math.round(minutes * 60),
        }, sessionId)).then(function (value) {
          if (!value) return
          setForm({ title: '', prompt: '', minutes: form.minutes })
          loadSchedules()
          load()
        })
      }

      function onRemoveSchedule(id) {
        run('schedule', act('schedules/delete', { id: id }, sessionId)).then(function (value) {
          if (!value) return
          loadSchedules()
          load()
        })
      }

      var d = view.data
      var busy = action.busy !== null

      /**
       * The self-check block, shared by both seats because it has the same problem as the grant: a
       * self-check belongs to a conversation (`schedules/create` refuses without one), so the form is
       * only useful where a conversation is known. The status page shows the list and says where the
       * form is; the dock above the message box shows both.
       */
      function schedulesBlock(withForm) {
        /**
         * One-tap presets — see DESIGN §2.39.
         *
         * The form asks for a title, a prompt and a number of seconds, which is three things to type
         * before anything happens. Whoever wants a custom check still gets the form; whoever just
         * wants the den to check on something should not have to write a prompt to do it.
         *
         * They go through `schedules/create`, the same action the form submits, so a preset cannot
         * slip past a rule the form obeys (the five-minute floor included). A preset that created
         * whatever it liked would be a second, quieter set of rules.
         */
        var presets = [
          { title: '每天看一眼 CI 失败', prompt: '检查最近一次 CI 是否失败：失败就报告失败的那一步和链接；全绿就保持沉默，不要报喜。', everySeconds: 86400 },
          { title: '每周一清点待办', prompt: '看一眼这周还没收尾的事（没做完的任务、挂着没人管的问题），只列出来，不要动手。', everySeconds: 604800 },
        ]
        function createPreset(preset) {
          run('schedule-preset', act('schedules/create', {
            kind: 'interval',
            title: preset.title,
            prompt: preset.prompt,
            everySeconds: preset.everySeconds,
            sessionId: sessionId,
          }, sessionId)).then(function () { load() })
        }
        return React.createElement(
          'div',
          { style: { marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--dsw-alias-border-l2)' } },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7 } },
            React.createElement('span', { 'aria-hidden': true, style: { width: 6, height: 6, borderRadius: 999, background: 'var(--dsw-alias-state-success-primary)' } }),
            React.createElement('span', { style: { fontSize: 12, fontWeight: 700, color: 'var(--dsw-alias-label-primary)' } }, t('schedules')),
          ),
          sched.list.length === 0
            ? React.createElement(
                'div',
                null,
                React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, t('scheduleNone')),
                // Only where a conversation is known: a preset has to say where to report back.
                sessionId
                  ? React.createElement(
                      'div',
                      { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 } },
                      presets.map(function (preset) {
                        return React.createElement(
                          Button,
                          {
                            key: preset.title,
                            disabled: busy,
                            onClick: function () { createPreset(preset) },
                          },
                          preset.title,
                        )
                      }),
                    )
                  : null,
              )
            : React.createElement(
                'div',
                null,
                sched.list.map(function (item) {
                  return React.createElement(
                    'div',
                    { key: item.id, style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '3px 0' } },
                    React.createElement(
                      'span',
                      { style: { fontSize: 12, color: 'var(--dsw-alias-label-primary)' } },
                      item.title + (item.dueNow ? ' · ' + t('dueNow') : ''),
                    ),
                    React.createElement(Button, {
                      // Deleting needs no conversation: the host removes by schedule id, and with the
                      // composer dock gone this is the only surface the list can be seen on at all.
                      disabled: busy,
                      onClick: function () { onRemoveSchedule(item.id) },
                    }, t('scheduleRemove')),
                  )
                }),
              ),
          withForm
            ? React.createElement(
                'div',
                null,
                // One row by default. The form is behind a disclosure because the dock lives in
                // the conversation: the human came here to talk, not to fill in a form, and the
                // capability does not need to be on screen to exist. Asking in the message box
                // works too, which is what the empty-state line says.
                React.createElement(Button, {
                  disabled: busy || !sessionId,
                  onClick: function () { setSchedOpen(!schedOpen) },
                }, t(schedOpen ? 'scheduleClose' : 'scheduleNew')),
                schedOpen
                  ? React.createElement(
                      'div',
                      null,
                      React.createElement(Field, {
                        label: t('scheduleTitle'),
                        value: form.title,
                        onChange: function (value) { setForm({ title: value, prompt: form.prompt, minutes: form.minutes }) },
                      }),
                      React.createElement(Field, {
                        label: t('schedulePrompt'),
                        value: form.prompt,
                        onChange: function (value) { setForm({ title: form.title, prompt: value, minutes: form.minutes }) },
                      }),
                      React.createElement(Field, {
                        label: t('scheduleMinutes'),
                        type: 'number',
                        value: form.minutes,
                        onChange: function (value) { setForm({ title: form.title, prompt: form.prompt, minutes: value }) },
                      }),
                      React.createElement(Button, {
                        primary: true,
                        disabled: busy || !sessionId,
                        onClick: onAddSchedule,
                      }, t('scheduleAdd')),
                    )
                  : null,
              )
            : React.createElement(
                'div',
                { style: { fontSize: 12, color: 'var(--dsw-alias-state-warn-primary)' } },
                React.createElement('div', null, t('howToAsk')),
                React.createElement(
                  'div',
                  { style: { marginTop: 4, color: 'var(--dsw-alias-label-tertiary)' } },
                  t('scheduleAddElsewhere'),
                ),
                // This used to live in the creation form, which is unreachable now, so the one
                // thing it says that still matters to a reader was going to disappear with it.
                React.createElement(
                  'div',
                  { style: { marginTop: 4, fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } },
                  t('scheduleCreateHint'),
                ),
              ),
        )
      }

      /**
       * What the den said while nobody was asking, rendered where the human actually looks.
       *
       * Measured defect (2026-10-14, reported by the user reading this very strip): a wake spoke, the
       * page reported `Pending notices 1 / 1`, and no surface in the product showed the text. The
       * count told the human that something had happened and nothing told them what. The same defect
       * made the count permanent: nothing could mark a notice delivered, so it stayed pending for
       * ever. Both halves are fixed here and in `notices.js`, and they are the same fix seen from two
       * ends — a notice only reaches zero once a human has read it and said so.
       */
      function noticesBlock() {
        var owed = (d && d.notices && d.notices.pending) || []
        if (!owed.length) return null
        return React.createElement(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 8,
              padding: '9px 11px',
              fontSize: 12,
              borderLeft: '3px solid var(--dsw-alias-state-warn-primary)',
              borderRadius: 8,
              background: 'var(--dsw-alias-bg-layer-2)',
              color: 'var(--dsw-alias-label-secondary)',
            },
          },
          React.createElement('span', { style: { color: 'var(--dsw-alias-label-primary)' } }, t('noticesOwed')),
          React.createElement(
            'span',
            { style: { flex: '1 1 200px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            owed[0].text,
          ),
          owed.length > 1
            ? React.createElement('span', null, '+' + String(owed.length - 1))
            : null,
          React.createElement(Button, { onClick: function () { onAckNotice(owed[0].id) } }, t('noticeReadIt')),
        )
      }

      /**
       * Compact mode: only the controls that need a conversation, in the seat that supplies one.
       *
       * The minted token is shown here rather than anywhere else because this strip sits directly
       * above the message box, which is where the human has to paste it - the grant is not complete
       * until a human message carries the token, so the control ends where the evidence begins.
       */
      if (compact) {
        var known = Boolean(d) && d.autonomyKnown !== false
        var granted = known && Boolean(d.autonomy)
        /**
         * Granted, this strip shrinks to one line and keeps no controls at all.
         *
         * It sits directly above the composer in every conversation, so a strip that keeps
         * offering buttons after the decision is already made is not a control any more - it is the
         * furniture the person has to look past every time they type. Revoking stays one click away:
         * the floating window and the main view both live outside any single conversation and carry
         * the full controls, so nothing is lost by taking them off this row.
         */
        if (granted) {
          return React.createElement(
            'div',
            { style: { margin: '4px 8px', padding: '7px 10px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8 } },
            React.createElement('span', null, t('grantDock') + ' ' + String.fromCharCode(183) + ' ' + t('grantDockGranted')),
          )
        }
        return React.createElement(
          'div',
          { style: { margin: '4px 8px', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8 } },
          React.createElement(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'baseline',
                flexWrap: 'wrap',
                gap: 8,
                padding: '8px 10px',
                fontSize: 12,
                color: 'var(--dsw-alias-label-secondary)',
              },
            },
          React.createElement('span', { style: { color: 'var(--dsw-alias-label-primary)' } }, t('grantDock')),
          React.createElement('span', null, !known ? t('grantDockUnknown') : granted ? t('grantDockGranted') : t('grantDockNotGranted')),
          React.createElement(Button, {
            primary: !granted,
            // Minting needs no conversation: the token is carried to one by the human, and the grant
            // is confirmed there. Demanding a session id here is exactly what made the floating
            // window read-only, which is why the controls had to live in the composer instead.
            disabled: busy,
            onClick: function () { onGrant(true) },
          }, t('autonomyGrant')),
          React.createElement(Button, {
            disabled: busy || !sessionId,
            onClick: function () { onGrant(false) },
          }, t('autonomyRevoke')),
          /**
           * The token is shown only while it is still an open invitation.
           *
           * Measured defect (2026-10-14, the user's screenshot): after the grant had landed — the
           * state row read "granted for this conversation" — this strip still displayed the spent
           * token and told the human to paste it as their next message. The token is single-use, so
           * the instruction was already impossible to follow, and the two lines contradicted each
           * other. `granted` comes from the host snapshot, which is the same thing the row above
           * reports, so the strip cannot disagree with itself.
           */
          action.token && !granted
            ? React.createElement(
                'span',
                { style: { display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%' } },
                React.createElement(
                  'code',
                  { style: { padding: '2px 6px', borderRadius: 4, background: 'var(--dsw-alias-bg-layer-2)', userSelect: 'all', wordBreak: 'break-all' } },
                  action.token,
                ),
                copyControl(t, action.token, action.note, function (next) {
                  setAction(Object.assign({}, action, { note: next }))
                }),
              )
            : null,
          action.token && !granted
            ? React.createElement('span', { style: { flexBasis: '100%' } }, t('autonomyTokenHint'))
            : null,
          action.error
            ? React.createElement('span', { style: { flexBasis: '100%', color: 'var(--dsw-alias-state-warn-primary)' } }, action.error)
            : null,
          ),
          stripOnly ? null : noticesBlock(),
          stripOnly ? null : schedulesBlock(Boolean(sessionId)),
        )
      }

      var gateMounted = Boolean(d && d.gate && d.gate.mounted)
      var headerKernelTone = !d || d.kernelDeferred || !(d.kernel && d.kernel.running)
        ? 'error'
        : d.residency && d.residency.held === false
          ? 'warn'
          : 'success'
      var headerKernelLabel = !d
        ? t('unavailable')
        : d.kernelDeferred
          ? t('kernelWaiting')
          : d.kernel && d.kernel.running
            ? t('residentOn')
            : t('residentOff')
      var headerKernelDetail = d && d.kernel && d.kernel.lastTickAt ? t('lastTick') + ' ' + fmtTime(d.kernel.lastTickAt, t) : null
      var children = [
        React.createElement(
          'div',
          {
            key: 'hero',
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              padding: '2px 0 14px',
              borderBottom: '1px solid var(--dsw-alias-border-l2)',
            },
          },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'flex-start', gap: 10 } },
            React.createElement(
              'div',
              {
                'aria-hidden': true,
                style: {
                  display: 'grid',
                  placeItems: 'center',
                  flex: '0 0 auto',
                  width: 34,
                  height: 34,
                  borderRadius: 10,
                  background: 'var(--dsw-alias-bg-layer-3)',
                  border: '1px solid var(--dsw-alias-border-l2)',
                  color: 'var(--dsw-alias-state-success-primary)',
                  fontSize: 18,
                  fontWeight: 700,
                },
              },
              '◈',
            ),
            React.createElement(
              'div',
              { style: { minWidth: 0, flex: '1 1 auto' } },
              React.createElement('div', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em' } }, t('panelEyebrow')),
              React.createElement('h2', { style: { margin: '3px 0 2px', fontSize: 18, lineHeight: 1.2, letterSpacing: '-0.02em', color: 'var(--dsw-alias-label-primary)' } }, t('title')),
              React.createElement('div', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: 1.45 } }, t('panelSubtitle')),
            ),
            React.createElement(
              Button,
              {
                compact: true,
                onClick: load,
                busy: view.phase === 'refreshing',
                title: t('refresh'),
                'aria-label': t('refresh'),
              },
              view.phase === 'refreshing' ? '…' : '↻',
            ),
          ),
          React.createElement(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: 7 } },
            React.createElement(StatusBadge, { tone: headerKernelTone, label: headerKernelLabel, detail: headerKernelDetail }),
            React.createElement(StatusBadge, {
              tone: gateMounted ? 'success' : 'warn',
              label: gateMounted ? t('gateArmed') : t('gateDirect'),
              detail: gateMounted ? null : t('gateDirectHint'),
            }),
          ),
        ),
      ]

      if (view.phase === 'error') {
        children.push(
          React.createElement(
            'div',
            { key: 'e', style: { color: 'var(--dsw-alias-state-error-primary)', margin: '8px 0' } },
            t('unavailable') + ': ' + view.error,
          ),
        )
      }

      if (action.error) {
        children.push(
          React.createElement('div', { key: 'ae', style: { color: 'var(--dsw-alias-state-error-primary)', margin: '8px 0', fontSize: 12 } }, action.error),
        )
      }
      if (busy) {
        children.push(
          React.createElement('div', { key: 'ab', style: { color: 'var(--dsw-alias-label-secondary)', margin: '8px 0', fontSize: 12 } }, t('working')),
        )
      }
      if (action.token) {
        children.push(
          React.createElement(
            'div',
            { key: 'tok', style: { margin: '8px 0', padding: 8, background: 'var(--dsw-alias-bg-layer-2)', borderRadius: 4, fontSize: 12 } },
            React.createElement('div', { style: { color: 'var(--dsw-alias-state-warn-primary)' } }, t('autonomyCopied')),
            React.createElement(
              'div',
              { style: { display: 'flex', alignItems: 'flex-start', gap: 8, margin: '4px 0' } },
              React.createElement(
                'code',
                { style: { flex: '1 1 auto', minWidth: 0, wordBreak: 'break-all', color: 'var(--dsw-alias-label-primary)' } },
                action.token,
              ),
              copyControl(t, action.token, action.note, function (next) {
                setAction(Object.assign({}, action, { note: next }))
              }),
            ),
            React.createElement('div', { style: { color: 'var(--dsw-alias-label-secondary)' } }, t('autonomyTokenHint')),
          ),
        )
      }

      if (d) {
        var autonomyText = d.autonomyKnown ? (d.autonomy ? t('autonomyOn') : t('autonomyOff')) : t('autonomyUnknown')
        var autonomyTone = d.autonomyKnown ? (d.autonomy ? 'success' : 'warn') : null
        var scenarios = (d.scenarios || []).map(function (s) {
          return s.scenario + ' (' + s.entries + ')'
        })

        var kernelValue
        var kernelTone = 'success'
        if (d.kernel && d.kernel.running) {
          kernelValue = t('kernelOn') + ' · ' + t('lastTick') + ' ' + fmtTime(d.kernel.lastTickAt, t)
          // Standing down is not failing. A host that is running and deliberately not delivering
          // is the correct state when another host holds residency, and reporting it as an error
          // would send the operator hunting a fault that is not there.
          if (d.residency && d.residency.held === false) {
            kernelTone = 'warn'
            kernelValue = t('kernelStandby') + (d.residency.holderPid ? ' (pid ' + String(d.residency.holderPid) + ')' : '')
          }
        } else if (d.kernelDeferred) {
          // The heartbeat being absent is the single most important thing this
          // panel can report: it means the assistant is not resident.
          kernelTone = 'error'
          kernelValue = d.kernelDeferred.retrying
            ? t('kernelWaiting') + ' (' + String(d.kernelDeferred.attempts || 0) + '/' + '24)'
            : t('kernelGaveUp') + ' ' + String(d.kernelDeferred.attempts || 0) + ' ' + t('attempts')
        } else {
          kernelTone = 'error'
          kernelValue = t('kernelOff')
        }

        var owedCount = d && d.notices && d.notices.pending ? d.notices.pending.length : 0
        var running = Boolean(d && d.kernel && d.kernel.running)

        /**
         * Anything other than "fine" opens the measurements by itself.
         *
         * Folding the rows must not hide a fault: a stopped heartbeat, a deferred wake, a host that
         * stood down or a process older than the code it serves are exactly the states a person has
         * to see without knowing to look. Only the healthy case stays collapsed.
         */
        var abnormal =
          !running ||
          Boolean(d && d.kernelDeferred) ||
          Boolean(d && d.residency && d.residency.held === false) ||
          Boolean(d && d.freshness && d.freshness.stale)

        /**
         * The signal rail is the focal point of the page: four quiet cards answer the useful questions
         * without making the operator decode a paragraph of dots. The values stay short, while the
         * detail line carries the timestamp, budget or recovery hint that makes each number actionable.
         */
        var taskMetric = d && d.tasks && Number(d.tasks.total) > 0 && Number.isFinite(d.tasks.active)
          ? React.createElement(Metric, {
              label: t('tasksShort'),
              value: t('tasksShort') + ' ' + String(d.tasks.active),
              detail:
                (Number(d.tasks.blocked) > 0 ? t('tasksStuck') + ' ' + String(d.tasks.blocked) : '') +
                (Number(d.tasks.waiting) > 0 ? (Number(d.tasks.blocked) > 0 ? ' · ' : '') + t('tasksWaiting') + ' ' + String(d.tasks.waiting) : ''),
              tone: Number(d.tasks.blocked) > 0 ? 'warn' : 'success',
            })
          : null
        children.push(
          React.createElement(
            'div',
            {
              key: 'signals',
              'aria-label': t('panelSubtitle'),
              style: {
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))',
                gap: 8,
                margin: '14px 0 8px',
              },
            },
            React.createElement(Metric, {
              label: t('kernel'),
              value: running ? t('kernelOn') : d.kernelDeferred ? t('kernelWaiting') : t('kernelOff'),
              detail: running ? t('lastTick') + ' ' + fmtTime(d.kernel && d.kernel.lastTickAt, t) : kernelValue,
              tone: kernelTone,
            }),
            React.createElement(Metric, {
              label: t('autonomy'),
              value: autonomyText,
              detail: gateMounted ? t('gateArmedHint') : t('gateDirectHint'),
              tone: autonomyTone || 'warn',
            }),
            React.createElement(Metric, {
              label: t('turns'),
              value: t('wokeShort') + ' ' + String((d && d.ledger && d.ledger.turns) || 0),
              detail: d.dailyTurnBudget ? t('budgetShort') + ' ' + String((d.ledger && d.ledger.turns) || 0) + '/' + String(d.dailyTurnBudget) : t('budgetOff'),
            }),
            React.createElement(Metric, {
              label: t('notices'),
              value: t('owedShort') + ' ' + String(owedCount),
              detail: owedCount ? t('noticesOwed') : t('none'),
              tone: owedCount ? 'warn' : undefined,
            }),
            taskMetric,
            React.createElement(
              'div',
              { style: { gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, minHeight: 30 } },
              React.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 } }, t('details')),
              React.createElement(
                Button,
                { compact: true, onClick: function () { setDetailOpen(!detailOpen) }, 'aria-label': t('details') },
                detailOpen ? t('scheduleClose') : t('details'),
              ),
            ),
          ),
          noticesBlock(),
        )

        if (detailOpen || abnormal) {
          children.push(
            React.createElement(
              'div',
              { key: 'rows', style: { marginTop: 6 } },
              React.createElement(Row, { label: t('autonomy'), value: autonomyText, tone: autonomyTone }),
              React.createElement(Row, { label: t('nextCheck'), value: fmtTime(d.nextCheckAt, t) }),
              React.createElement(Row, { label: t('turns'), value: String((d.ledger && d.ledger.turns) || 0) }),
              React.createElement(Row, {
                label: t('notices'),
                value: (d.notices ? d.notices.deliverable : 0) + ' / ' + (d.notices ? d.notices.total : 0),
              }),
              React.createElement(Row, {
                label: t('gate'),
                value: gateMounted ? t('gateMounted') : t('gateUnmounted'),
                tone: gateMounted ? 'success' : 'warn',
              }),
              React.createElement(Row, {
                label: t('kernel'),
                value: kernelValue,
                tone: kernelTone,
              }),
              React.createElement(Row, { label: t('scenarios'), value: scenarios.length ? scenarios.join(', ') : t('none') }),
            ),
          )
        }

        /**
         * Whether the process drawing this panel loaded the code it is drawn from.
         *
         * Not a diagnostic for the den's own work: it is here because a panel that looks
         * healthy is exactly what makes a stale host invisible. The restart that fixes it is
         * the human's to make, so the fact has to reach the human, in the one place they are
         * already looking. An instance that cannot judge itself says so rather than reading
         * as current — `known: false` is not a pass.
         */
        var fresh = d && d.freshness ? d.freshness : null
        children.push(
          React.createElement(Row, {
            key: 'fresh',
            label: t('codeFreshness'),
            value: !fresh || fresh.known !== true
              ? t('freshUnknown')
              : fresh.stale
                ? t('freshStale') + ' · ' + String(fresh.newestSourceFile ?? '')
                : t('freshCurrent'),
            tone: fresh && fresh.known === true && fresh.stale ? 'warn' : undefined,
          }),
        )

        if (d.reapedTempFiles) {
          children.push(React.createElement(Row, { key: 'r', label: t('recovered'), value: String(d.reapedTempFiles) }))
        }
        if (d.reapedNotices) {
          children.push(
            React.createElement(Row, {
              key: 'rn',
              label: t('reapedNotices'),
              value: String(d.reapedNotices),
            }),
          )
        }
        if (d.kernel && d.kernel.lastError) {
          children.push(
            React.createElement(
              'div',
              { key: 'err', style: { marginTop: 6, color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 } },
              t('errors') + ': ' + d.kernel.lastError,
            ),
          )
        }

        /* ------------------------------------------------------- controls */

        // Compact mode returned above, so this page is never the one holding a conversation - and it
        // should not pretend otherwise. `main` is root-scoped and keyed, and its own catalog says only
        // the reserved `conversation` key receives a Session binding. The old version tried to discover
        // one anyway through `props.useSessions()` (a selector hook, called with no selector) and the
        // `sessions.current()` / `sessions.activeId()` pair - methods the live service does not
        // have, so all three returned nothing while a test double written from the same assumption
        // said success. The token `ctx` is deliberately absent here: the bundle check greps the
        // source for `ctx.<service>` to prove every service read is declared, and a comment is not a read.
        children.push(
          React.createElement(
            'div',
            { key: 'grant-where', style: { marginTop: 14, paddingTop: 10, borderTop: '1px solid var(--dsw-alias-border-l2)', fontSize: 12, color: 'var(--dsw-alias-state-warn-primary)' } },
            t('autonomyNoSession'),
          ),
        )

        children.push(schedulesBlock(false))
      }

      children.push(
        React.createElement(
          'div',
          { key: 'foot', style: { marginTop: 12, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } },
          t('footNote'),
        ),
      )

      return React.createElement(
        'div',
        {
          style: {
            padding: 18,
            background: 'var(--dsw-alias-bg-layer-1)',
            border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: 12,
            boxShadow: '0 12px 28px rgba(0,0,0,.12)',
            fontFamily: 'inherit',
            lineHeight: 1.4,
            maxWidth: 640,
          },
        },
        children,
      )
    }

    function Icon(props) {
      var size = (props && props.size) || 20
      return React.createElement(
        'span',
        { 'aria-hidden': true, style: { fontSize: size * 0.85 + 'px', lineHeight: 1 } },
        '\u25C8',
      )
    }

    /* -------------------------------------------------------------- plugin */

    function apply(ctx) {
      var lifetime = new AbortController()
      var locale = ctx.locale

      if (locale && typeof locale.register === 'function') {
        ctx.effect(function () {
          return locale.register(NS, STRINGS)
        })
      }

      function t(key) {
        var table = pick(locale && typeof locale.locale === 'function' ? locale.locale() : undefined)
        return (table && table[key]) || (STRINGS.en[key] || key)
      }

      /**
       * Reach the host half over the one channel this profile's plugins actually use.
       *
       * Every client half installed here — dsh-warden, dsh-daily, dsh-vision-diff,
       * dsh-in-hand, dsh-ship-receipt, dsh-signal-pet, dsh-taskwatch, dsh-holdem —
       * talks to its host with a plain browser `fetch()` against a `/<package name>`
       * route the host registered on the web server. Not one of them uses a
       * framework RPC shim.
       *
       * This bundle previously did, twice. First `ctx.connection.rpc.call('/api', …)`
       * and `inject: ['connection']`: that shape was invented here — the host
       * `connection` contract is `{rpc, fetch, operator}` where `HostConnectionRpc`
       * is `{handle, intercept}`, the client service catalog does not list
       * `connection` at all, and the method name `call` appears nowhere but this
       * repository's own test fake. Then `host.call`, which is at least published but
       * likewise unused by any plugin here, paired with a route on
       * `connection.fetch.register` under `/api` — where the host half was
       * observable but nothing demonstrated a browser could reach it.
       *
       * The lesson worth keeping: being the only one of nine plugins to do something
       * a different way is not a neutral choice. Both harnesses passed throughout,
       * because they were written from the same assumption as the code.
       */
      function call(action, payload, sessionId) {
        var body = { action: action }
        for (var key in payload || {}) body[key] = payload[key]
        if (sessionId) body.sessionId = sessionId

        var signal = null
        if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
          var budget = AbortSignal.timeout(15000)
          /**
           * `any` and `timeout` are separate APIs with separate availability: `timeout`
           * landed in Chrome 103 and `any` not until 116, so a shell in between has the
           * first and not the second.
           *
           * The original guard tested `timeout` and then called `any` unconditionally,
           * which turns a missing `any` into a `TypeError` thrown on every request. It
           * was invisible to all three harnesses because each injects the host's own
           * `AbortSignal`, where both methods exist — the same shape of mistake as the
           * rest of this file's history: the fake stood in for the caller with
           * capabilities the real caller is not guaranteed to have.
           *
           * Composing is a nicety (cancel on unmount *and* on timeout). Timing out is
           * the requirement, so `timeout` alone is the correct degradation.
           */
          signal =
            typeof AbortSignal.any === 'function' && lifetime
              ? AbortSignal.any([lifetime.signal, budget])
              : budget
        }

        return fetch(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: signal || undefined,
        }).then(function (res) {
          /**
           * Read the status before the body, and keep the status in the message.
           *
           * A refused action is a 200 with `ok: false` - the panel renders the
           * reason. A transport-level failure is a different kind of thing and must
           * not arrive looking like one: a bare `res.json()` on a 404 (the route is
           * not mounted) or on an HTML error page rejects with a JSON syntax error,
           * which tells the human nothing about the host. That is precisely the
           * state the panel is in before its host half has been restarted, so this
           * message is the one that has to be readable.
           */
          return res.text().then(function (raw) {
            var reply
            try {
              reply = JSON.parse(raw)
            } catch (parseError) {
              var httpError = new Error(
                'the host answered HTTP ' + res.status + ' but not with JSON' +
                  (res.ok ? '' : ' - the route ' + API + ' may not be mounted yet'),
              )
              httpError.code = 'DEN_BAD_RESPONSE'
              httpError.status = res.status
              throw httpError
            }
            if (!reply || reply.ok !== true) {
              var err = (reply && reply.error) || {}
              var refusal = new Error(err.message || 'den status request failed')
              refusal.code = err.code
              refusal.status = res.status
              throw refusal
            }
            return reply.value
          })
        })
      }

      /**
       * One named action, carrying the current conversation where we know it.
       *
       * The active session id is read from the shell's own hook rather than
       * invented, because autonomy and schedules are both scoped per conversation
       * and a guessed id would silently target the wrong one.
       */
      /**
       * One shared status read for both seats.
       *
       * The panel polls `status` every 15s and the sidebar dot every 20s, so on a fresh page they fire
       * together and the same question is asked twice. Memoising at this layer means the second caller
       * joins the first caller's in-flight promise instead of issuing its own request, and any read
       * within ten seconds returns the same answer — without the two components having to know about
       * each other.
       *
       * What this does **not** buy: the two still poll on their own schedules, so they can still show
       * answers of different ages. Only a single poller feeding both would remove that, and it is not
       * what this is. Failures are deliberately **not** cached: a status read that failed must stay
       * visible to the next caller rather than being replayed as if it had succeeded.
       */
      var rawCall = call
      var statusMemo = { at: 0, value: null, inflight: null }
      call = function (action, payload, sessionId) {
        if (action !== 'status') return rawCall(action, payload, sessionId)
        if (statusMemo.inflight) return statusMemo.inflight
        if (statusMemo.value && Date.now() - statusMemo.at < 10000) {
          return Promise.resolve(statusMemo.value)
        }
        statusMemo.inflight = rawCall(action, payload, sessionId).then(
          function (value) {
            statusMemo.at = Date.now()
            statusMemo.value = value
            statusMemo.inflight = null
            return value
          },
          function (error) {
            statusMemo.inflight = null
            throw error
          },
        )
        return statusMemo.inflight
      }

      function act(action, payload, sessionId) {
        return call(action, payload, sessionId)
      }

      /**
       * Publish the transport for a harness, and only for a harness.
       *
       * `call` is the entire client half of the transport and it lives inside
       * `apply`, so every checker so far has had to reconstruct it from a fake —
       * written from the same assumption as the code, which is how three different
       * wrong shapes passed review in this plugin. A test that drives the real `call`
       * against the real host route cannot agree by construction.
       *
       * Gated on a flag no shipped page sets, so `module.exports` is unchanged in
       * production. Nothing is opened up here that a human could not already reach
       * by clicking a button: `call` is what the buttons call.
       */
      if (typeof window !== 'undefined' && window.__dshDenExposeInternals) {
        module.exports.__internals = { call: call, act: act, API: API }
      }

      ctx.effect(function () {
        return function () {
          lifetime.abort()
        }
      })

      // Keep a discoverable GUI entry in the shell sidebar. The floating pet is still the
      // always-on surface, but a resident assistant also needs a stable place a human can find
      // after the pill has been moved or collapsed. The id must match the main panel key or the
      // shell will render an icon that selects nothing.
      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_KEY, order: ORDER, label: function () { return t('nav') } },
          Icon,
        )
      })


    /**
     * The standing conversation, as the window shows it.
     *
     * This is what the window is for: den's own conversation, visible and talkable-to without opening
     * anything. The numbers the panel reports live on den's page — a status board is not something a
     * person talks to, and the window is the surface that is always on screen.
     */
    function DenConversation(props) {
      var t = props.t
      var state = React.useState({ phase: 'loading', data: null, error: null })
      var view = state[0]
      var setView = state[1]
      /**
       * What was sent but is not in the transcript yet.
       *
       * The host admits a prompt and logs the message later, so a read taken immediately after
       * sending can honestly come back without it. Without this, the window would show the human
       * their own sentence vanish and reappear a poll interval later, which reads as a lost message.
       */
      var waiting = React.useState([])
      var waitingText = waiting[0]
      var setWaiting = waiting[1]

      function load() {
        return act('conversation/read', { limit: 60 })
          .then(function (res) {
            var value = res && res.value !== undefined ? res.value : res
            if (value && typeof value === 'object') setView({ phase: 'ready', data: value, error: null })
          })
          .catch(function (error) {
            var message = String((error && error.message) || error)
            // An older Host answers every action it has never heard of with `unknown action`. That
            // is not the conversation failing: it is the host half not having been reloaded, and it
            // has a remedy a human can act on. Printing the host's error text teaches nothing.
            var older = /unknown action|not implemented|DEN_ACTION_FAILED/i.test(message)
            setView({ phase: older ? 'older' : 'error', data: null, error: message })
          })
      }

      React.useEffect(function () {
        var alive = true
        function pull() { if (alive) load() }
        pull()
        // Slower than the shut pill: while the window is open the human is reading it, and a
        // conversation does not need to be re-fetched as often as a status light needs to be lit.
        var timer = setInterval(pull, MINI_POLL_MS * 2)
        return function () {
          alive = false
          clearInterval(timer)
        }
      }, [])

      /**
       * The box lives at the window's foot, not here.
       *
       * This component used to carry one of its own, which put two inputs in a 286px window — the
       * one the transcript owned and the one the pet owns. The transcript keeps what was typed and
       * drops it the moment the log carries it, so the sentence is never drawn twice.
       */
      React.useEffect(function () {
        var incoming = props.sent
        if (!incoming || !incoming.at) return
        setWaiting(function (previous) {
          return previous.some(function (item) { return item.text === incoming.text }) ? previous : previous.concat([{ text: incoming.text, at: incoming.at }])
        })
      }, [props.sent])

      // The log is the authority: once it carries the sentence, the optimistic copy goes. Done in an
      // effect rather than inside `load` so it survives whatever order the render and the reply land in.
      React.useEffect(function () {
        var data = (view.data && typeof view.data === 'object' ? view.data : {}) || {}
        if (!Array.isArray(data.messages)) return
        var logged = data.messages
          .filter(function (message) { return message && message.role === 'user' })
          .map(function (message) { return String(message.text || '').trim() })
        setWaiting(function (previous) {
          var kept = previous.filter(function (item) { return logged.indexOf(String(item.text || '').trim()) < 0 })
          return kept.length === previous.length ? previous : kept
        })
      }, [view.data])

      /** Tell the window what this read found, so its box can be enabled or disabled on the truth. */
      React.useEffect(function () {
        if (typeof props.onPhase === 'function') props.onPhase(view.phase)
      }, [view.phase])

      var data = (view.data && typeof view.data === 'object' ? view.data : {}) || {}
      var messages = Array.isArray(data.messages) ? data.messages : []
      var loggedTexts = messages
        .filter(function (message) { return message && message.role === 'user' })
        .map(function (message) { return String(message.text || '').trim() })
      // Belt and braces with the effect above: a sentence the transcript already carries is never
      // drawn from here as well, whatever order the read and the render happen to land in.
      var waitingTexts = waitingText.filter(function (item) {
        return loggedTexts.indexOf(String(item && item.text ? item.text : '').trim()) < 0
      })
      var rows = messages.map(function (message, index) {
        var mine = message.role === 'user'
        return React.createElement(
          'div',
          {
            key: String(message.seq || index),
            style: { margin: '6px 0', display: 'flex', flexDirection: 'column', alignItems: mine ? 'flex-end' : 'flex-start' },
          },
          React.createElement('div', { style: { marginBottom: 3, padding: '0 4px', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', color: mine ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-state-success-primary)', textTransform: 'uppercase' } }, mine ? t('sayYou') : t('sayDen')),
          React.createElement(
            'div',
            {
              style: {
                fontSize: 13,
                lineHeight: 1.5,
                color: 'var(--dsw-alias-label-primary)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxWidth: '92%',
                padding: '8px 10px',
                borderRadius: mine ? '12px 12px 4px 12px' : '12px 12px 12px 4px',
                background: mine ? 'var(--dsw-alias-bg-layer-3)' : 'var(--dsw-alias-bg-layer-2)',
                border: '1px solid var(--dsw-alias-border-l2)',
              },
            },
            message.text,
          ),
        )
      })

      var waitingRows = waitingTexts.map(function (item, index) {
        return React.createElement(
          'div',
          { key: 'waiting-' + index, style: { margin: '6px 0', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', opacity: 0.72 } },
          React.createElement('div', { style: { marginBottom: 3, padding: '0 4px', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--dsw-alias-label-secondary)', textTransform: 'uppercase' } }, t('sayYou') + ' · ' + t('saySending')),
          React.createElement('div', { style: { fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxWidth: '92%', padding: '8px 10px', borderRadius: '12px 12px 4px 12px', background: 'var(--dsw-alias-bg-layer-3)', border: '1px solid var(--dsw-alias-border-l2)' } }, item && item.text),
        )
      })
      var allRows = rows.concat(waitingRows)

      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0, overflow: 'hidden', padding: '8px 10px 10px', background: 'var(--dsw-alias-bg-layer-1)' } },
        // The transcript accumulates; the model's context does not. This says so in the one place a
        // reader would otherwise assume they are looking at everything.
        view.phase === 'older'
          ? React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: '6px 0' } }, t('sayHostOld'))
          : null,
        // Where the transcript in front of the person actually came from. The host keeps a live
        // session, a persisted session and a log on disk, and they are not the same thing: a window
        // that silently fell back to the log was read as "den lost the conversation" (measured
        // 2026-10-15), so the path is stated rather than inferred by the reader.
        data.readFrom
          ? React.createElement(
              'div',
              { 'data-dsh-role': 'read-from', style: { fontSize: 10, color: 'var(--dsw-alias-label-tertiary)', margin: '2px 0' } },
              t(
                data.readFrom === 'store'
                  ? 'petReadFromStore'
                  : data.readFrom === 'log'
                    ? 'petReadFromLog'
                    : 'petReadFromNone',
              ),
            )
          : null,
        data.total
          ? React.createElement(
              'div',
              { style: { fontSize: 10, color: 'var(--dsw-alias-label-tertiary)', margin: '2px 0' } },
              String(messages.length) + '/' + String(data.total),
            )
          : null,
        data.truncated
          ? React.createElement(
              'div',
              { style: { fontSize: 10, color: 'var(--dsw-alias-label-tertiary)', margin: '2px 0' } },
              t('petMoreOnDisk'),
            )
          : null,
        React.createElement(
          'div',
          { style: { flex: '1 1 auto', minHeight: 56, maxHeight: 260, overflowY: 'auto', padding: '4px 2px', borderRadius: 10 } },
          allRows.length
            ? allRows
            : React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', margin: '6px 0' } }, t('sayEmpty')),
        ),
        // Said in the host's own words rather than smoothed into "something went wrong": the person can
        // read the reason, and it is the same reason the diagnostic tool prints.
        data.lastError
          ? React.createElement(
              'div',
              { style: { fontSize: 11, color: 'var(--dsw-alias-state-warn-primary)', margin: '2px 0', wordBreak: 'break-word' } },
              t('sayFailed') + data.lastError,
            )
          : null,
        view.phase === 'error' && view.error
          ? React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-state-warn-primary)', margin: '2px 0' } }, view.error)
          : null,
        // No box of its own: the window's one box is directly below this view, and a second input
        // inside a 286px card is two places to type and one place to be confused by.
        React.createElement(
          'div',
          { style: { flex: '0 0 auto', marginTop: 4, fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' } },
          t('petTypeBelow'),
        ),
      )
    }

    /**
     * The floating den has three states, and none of them is a decision.
     *
     * `running` (green) is a live heartbeat with nothing owed; `waiting` (amber) is a live heartbeat
     * that has something for the person — an unread notice, a step parked on them, a self-check that
     * came due, or a heartbeat that cannot find a way to speak; `quiet` (grey) is paused or spent,
     * either because the heartbeat is not running or because the day's own-turn budget is zero.
     *
     * There is deliberately no fourth state for a pending approval. This window cannot approve
     * anything: it reads den's state and carries the person's words back, and a red light for a
     * question that cannot be answered here would be a false alarm rather than a signal. The gate
     * lives in the shell, one seat over, which is where the buttons are.
     */
    function petModeOf(status) {
      var d = status || {}
      var kernel = d.kernel || {}
      var notices = d.notices || {}
      var tasks = d.tasks || {}
      var triggers = d.triggers || {}
      var pending = Number(notices.pending && notices.pending.length) || 0
      if (kernel.running !== true || Number(d.dailyTurnBudget) === 0) return 'quiet'
      if (pending > 0 || Number(tasks.waiting) > 0 || Number(triggers.due) > 0 || Boolean(d.kernelDeferred)) return 'waiting'
      return 'running'
    }

    /** The state label, in the person's words rather than den's. */
    function petModeLabel(mode, t) {
      if (mode === 'quiet') return t('petStateQuiet')
      if (mode === 'waiting') return t('petStateWaiting')
      return t('petStateRunning')
    }

    /**
     * The one status dot, drawn in the window's title bar and again on the shut pill.
     *
     * It resolves through `TONE_TOKEN` rather than a colour of its own, so the light the person sees
     * in the corner is the same light the full panel uses for the same verdict.
     */
    function StatusDot(props) {
      var mode = props.mode || 'running'
      var tone = mode === 'waiting' ? 'warn' : mode === 'quiet' ? 'error' : 'success'
      var dot = {
        flex: '0 0 auto',
        width: 9,
        height: 9,
        borderRadius: 999,
        background: TONE_TOKEN[tone],
        boxShadow: '0 0 0 3px var(--dsw-alias-bg-layer-2)',
      }
      return React.createElement('span', {
        'data-dsh-role': 'status-dot',
        'data-state': mode,
        'aria-hidden': true,
        // A caller may move the dot — the shut pill pins it into the corner — so the placement wins
        // over the default and the colour cannot be overridden by accident.
        style: Object.assign({}, dot, props.style || {}),
      })
    }

    /**
     * The small information layer that makes the floating den feel like a resident companion.
     *
     * It deliberately stays separate from the transcript: activity is a glanceable status rail,
     * while the conversation tab is the place where a person reads what was said and says more.
     * Neither tab carries a control that would act on the person's behalf — the window reads den's
     * state and carries words, and every verb that changes anything stays on den's own page.
     */
    function DenMiniInsights(props) {
      var t = props.t
      var d = props.status || {}
      var kernel = d.kernel || {}
      var notices = d.notices || {}
      var tasks = d.tasks || {}
      var mode = petModeOf(d)
      var tone = mode === 'waiting' ? 'warn' : mode === 'quiet' ? 'error' : 'success'
      var pending = Number(notices.pending && notices.pending.length) || 0
      var signalCount = pending + (Number(tasks.active) || 0)
      var busy = Boolean(d.kernelDeferred) || (Number(tasks.active) || 0) > 0
      var activity = [
        {
          label: d.kernelDeferred ? t('kernelWaiting') : kernel.running ? t('residentOn') : t('residentOff'),
          detail: kernel.lastTickAt ? t('lastTick') + ' ' + fmtTime(kernel.lastTickAt, t) : t('residentDeferred'),
        },
      ]
      if (signalCount > 0) {
        activity.push({ label: t('owedShort') + ' ' + String(pending), detail: t('petSignals') + ' · ' + String(signalCount) })
      } else {
        activity.push({ label: t('petNoSignals'), detail: t('petActivity') })
      }
      if (Number(tasks.blocked) > 0 || Number(tasks.waiting) > 0) {
        activity.push({
          label: t('tasksShort') + ' ' + String(Number(tasks.active) || 0),
          detail: (Number(tasks.blocked) > 0 ? t('tasksStuck') + ' ' + String(tasks.blocked) : '') +
            (Number(tasks.waiting) > 0 ? (Number(tasks.blocked) > 0 ? ' · ' : '') + t('tasksWaiting') + ' ' + String(tasks.waiting) : ''),
        })
      }

      /**
       * The activity rail's own scroll area.
       *
       * The tab strip is drawn by the window above this view, not here: the tabs are chrome of the
       * window, and a view that drew its own would draw a second one every time it was reused.
       */
      var content = React.createElement(
        'div',
        {
          'data-dsh-role': 'pet-content',
          style: {
            flex: '1 1 auto',
            minHeight: 0,
            overflowY: 'auto',
            padding: '6px 12px 8px',
            background: 'var(--dsw-alias-bg-layer-1)',
          },
        },
        activity.map(function (item, index) {
          return React.createElement(
            'div',
            {
              key: 'pet-activity-' + index,
              style: {
                display: 'grid',
                gridTemplateColumns: '10px minmax(0, 1fr) auto',
                gap: 8,
                alignItems: 'start',
                padding: '5px 0',
              },
            },
            React.createElement('span', {
              'aria-hidden': true,
              style: {
                width: 7,
                height: 7,
                marginTop: 4,
                borderRadius: 999,
                border: '2px solid ' + (index === 0 ? TONE_TOKEN[tone] : 'var(--dsw-alias-border-l2)'),
                background: 'var(--dsw-alias-bg-layer-2)',
              },
            }),
            React.createElement(
              'span',
              { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } },
              item.label,
            ),
            React.createElement(
              'span',
              { style: { maxWidth: '45%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 9, color: 'var(--dsw-alias-label-tertiary)' } },
              item.detail,
            ),
          )
        }),
      )

      return React.createElement(
        'div',
        {
          'data-dsh-role': 'pet-activity',
          style: {
            flex: '1 1 auto',
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--dsw-alias-bg-layer-1)',
          },
        },
        React.createElement(
          'div',
          {
            'data-dsh-role': 'pet-summary',
            style: { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', borderBottom: '1px solid var(--dsw-alias-border-l2)' },
          },
          React.createElement('span', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)' } }, t('petWatching')),
          React.createElement(
            'span',
            { style: { fontSize: 10, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } },
            signalCount > 0 && busy ? t('petSignals') + ' ' + String(signalCount) : t('petNoSignals'),
          ),
          React.createElement('span', { style: { flex: 1 } }),
          React.createElement(StatusBadge, { tone: tone, label: petModeLabel(mode, t) }),
        ),
        content,
      )
    }

    /**
     * The conversation view, behind a component boundary of its own.
     *
     * `DenConversation` uses hooks, and the window that owns it is itself a component: called as a
     * plain function, as it was first written, its state lands in the window's own hook slots. That
     * is not a theoretical hazard — measured in the harness, the window's `status` slot and the
     * transcript's `view` slot took each other's values, so a healthy den rendered as quiet. A
     * component boundary is what makes the two independent, and it is also what the shell does:
     * `React.createElement(DenConversation, …)`, never `DenConversation(…)`.
     *
     * An earlier draft of that boundary was a `WindowChat` wrapper and was never called; it is gone,
     * because it had drifted to passing a prop name (`sentAt`) that no longer matched the transcript's
     * own effect — a second, dead copy of a contract is exactly how the live copy went stale.
     */

    /**
     * The one line of chrome under the tabs: a box to say something, and three things to say quickly.
     *
     * The shortcuts fill the box and put the cursor in it. They deliberately do not send: a shortcut
     * that fired a turn on click would be the window acting for the person, and the shorter path here
     * is to hand them the sentence and let them finish it or rewrite it.
     */
    function DenComposer(props) {
      var t = props.t
      function fill(text) {
        props.onDraft(text)
        var node = props.inputRef && props.inputRef.current
        if (node && typeof node.focus === 'function') node.focus()
      }
      function shortcut(key, label) {
        return React.createElement(
          'button',
          {
            key: key,
            type: 'button',
            'data-dsh-role': 'pet-shortcut',
            'data-fill': label,
            onClick: function () { fill(label) },
            style: {
              flex: '0 0 auto',
              padding: '3px 7px',
              border: '1px solid var(--dsw-alias-border-l2)',
              borderRadius: 999,
              background: 'transparent',
              color: 'var(--dsw-alias-label-tertiary)',
              cursor: 'pointer',
              font: 'inherit',
              fontSize: 9,
            },
          },
          label,
        )
      }
      return React.createElement(
        'div',
        { 'data-dsh-role': 'pet-composer', style: { flex: '0 0 auto' } },
        React.createElement(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              margin: '0 10px 8px',
              padding: 5,
              border: '1px solid var(--dsw-alias-border-l2)',
              borderRadius: 10,
              background: 'var(--dsw-alias-bg-layer-2)',
            },
          },
          React.createElement('input', {
            ref: props.inputRef,
            'data-dsh-role': 'pet-input',
            value: props.value,
            placeholder: t('petComposerPlaceholder'),
            autoComplete: 'off',
            onChange: function (event) { props.onDraft(event.target.value) },
            onKeyDown: function (event) { if (event.key === 'Enter') props.onSend() },
            style: {
              flex: 1,
              minWidth: 0,
              border: 0,
              outline: 'none',
              background: 'transparent',
              color: 'var(--dsw-alias-label-primary)',
              font: 'inherit',
              fontSize: 11,
            },
          }),
          React.createElement(
            'button',
            {
              type: 'button',
              'aria-label': t('saySend'),
              title: t('saySend'),
              disabled: props.disabled,
              onClick: props.onSend,
              style: {
                display: 'grid',
                placeItems: 'center',
                flex: '0 0 auto',
                width: 24,
                height: 24,
                padding: 0,
                border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: 7,
                background: 'var(--dsw-alias-bg-layer-3)',
                color: 'var(--dsw-alias-label-primary)',
                cursor: props.disabled ? 'default' : 'pointer',
                opacity: props.disabled ? 0.55 : 1,
                font: 'inherit',
                fontSize: 12,
              },
            },
            '↗',
          ),
        ),
        React.createElement(
          'div',
          { 'data-dsh-role': 'pet-shortcuts', style: { display: 'flex', gap: 5, padding: '0 10px 8px', overflowX: 'auto' } },
          shortcut('activity', t('petShortcutActivity')),
          shortcut('status', t('petShortcutStatus')),
          shortcut('selfcheck', t('petShortcutSelfCheck')),
        ),
      )
    }

      ctx.slots.inject('shell.overlay', function () {
        /**
         * The floating window: a panel when open, one line of information when shut.
         *
         * Shut is not the same as hidden. The compact control keeps den's mark and one status dot
         * visible, while the full state remains in its accessible label and title. That leaves the
         * page readable at a glance without turning the desktop pet back into a second panel.
         *
         * The polling moves rather than doubles: open, the panel owns it; shut, this owns it.
         * The numbers come from the same fields and the same translated strings either way.
         */
        return ctx.slots.register(
          { name: 'shell.overlay', id: 'den-mini', order: 40 },
          function DenMini(props) {
            void props
            // Where the human last put it. Unset until they move it: the overlay layer gives an
            // occupant no placement of its own, so the window anchors itself rather than trust
            var placeState = React.useState(function () {
              var x = Number(miniPref('x'))
              var y = Number(miniPref('y'))
              if (!Number.isFinite(x) || !Number.isFinite(y)) return null
              // Clamped on load, not only while dragging. The saved spot belongs to the human, but the viewport
              // can shrink under it — the pill then sits past the right or bottom edge, still `active`, and
              // unreachable. Measured symptom (2026-10-15, the user): "I cannot even find den in my sidebar."
              return clampPlace(x, y, Number(miniPref('width')), Number(miniPref('height')))
            })
            var place = placeState[0]
            var setPlace = placeState[1]
            var sizeState = React.useState(function () {
              var width = Number(miniPref('width'))
              var height = Number(miniPref('height'))
              var savedVersion = Number(miniPref('sizeVersion'))
              var validSavedSize = Number.isFinite(width) && Number.isFinite(height) && width >= MINI_MIN_WIDTH && height >= MINI_MIN_HEIGHT
              // The previous version's built-in default was 260×180. Reset exactly that value so the
              // redrawn window takes effect, while preserving any footprint the human chose by hand.
              var legacyDefault = savedVersion === MINI_LEGACY_SIZE_VERSION &&
                width === MINI_LEGACY_DEFAULT_WIDTH && height === MINI_LEGACY_DEFAULT_HEIGHT
              return {
                width: validSavedSize && !legacyDefault ? width : MINI_DEFAULT_WIDTH,
                height: validSavedSize && !legacyDefault ? height : MINI_DEFAULT_HEIGHT,
              }
            })
            var size = sizeState[0]
            var setSize = sizeState[1]
            var cardRef = React.useRef(null)
            var dragRef = React.useRef(null)
            var suppressClickRef = React.useRef(false)
            var dragState = React.useState(false)
            var isDragging = dragState[0]
            var setDragging = dragState[1]

            /** One tab of the window's own strip: a word, underlined while it is the open view. */
            function petTabButton(key, label) {
              var active = miniTab === key
              return React.createElement(
                'button',
                {
                  key: key,
                  type: 'button',
                  'data-dsh-role': 'pet-tab',
                  'data-tab': key,
                  'aria-pressed': active,
                  onClick: function () { setMiniTab(key) },
                  style: {
                    position: 'relative',
                    minHeight: 24,
                    padding: '6px 0 6px',
                    border: 0,
                    borderRadius: 0,
                    background: 'transparent',
                    boxShadow: active ? 'inset 0 -2px 0 0 var(--dsw-alias-state-success-primary)' : 'none',
                    color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
                    cursor: 'pointer',
                    font: 'inherit',
                    fontSize: 11,
                    fontWeight: active ? 600 : 400,
                  },
                },
                label,
              )
            }

            function clampPlace(x, y, width, height) {
              var wide = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1200
              var tall = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 800
              var itemWidth = Number.isFinite(Number(width)) ? Number(width) : MINI_DEFAULT_WIDTH
              var itemHeight = Number.isFinite(Number(height)) ? Number(height) : MINI_DEFAULT_HEIGHT
              var maxX = Math.max(MINI_MARGIN, wide - Math.max(MINI_PILL_SIZE, itemWidth) - MINI_MARGIN)
              var maxY = Math.max(MINI_TOP_SAFE, tall - Math.max(MINI_PILL_SIZE, itemHeight) - MINI_MARGIN)
              return {
                x: Math.round(Math.min(Math.max(MINI_MARGIN, Number(x) || 0), maxX)),
                y: Math.round(Math.min(Math.max(MINI_TOP_SAFE, Number(y) || 0), maxY)),
              }
            }

            function placedStyle(current) {
              if (!current) return { position: 'absolute', right: 24, top: MINI_TOP_SAFE, bottom: 'auto', zIndex: 60 }
              return { position: 'absolute', left: current.x, top: current.y, right: 'auto', bottom: 'auto', zIndex: 60 }
            }

            function onDragStart(event, mode) {
              if (!event || !event.currentTarget) return
              mode = mode || 'window'
              // A control inside the bar must never begin a drag: the capture below retargets the pointer
              // to the bar, which is how a click on the collapse button came to do nothing at all.
              //
              // The shut pill is the exception, and it is one on purpose: its own button IS the grab
              // area, so "the press landed on a button" is exactly the case it has to accept. Its child
              // spans are decoration, and a press that lands on them is a press on the pill.
              var startedOn = event.target
              var control = startedOn && typeof startedOn.closest === 'function' ? startedOn.closest('button,a,input,textarea,select') : null
              // Comparing the target to `currentTarget` was too narrow, and the comment above says why: the shut
              // pill's own button IS the grab area, so its child spans are decoration. A press on the dot or the
              // mark made `closest('button')` return the pill itself, which the old test did not recognise as
              // "this control", so the guard fired and the pill could not be moved at all — reported by the user
              // on 2026-10-16 while it was shut. A control only disqualifies a drag when it is a different one.
              if (control && control !== event.currentTarget) return
              var rect = typeof event.currentTarget.getBoundingClientRect === 'function'
                ? event.currentTarget.getBoundingClientRect()
                : { left: 0, top: MINI_TOP_SAFE, width: open ? size.width : MINI_PILL_SIZE, height: open ? size.height : MINI_PILL_SIZE }
              var origin = place || clampPlace(rect.left, rect.top, rect.width, rect.height)
              if (!place) setPlace(origin)
              var pointerX = Number(event.clientX)
              var pointerY = Number(event.clientY)
              var hasPointer = Number.isFinite(pointerX) && Number.isFinite(pointerY)
              dragRef.current = {
                startX: hasPointer ? pointerX : null,
                startY: hasPointer ? pointerY : null,
                originX: origin.x,
                originY: origin.y,
                lastPlace: origin,
                width: rect.width,
                height: rect.height,
                mode: mode,
                moved: false,
              }
              suppressClickRef.current = false
              setDragging(true)
              // The open window should start moving immediately. The shut pill keeps the native
              // click until the pointer has actually travelled, so a short press still opens it.
              if (mode !== 'pill' && event.preventDefault) event.preventDefault()
              if (event.stopPropagation) event.stopPropagation()
              if (event.currentTarget.setPointerCapture && event.pointerId !== undefined) {
                try { event.currentTarget.setPointerCapture(event.pointerId) } catch (e) { void e }
              }
            }

            function onDragMove(event) {
              var drag = dragRef.current
              if (!drag || !event) return
              var pointerX = Number(event.clientX)
              var pointerY = Number(event.clientY)
              var hasPointer = Number.isFinite(pointerX) && Number.isFinite(pointerY)
              var next
              if (hasPointer && drag.startX !== null && drag.startY !== null) {
                next = clampPlace(drag.originX + pointerX - drag.startX, drag.originY + pointerY - drag.startY, drag.width, drag.height)
              } else {
                next = clampPlace(drag.lastPlace.x + (Number(event.movementX) || 0), drag.lastPlace.y + (Number(event.movementY) || 0), drag.width, drag.height)
              }
              if (drag.mode === 'pill' && !drag.moved && drag.startX !== null && drag.startY !== null) {
                drag.moved = Math.abs(pointerX - drag.startX) > 5 || Math.abs(pointerY - drag.startY) > 5
                if (drag.moved) {
                  suppressClickRef.current = true
                  if (event.preventDefault) event.preventDefault()
                }
              }
              drag.lastPlace = next
              setPlace(next)
            }

            function onDragEnd() {
              var drag = dragRef.current
              if (!drag) return
              dragRef.current = null
              setDragging(false)
              if (drag.mode === 'pill' && drag.moved) suppressClickRef.current = true
              if (drag.lastPlace) {
                setPlace(drag.lastPlace)
                setMiniPref('x', drag.lastPlace.x)
                setMiniPref('y', drag.lastPlace.y)
              }
            }

            var openState = React.useState(miniPref('collapsed') !== true)
            var open = openState[0]
            var setOpen = openState[1]
            var snapshot = React.useState(null)
            var status = snapshot[0]
            var setStatus = snapshot[1]
            /**
             * The state the window shows, derived once and used by both the bar and the shut pill.
             *
             * Both surfaces read this same value, so the light in the corner cannot say one thing
             * while the window says another — the failure mode a second derivation would reintroduce.
             *
             * It is derived *after* the snapshot is read, and that order is the whole point: `var
             * status` above is hoisted to the top of this function, so a derivation written earlier in
             * the body would silently be given `undefined` on every render and report `quiet` forever —
             * a grey light beside a window whose own activity rail said the heartbeat was running.
             */
            var petMode = petModeOf(status)
            if (typeof window !== 'undefined' && window.__dshDenDebugMode) {
              window.__probeModes = (window.__probeModes || []).concat([petMode + (status ? '/S' : '/-') + '/' + (status && status.kernel ? String(status.kernel.running) : 'x')])
            }
            var petModeText = petModeLabel(petMode, t)
            if (typeof window !== 'undefined' && window.__dshDenDebugMode) {
              window.__probe = (window.__probe || [])
              window.__probe.push('render status=' + (status ? 'S' : 'null'))
            }
            var miniTabState = React.useState('activity')
            var miniTab = miniTabState[0]
            var setMiniTab = miniTabState[1]
            /** Once the conversation has been opened, it stays mounted so re-opening it is not a re-read. */
            var chatEverMounted = React.useRef(false)
            if (miniTab === 'chat') chatEverMounted.current = true
            /**
             * What is typed in the window's one box, and where the cursor goes.
             *
             * The draft lives here rather than inside the transcript so a shortcut can fill it without
             * sending anything: the composer writes the sentence, the person presses send. It is also
             * why the box's own visibility is decided here rather than by whether the chat tab is open:
             * looking at the activity view must not take the way to speak off screen.
             */
            var draftState = React.useState('')
            var typed = draftState[0]
            var setTyped = draftState[1]
            var typedRef = React.useRef(null)
            var sendState = React.useState({ busy: false, phase: 'loading' })
            var send = sendState[0]
            var setSend = sendState[1]
            /**
             * The sentence that has been admitted but is not in the transcript yet.
             *
             * The host admits a prompt and logs it afterwards, so the read that follows a send can
             * honestly come back without it. The transcript draws this copy until the log carries the
             * same words, which is what keeps the person's own sentence from vanishing for a tick.
             */
            var pendingState = React.useState(null)
            var sent = pendingState[0]
            var setSent = pendingState[1]

            function say() {
              var body = String(typed || '').trim()
              // An older host cannot hold a conversation at all, so the box is inert rather than
              // failing after it has been pressed. The reason is on screen either way.
              if (!body || send.busy || send.phase === 'older') return
              setSend({ busy: true, phase: send.phase })
              act('conversation/say', { text: body })
                .then(function () {
                  // Shown at once, in the transcript, because the read that follows may legitimately
                  // predate the log entry: the log is the authority and the copy goes when it carries
                  // the same words.
                  setSent({ text: body, at: Date.now() })
                  setTyped('')
                  setSend({ busy: false, phase: 'ready' })
                })
                .catch(function () {
                  // What was typed is left in the box on purpose: a send that failed must not also
                  // cost the person the words, and there is no other copy of them on this surface.
                  setSend({ busy: false, phase: 'error' })
                })
            }
            var composerEnabled = send.phase !== 'older' && !send.busy && String(typed || '').trim().length > 0

            React.useEffect(function () {
              if (!open || !cardRef.current || typeof window === 'undefined' || typeof window.ResizeObserver !== 'function') return undefined
              var observer = new window.ResizeObserver(function (entries) {
                var target = entries && entries[0] && entries[0].target
                if (!target || typeof target.getBoundingClientRect !== 'function') return
                var rect = target.getBoundingClientRect()
                var width = Math.round(rect.width)
                var height = Math.round(rect.height)
                if (!Number.isFinite(width) || !Number.isFinite(height) || width < MINI_MIN_WIDTH || height < MINI_MIN_HEIGHT) return
                setSize(function (previous) {
                  if (previous.width === width && previous.height === height) return previous
                  setMiniPref('width', width)
                  setMiniPref('height', height)
                  setMiniPref('sizeVersion', MINI_SIZE_VERSION)
                  return { width: width, height: height }
                })
              })
              observer.observe(cardRef.current)
              return function () { observer.disconnect() }
            }, [open])

            React.useEffect(function () {
              var alive = true
              function pull() {
                act('status', {}).then(function (res) {
                  if (alive && res) setStatus(res.value ?? res)
                }).catch(function () {})
              }
              pull()
              var timer = setInterval(pull, open ? MINI_POLL_MS * 2 : MINI_POLL_MS)
              return function () {
                alive = false
                clearInterval(timer)
              }
            }, [open])

            if (open) {
              /*
               * The pet, as drawn.
               *
               * One window, one status light, two views and one box to speak into. The title bar is
               * the grab area and carries den's mark, the state and the collapse control; the tabs are
               * words with a rule under the active one; the box at the bottom fills and sends, and the
               * three shortcuts beside it only fill — nothing in this window acts on the person's
               * behalf, which is why there is no allow/deny control anywhere in it.
               */
              var header = React.createElement(
                'header',
                {
                  'data-dsh-role': 'pet-header',
                  'aria-label': t('dragHint'),
                  onPointerDown: onDragStart,
                  onPointerMove: onDragMove,
                  onPointerUp: onDragEnd,
                  onPointerCancel: onDragEnd,
                  style: {
                    flex: '0 0 auto',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 9,
                    height: 42,
                    padding: '0 10px',
                    borderBottom: '1px solid var(--dsw-alias-border-l2)',
                    background: 'var(--dsw-alias-bg-layer-2)',
                    cursor: isDragging ? 'grabbing' : 'grab',
                    userSelect: 'none',
                    touchAction: 'none',
                    WebkitAppRegion: 'no-drag',
                  },
                },
                React.createElement(
                  'span',
                  {
                    'aria-hidden': true,
                    style: {
                      display: 'grid',
                      placeItems: 'center',
                      flex: '0 0 auto',
                      width: 22,
                      height: 22,
                      border: '1px solid var(--dsw-alias-border-l2)',
                      borderRadius: 8,
                      background: 'var(--dsw-alias-bg-layer-1)',
                      color: 'var(--dsw-alias-state-success-primary)',
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: '-0.08em',
                    },
                  },
                  'dn',
                ),
                React.createElement(
                  'span',
                  { style: { minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' } },
                  React.createElement('strong', { style: { fontSize: 12, fontWeight: 650, lineHeight: 1.2, color: 'var(--dsw-alias-label-primary)' } }, t('nav')),
                  React.createElement('span', { style: { marginTop: 1, fontSize: 10, lineHeight: 1.2, color: 'var(--dsw-alias-label-tertiary)' } }, t('floatingLabel')),
                ),
                React.createElement(
                  'span',
                  { 'data-dsh-role': 'pet-status', style: { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: 'var(--dsw-alias-label-secondary)' } },
                  React.createElement(StatusDot, { mode: petMode }),
                  React.createElement('span', null, petModeText),
                ),
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    // The bar behind this button is a drag handle, and it captures the pointer on
                    // pointerdown (`setPointerCapture`). A click inside a captured pointer is retargeted to
                    // the capturing element, so this button's onClick never ran: collapsing did nothing.
                    // Measured report, 2026-10-15: "我现在点击缩小没反应".
                    onPointerDown: function (event) {
                      if (event && event.stopPropagation) event.stopPropagation()
                    },
                    onClick: function () { setOpen(false); setMiniPref('collapsed', true) },
                    'aria-label': t('collapse'),
                    title: t('collapse'),
                    style: {
                      display: 'grid',
                      placeItems: 'center',
                      flex: '0 0 auto',
                      width: 24,
                      height: 24,
                      padding: 0,
                      border: '1px solid transparent',
                      borderRadius: 7,
                      background: 'transparent',
                      color: 'var(--dsw-alias-label-secondary)',
                      cursor: 'pointer',
                      font: 'inherit',
                      fontSize: 15,
                      lineHeight: 1,
                    },
                  },
                  '−',
                ),
              )

              var isActivity = miniTab === 'activity'
              // `.current`, not the ref object itself: a ref object is always truthy, so reading the
              // object made this condition permanently true and the transcript fetched on every open,
              // while the activity view was the one on screen. The flag is what makes the tab the
              // trigger — the first time it is opened — and keeps the transcript mounted after that.
              var chatMounted = miniTab === 'chat' || chatEverMounted.current
              var activityView = React.createElement(
                'div',
                { style: { flex: '1 1 auto', minHeight: 0, display: isActivity ? 'flex' : 'none', flexDirection: 'column' } },
                React.createElement(DenMiniInsights, { t: t, status: status }),
              )
              var chatView = chatMounted
                ? React.createElement(
                    'div',
                    {
                      'data-dsh-role': 'pet-chat',
                      style: { flex: '1 1 auto', minHeight: 0, display: isActivity ? 'none' : 'flex', flexDirection: 'column' },
                    },
                    // Mounted when the tab is opened, which is what asks the host for the transcript,
                    // and kept mounted after that so switching back and forth is not a re-read.
                    React.createElement(DenConversation, {
                      t: t,
                      act: act,
                      sent: sent,
                      // The transcript knows whether this host can hold a conversation at all; the box
                      // below is disabled on that verdict rather than on a guess made up here.
                      onPhase: function (phase) {
                        setSend(function (previous) {
                          if (previous.phase === phase) return previous
                          return { busy: previous.busy, phase: phase }
                        })
                      },
                    }),
                  )
                : null

              return React.createElement(
                'div',
                {
                  ref: cardRef,
                  role: 'dialog',
                  'aria-label': t('floatingLabel'),
                  style: Object.assign(
                    {
                      pointerEvents: 'auto',
                      // The browser's native resize affordance makes this feel like a small desktop
                      // pet instead of a disposable panel. Dimensions are observed and remembered
                      // below, so the human's preferred footprint survives a DSH reload.
                      width: size.width,
                      height: size.height,
                      minWidth: MINI_MIN_WIDTH,
                      minHeight: MINI_MIN_HEIGHT,
                      maxWidth: 'calc(100vw - 24px)',
                      maxHeight: 'calc(100vh - 24px)',
                      boxSizing: 'border-box',
                      resize: 'both',
                      overflow: 'hidden',
                      display: 'flex',
                      flexDirection: 'column',
                      WebkitAppRegion: 'no-drag',
                      background: 'var(--dsw-alias-bg-layer-1)',
                      color: 'var(--dsw-alias-label-primary)',
                      border: '1px solid var(--dsw-alias-border-l1)',
                      borderRadius: 18,
                      boxShadow: isDragging ? '0 18px 38px rgba(0,0,0,.32), 0 4px 10px rgba(0,0,0,.16)' : '0 14px 30px rgba(0,0,0,.26), 0 3px 8px rgba(0,0,0,.12)',
                      transform: isDragging ? 'scale(.985)' : 'none',
                      transition: 'box-shadow 160ms ease, transform 160ms ease',
                    },
                    placedStyle(place),
                  ),
                },
                header,
                // The tab strip is chrome of its own, one row under the bar: the tabs are words and
                // the active one is marked by a rule, so they read as views of one window rather than
                // as three buttons that each open something.
                React.createElement(
                  'nav',
                  {
                    'data-dsh-role': 'pet-tabs',
                    role: 'tablist',
                    style: { flex: '0 0 auto', display: 'flex', gap: 14, padding: '0 12px', borderBottom: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)' },
                  },
                  petTabButton('activity', t('petActivity')),
                  petTabButton('chat', t('petConversation')),
                ),
                React.createElement(
                  'div',
                  { 'data-dsh-role': 'pet-content', style: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' } },
                  activityView,
                  chatView,
                ),
                React.createElement(DenComposer, {
                  t: t,
                  value: typed,
                  inputRef: typedRef,
                  disabled: !composerEnabled,
                  onDraft: setTyped,
                  onSend: say,
                }),
                React.createElement('span', { 'aria-hidden': true, title: t('resizeHint'), style: { position: 'absolute', right: 6, bottom: 5, pointerEvents: 'none', color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: 1, opacity: 0.8 } }, '◢'),
              )
            }

            var bits = []
            if (status) {
              // The three-state verdict leads, because that is what the dot beside it shows. There is
              // no fourth state here and nothing about an approval gate: this control opens a window
              // that reads den's state and carries words, and a light for a decision it cannot take
              // would be a false alarm.
              bits.push(t('openPanel'))
              // What the heartbeat itself is doing, kept beside the three-state verdict rather than
              // replaced by it. The two answer different questions — "can den act at all" and "is
              // anything waiting on me" — and a shut pill that dropped the first answered a question
              // nobody asked: with a step parked on the person it read only "等待你", so the person
              // could not tell a healthy heartbeat from a stopped one without opening the window.
              bits.push(
                status.kernelDeferred
                  ? t('residentDeferred')
                  : status.kernel && status.kernel.running
                    ? t('residentOn')
                    : t('residentOff'),
              )
              bits.push(petModeText)
              var cap = Number(status.dailyTurnBudget)
              var spent = Number(status.ledger && status.ledger.turns) || 0
              // What den is allowed to start by itself today, and how much of it is gone. This is
              // the number that makes an autonomous assistant accountable rather than mysterious.
              if (!Number.isFinite(cap)) {
                // Every host half that has the daily budget sends that field, so its absence is a
                // version signal rather than a policy: this host is older than this window. Naming it
                // is the most useful thing the shut pill can say, because it explains why the window
                // still cannot hold a conversation.
                bits.push(t('hostOlder'))
              } else if (cap > 0) {
                bits.push(t('budgetShort') + ' ' + String(spent) + '/' + String(cap))
              } else {
                bits.push(t('budgetOff'))
              }
              bits.push(t('owedShort') + ' ' + String(status.notices && status.notices.pending ? status.notices.pending.length : 0))
              bits.push(
                status.tasks && Number(status.tasks.total) > 0
                  ? t('tasksShort') + ' ' + String(status.tasks.active) +
                    (Number(status.tasks.blocked) > 0 ? ' · ' + t('tasksStuck') + ' ' + String(status.tasks.blocked) : '') +
                    (Number(status.tasks.waiting) > 0 ? ' · ' + t('tasksWaiting') + ' ' + String(status.tasks.waiting) : '')
                  : t('tasksWaiting') + ' 0',
              )
            } else {
              // Nothing has been answered yet, so nothing is claimed: the pill says it is waiting for
              // the first snapshot rather than borrowing the healthy copy.
              bits.push(t('petModeUnknown'))
            }
            var statusLabel = bits.join(' · ')
            return React.createElement(
              'button',
              {
                type: 'button',
                onPointerDown: function (event) { onDragStart(event, 'pill') },
                onPointerMove: onDragMove,
                onPointerUp: onDragEnd,
                onPointerCancel: onDragEnd,
                onClick: function (event) {
                  if (suppressClickRef.current) {
                    suppressClickRef.current = false
                    if (event && event.preventDefault) event.preventDefault()
                    return
                  }
                  setOpen(true)
                  setMiniPref('collapsed', false)
                },
                'aria-label': statusLabel,
                title: statusLabel,
                style: {
                  ...placedStyle(place),
                  pointerEvents: 'auto',
                  position: 'absolute',
                  border: '1px solid var(--dsw-alias-border-l1)',
                  borderRadius: MINI_PILL_RADIUS,
                  background: 'var(--dsw-alias-bg-layer-2)',
                  color: 'var(--dsw-alias-label-primary)',
                  cursor: isDragging ? 'grabbing' : 'grab',
                  width: MINI_PILL_SIZE,
                  height: MINI_PILL_SIZE,
                  display: 'grid',
                  placeItems: 'center',
                  padding: 0,
                  boxShadow: isDragging ? '0 8px 18px rgba(0,0,0,.24)' : '0 2px 8px rgba(0,0,0,0.12)',
                  transform: isDragging ? 'scale(.94)' : 'none',
                  transition: 'box-shadow 140ms ease, transform 140ms ease',
                  touchAction: 'none',
                  WebkitAppRegion: 'no-drag',
                },
              },
              // One child, as before: den's mark, with the state dot pinned into the corner on top of
              // it. A second child would be a second thing to read in a control this small.
              React.createElement(
                'span',
                { 'aria-hidden': true, style: { position: 'relative', display: 'grid', placeItems: 'center', width: MINI_PILL_SIZE, height: MINI_PILL_SIZE, borderRadius: MINI_PILL_RADIUS } },
                React.createElement('span', { style: { color: 'var(--dsw-alias-state-success-primary)', fontSize: 18, lineHeight: 1 } }, '◈'),
                React.createElement(StatusDot, {
                  mode: petMode,
                  style: { position: 'absolute', top: 6, right: 6 },
                }),
              ),
            )
          },
        )
      })

      ctx.slots.inject('main', function () {
        return ctx.slots.register({ name: 'main', key: PANEL_KEY }, function Bound(props) {
          // No session is resolved here on purpose. This seat is root-scoped and keyed, and the shell's
          // own catalog states the rule: "The reserved `conversation` key hosts the Conversation; other
          // keys receive no Session binding." A status page that needs a conversation must live
          // somewhere a conversation is handed to it, and trying to discover one from here produced
          // three wrong shapes that a matching test double happily agreed with.
          void props
          return React.createElement(DenPanel, { t: t, act: act, sessionId: null })
        })
      })
    }

    module.exports = {
      name: 'dsh-den',
      /* Cordis *service* names — a different table from package.json's
       * `dsh.client.inject`, which lists package names. */
      inject: ['slots', 'locale'],
      apply: apply,
    }

    return module.exports
  },
})
