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
        gateUnmounted: 'NOT armed',
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
        tasksShort: 'in progress',
        tasksStuck: 'stuck',
        tasksWaiting: 'waiting on you',
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
        gateUnmounted: '未装载',
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
        autonomyNoSession: '这个页面没有被绑定任何会话 —— 在右下角的浮窗里授予就行，一次授权对所有会话生效',
        grantDock: '常驻自治 · 本会话',
        noticesOwed: '你不在的时候：',
        noticeReadIt: '读过了',
        residentOn: '常驻中 · 心跳运行中',
        residentOff: '常驻中 · 已停',
        wokeShort: '自己醒来',
        owedShort: '有话想跟你说',
        collapse: '收起',
        tasksShort: '进行中',
        tasksStuck: '卡住',
        tasksWaiting: '等你',
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
          style: {
            padding: '4px 10px',
            marginRight: 6,
            borderRadius: 4,
            border: '1px solid var(--dsw-alias-border-l2)',
            background: props.primary ? 'var(--dsw-alias-bg-layer-3)' : 'transparent',
            color: props.disabled ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-label-primary)',
            cursor: props.disabled ? 'default' : 'pointer',
            font: 'inherit',
          },
        },
        props.children,
      )
    }

/** How often the shut pill refreshes itself: slower than the open panel, never stopped. */
    var MINI_POLL_MS = 2000

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
       * Compact mode renders only what needs a conversation, for the dock above the message box.
       *
       * The seat is `conversation.input.dock`: session-scoped, full width, `replaceRisk: none`, and
       * its live catalog lists `sessionId: SessionId` among the standard props. That is the whole
       * reason the control can work at all - a status page in `main` has no conversation to name.
       */
      var compact = !!props.compact

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
          { style: { marginTop: 14, paddingTop: 10, borderTop: '1px solid var(--dsw-alias-border-l2)' } },
          React.createElement('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)', marginBottom: 4 } }, t('schedules')),
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
              padding: '6px 10px',
              fontSize: 12,
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
            { style: { padding: '6px 10px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
            React.createElement('span', null, t('grantDock') + ' ' + String.fromCharCode(183) + ' ' + t('grantDockGranted')),
          )
        }
        return React.createElement(
          'div',
          null,
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
          noticesBlock(),
          schedulesBlock(Boolean(sessionId)),
        )
      }

      var children = [React.createElement('h2', { key: 'h', style: { margin: '0 0 4px', fontSize: 16, color: 'var(--dsw-alias-label-primary)' } }, t('title'))]

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
         * One line a person can read in a second; the measured rows only if asked for.
         *
         * The user's own panel on their phone puts a single `label value · label value` row above the
         * composer. This is the same shape and the same argument: the default view answers the three
         * questions a person actually has — is it on, has it done anything, is anything waiting for
         * me — and the measurements move behind `details`.
         */
        children.push(
          React.createElement(
            'div',
            { key: 'plain', style: { margin: '6px 0 2px', color: 'var(--dsw-alias-label-secondary)' } },
            React.createElement(
              'span',
              { style: { color: 'var(--dsw-alias-label-primary)' } },
              running ? t('residentOn') : t('residentOff'),
            ),
            ' · ' + t('wokeShort') + ' ' + String((d && d.ledger && d.ledger.turns) || 0),
            ' · ' + t('owedShort') + ' ' + String(owedCount),
            // Tasks (DESIGN 7.4). Same row, not a new one, and only when there is something to
            // say: with no tasks this line stays byte-identical to what it was, because a permanent
            // "in progress 0" is exactly the kind of always-there furniture the default view is
            // supposed to be free of. When there is work, the stuck count rides along — never
            // folded behind `details`, because a step that cannot move on is the one thing a person
            // must not have to go looking for.
            d && d.tasks && Number(d.tasks.total) > 0 && Number.isFinite(d.tasks.active)
              ? ' · ' + t('tasksShort') + ' ' + String(d.tasks.active) +
                (Number(d.tasks.blocked) > 0 ? ' · ' + t('tasksStuck') + ' ' + String(d.tasks.blocked) : '') +
                (Number(d.tasks.waiting) > 0 ? ' · ' + t('tasksWaiting') + ' ' + String(d.tasks.waiting) : '')
              : '',
            ' · ' + autonomyText,
            '  ',
            React.createElement(
              Button,
              { onClick: function () { setDetailOpen(!detailOpen) } },
              detailOpen ? t('scheduleClose') : t('details'),
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
                value: d.gate && d.gate.mounted ? t('gateMounted') : t('gateUnmounted'),
                tone: d.gate && d.gate.mounted ? 'success' : 'error',
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
            padding: 16,
            background: 'var(--dsw-alias-bg-layer-1)',
            border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: 8,
            fontFamily: 'inherit',
            maxWidth: 520,
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


      ctx.slots.inject('shell.overlay', function () {
        /**
         * The floating window: a panel when open, one line of information when shut.
         *
         * Shut is not the same as hidden. A pill that keeps polling on a slower cadence still
         * answers the two questions worth asking at a glance - is it awake, and does it have
         * anything for me - which is why the numbers stay on it instead of it shrinking to a dot.
         *
         * The polling moves rather than doubles: open, the panel owns it; shut, this owns it.
         * The numbers come from the same fields and the same translated strings either way.
         */
        return ctx.slots.register(
          { name: 'shell.overlay', id: 'den-mini', order: 40 },
          function DenMini(props) {
            void props
            // Where the human last put it. Unset until they move it, so the default placement the
            // shell gives an overlay occupant is left exactly as it was.
            var placeState = React.useState(function () {
              var x = miniPref('x')
              var y = miniPref('y')
              return typeof x === 'number' && typeof y === 'number' ? { x: x, y: y } : null
            })
            var place = placeState[0]
            var setPlace = placeState[1]
            var dragState = React.useState(false)
            var isDragging = dragState[0]
            var setDragging = dragState[1]

            function placedStyle(current) {
              if (!current) return {}
              return { position: 'fixed', left: current.x, top: current.y, right: 'auto', bottom: 'auto', zIndex: 60 }
            }

            function onDragStart(event) {
              setDragging(true)
              // Seed from where the window actually is, or the first movement would jump it to the
              // top-left corner: the shell position is a layout fact, not a number we were told.
              if (!place && event && event.currentTarget && event.currentTarget.getBoundingClientRect) {
                var rect = event.currentTarget.getBoundingClientRect()
                setPlace({ x: Math.round(rect.left), y: Math.round(rect.top) })
              }
              if (event && event.preventDefault) event.preventDefault()
              if (event && event.currentTarget && event.currentTarget.setPointerCapture && event.pointerId !== undefined) {
                try { event.currentTarget.setPointerCapture(event.pointerId) } catch (e) { void e }
              }
            }

            function onDragMove(event) {
              if (!isDragging || !event) return
              var dx = event.movementX || 0
              var dy = event.movementY || 0
              // The handler is rebuilt on every render, so `place` here is the position from the
              // last one; a functional update would be tidier but not every renderer has it.
              var from = place || { x: 0, y: 0 }
              var wide = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1200
              var tall = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 800
              var maxX = Math.max(0, wide - 72)
              var maxY = Math.max(0, tall - 32)
              setPlace({
                x: Math.min(Math.max(0, from.x + dx), maxX),
                y: Math.min(Math.max(0, from.y + dy), maxY),
              })
            }

            function onDragEnd() {
              if (!isDragging) return
              setDragging(false)
              if (place) {
                setMiniPref('x', place.x)
                setMiniPref('y', place.y)
              }
            }

            var openState = React.useState(miniPref('collapsed') !== true)
            var open = openState[0]
            var setOpen = openState[1]
            var snapshot = React.useState(null)
            var status = snapshot[0]
            var setStatus = snapshot[1]

            React.useEffect(function () {
              if (open) {
                setStatus(null)
                return undefined
              }
              var alive = true
              function pull() {
                act('status', {}).then(function (res) {
                  if (alive && res) setStatus(res.value ?? res)
                }).catch(function () {})
              }
              pull()
              var timer = setInterval(pull, MINI_POLL_MS)
              return function () {
                alive = false
                clearInterval(timer)
              }
            }, [open])

            if (open) {
              return React.createElement(
                'div',
                { style: Object.assign({ pointerEvents: 'auto' }, placedStyle(place)) },
                // The bar is the grab area: it holds no text of its own, so the window still reads
                // as the panel and nothing else, and the only control on it is the collapse button.
                React.createElement(
                  'div',
                  {
                    onPointerDown: onDragStart,
                    onPointerMove: onDragMove,
                    onPointerUp: onDragEnd,
                    onPointerCancel: onDragEnd,
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'flex-end',
                      cursor: isDragging ? 'grabbing' : 'grab',
                      userSelect: 'none',
                      touchAction: 'none',
                    },
                  },
                  React.createElement(
                    'button',
                    {
                      type: 'button',
                      onClick: function () { setOpen(false); setMiniPref('collapsed', true) },
                      style: {
                        border: 'none',
                        background: 'transparent',
                        color: 'var(--dsw-alias-label-secondary)',
                        cursor: 'pointer',
                        fontSize: 14,
                        padding: '0 6px',
                      },
                      title: t('collapse'),
                    },
                    '–',
                  ),
                ),
                React.createElement(DenPanel, { t: t, act: act, sessionId: null, compact: true }),
              )
            }

            var bits = []
            if (status) {
              bits.push(status.running ? t('residentOn') : t('residentOff'))
              bits.push(t('owedShort') + ' ' + String(status.notices && status.notices.pending ? status.notices.pending.length : 0))
              if (status.tasks && Number(status.tasks.total) > 0) {
                bits.push(t('tasksShort') + ' ' + String(status.tasks.active))
                if (Number(status.tasks.blocked) > 0) bits.push(t('tasksStuck') + ' ' + String(status.tasks.blocked))
                if (Number(status.tasks.waiting) > 0) bits.push(t('tasksWaiting') + ' ' + String(status.tasks.waiting))
              }
            } else {
              bits.push(t('residentOn'))
            }
            return React.createElement(
              'button',
              {
                type: 'button',
                onClick: function () { setOpen(true); setMiniPref('collapsed', false) },
                style: {
                  ...placedStyle(place),
                  pointerEvents: 'auto',
                  border: '1px solid var(--dsw-alias-border-l2)',
                  borderRadius: 999,
                  background: 'var(--dsw-alias-bg-base)',
                  color: 'var(--dsw-alias-label-secondary)',
                  cursor: 'pointer',
                  fontSize: 12,
                  padding: '4px 10px',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
                },
              },
              bits.join(' · '),
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
