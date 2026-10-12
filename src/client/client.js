/* dsh-den resident status panel — browser half of the plugin.
 *
 * This file is loaded by the DSH shell's module loader, not by Node. It is a
 * single hand-written lazy-CJS bundle with no build step: the loader's only
 * requirements are that the bundle calls `window.__ModuleLoader__.load({id,
 * factory})` with an `id` equal to the package name, and that every side effect
 * (including style injection) happens inside the factory so nothing runs before
 * the module is materialised.
 *
 * The host half is `src/index.js`. The two communicate over one read-only RPC
 * route declared in `src/status-route.js`. Nothing here can change the den's
 * authority, schedules, or memory — the panel is a window, not a control surface.
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
    var RPC_ENDPOINT = 'dsh.den/status'
    /* The shipped Plugins panel sits at order 0; dsh-bot uses 250. */
    var ORDER = 245

    /* ------------------------------------------------------------- locale */

    var STRINGS = {
      en: {
        nav: 'Den',
        title: 'Den — resident assistant',
        refreshing: 'refreshing…',
        refresh: 'Refresh',
        autonomy: 'Standing autonomy',
        autonomyOn: 'granted',
        autonomyOff: 'not granted',
        autonomyUnknown: 'unknown for this view',
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
        unavailable: 'The host did not answer',
        errors: 'Last error',
        working: 'working…',
        autonomyGrant: 'Grant',
        autonomyRevoke: 'Revoke',
        autonomyNoSession: 'no active conversation — autonomy is per conversation',
        autonomyTokenHint:
          'Paste this token to the assistant in the conversation; it will grant access with this message as proof. The token is single-use and expires.',
        autonomyCopied: 'token ready',
        schedules: 'Self-checks',
        scheduleNone: 'none — the den will not wake on its own',
        scheduleTitle: 'Title',
        schedulePrompt: 'What to check',
        scheduleMinutes: 'Every (minutes)',
        scheduleAdd: 'Add self-check',
        scheduleRemove: 'remove',
        scheduleCreateHint: 'Not a permission grant: each run still re-checks autonomy, budget and quiet hours.',
        dueNow: 'due now',
        kernelWaiting: 'waiting for a delivery path',
        kernelGaveUp: 'gave up after',
        attempts: 'attempts',
        footNote:
          'Granting autonomy needs human evidence. The panel mints a single-use token; the write happens in the conversation.',
      },
      zh: {
        nav: 'Den',
        title: 'Den —— 常驻助理',
        refreshing: '刷新中…',
        refresh: '刷新',
        autonomy: '常驻授权',
        autonomyOn: '已授予',
        autonomyOff: '未授予',
        autonomyUnknown: '本视图未知',
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
        unavailable: '宿主未应答',
        errors: '最近错误',
        working: '处理中…',
        autonomyGrant: '授予',
        autonomyRevoke: '撤销',
        autonomyNoSession: '没有活动会话 —— 授权是按会话授予的',
        autonomyTokenHint:
          '把这个令牌交给对话里的助理，它会以你这条消息作为证据完成写入。令牌一次性有效并会过期。',
        schedules: '自检',
        scheduleNone: '无 —— 助理不会自己醒来',
        scheduleTitle: '名称',
        schedulePrompt: '检查什么',
        scheduleMinutes: '每（分钟）',
        scheduleAdd: '新建自检',
        scheduleRemove: '删除',
        scheduleCreateHint: '这不是权限授予：每次运行仍会重新检查授权、预算与免打扰时段。',
        dueNow: '待触发',
        kernelWaiting: '等待投递通道',
        kernelGaveUp: '已放弃，尝试',
        attempts: '次',
        footNote: '授予授权需要人类证据。面板只生成一次性令牌，真正的写入发生在对话里。',
      },
    }

    function pick(locale) {
      var tag = String(locale || '').toLowerCase()
      return tag.indexOf('zh') === 0 ? STRINGS.zh : STRINGS.en
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

      var sessionId = props.sessionId
      var act = props.act

      var load = React.useCallback(function () {
        setView(function (prev) {
          return { phase: prev.data ? 'refreshing' : 'loading', data: prev.data, error: null }
        })
        props
          .call(RPC_ENDPOINT, { action: 'status', sessionId: sessionId })
          .then(function (value) {
            setView({ phase: 'ready', data: value, error: null })
          })
          .catch(function (error) {
            setView(function (prev) {
              return { phase: 'error', data: prev.data, error: String((error && error.message) || error) }
            })
          })
      }, [props.call, sessionId])

      React.useEffect(function () {
        load()
        var timer = setInterval(load, 15000)
        return function () {
          clearInterval(timer)
        }
      }, [load])

      var loadSchedules = React.useCallback(function () {
        if (!sessionId) {
          setSched({ list: [], error: null })
          return
        }
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
            if (sink) sink({ phase: 'resolved', kind: kind, value: value })
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
              'code',
              { style: { display: 'block', margin: '4px 0', wordBreak: 'break-all', color: 'var(--dsw-alias-label-primary)' } },
              action.token,
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

        if (d.reapedTempFiles) {
          children.push(React.createElement(Row, { key: 'r', label: t('recovered'), value: String(d.reapedTempFiles) }))
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

        children.push(
          React.createElement(
            'div',
            { key: 'grant', style: { marginTop: 14, paddingTop: 10, borderTop: '1px solid var(--dsw-alias-border-l2)' } },
            React.createElement(Button, {
              primary: true,
              disabled: busy || !sessionId,
              onClick: function () { onGrant(true) },
            }, t('autonomyGrant')),
            React.createElement(Button, {
              disabled: busy || !sessionId,
              onClick: function () { onGrant(false) },
            }, t('autonomyRevoke')),
            !sessionId
              ? React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-state-warn-primary)', marginTop: 4 } }, t('autonomyNoSession'))
              : null,
          ),
        )

        children.push(
          React.createElement(
            'div',
            { key: 'sched', style: { marginTop: 14, paddingTop: 10, borderTop: '1px solid var(--dsw-alias-border-l2)' } },
            React.createElement('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)', marginBottom: 4 } }, t('schedules')),
            sched.list.length === 0
              ? React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, t('scheduleNone'))
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
                        disabled: busy,
                        onClick: function () { onRemoveSchedule(item.id) },
                      }, t('scheduleRemove')),
                    )
                  }),
                ),
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
            React.createElement(
              'div',
              { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginTop: 4 } },
              t('scheduleCreateHint'),
            ),
          ),
        )
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

      function call(endpoint, payload) {
        var signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)])
        return ctx.connection.rpc.call('/api', endpoint, payload || {}, signal).then(function (reply) {
          if (!reply || reply.ok !== true) {
            var err = (reply && reply.error) || {}
            throw Object.assign(new Error(err.message || 'den status request failed'), { code: err.code })
          }
          return reply.value
        })
      }

      /**
       * One named action, carrying the current conversation where we know it.
       *
       * The active session id is read from the shell's own hook rather than
       * invented, because autonomy and schedules are both scoped per conversation
       * and a guessed id would silently target the wrong one.
       */
      function act(action, payload, sessionId) {
        var body = { action: action }
        for (var key in payload || {}) body[key] = payload[key]
        if (sessionId) body.sessionId = sessionId
        return call(RPC_ENDPOINT, body)
      }

      ctx.effect(function () {
        return function () {
          lifetime.abort()
        }
      })

      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_KEY, order: ORDER, label: function () { return t('nav') } }, Icon)
      })

      /**
       * Resolve the active conversation, which the panel needs for two reasons:
       * standing autonomy and schedules are both scoped per conversation, and a
       * guessed id would silently act on the wrong one.
       *
       * Two sources, in order of trust. The `main` slot's documented owner props
       * include `useSessions`, so prefer the shell's own hook; fall back to a
       * `ctx.sessions` probe; and if neither answers, report unknown rather than
       * invent an id. An invented session id is worse than a blank field.
       */
      function useActiveSession(props) {
        var fromHook = null
        try {
          if (typeof props.useSessions === 'function') {
            var snapshot = props.useSessions()
            fromHook = readSessionId(snapshot)
          }
        } catch (error) {
          fromHook = null
        }
        if (fromHook) return fromHook
        try {
          var sessions = ctx.sessions
          if (sessions && typeof sessions.current === 'function') return sessions.current() || null
          if (sessions && typeof sessions.activeId === 'function') return sessions.activeId() || null
        } catch (error) {
          return null
        }
        return null
      }

      /** Pull an id out of whichever snapshot shape the shell hands over. */
      function readSessionId(snapshot) {
        if (!snapshot) return null
        if (typeof snapshot === 'string') return snapshot
        if (typeof snapshot.activeId === 'string') return snapshot.activeId
        if (typeof snapshot.currentId === 'string') return snapshot.currentId
        if (snapshot.active && typeof snapshot.active.id === 'string') return snapshot.active.id
        if (snapshot.current && typeof snapshot.current.id === 'string') return snapshot.current.id
        return null
      }

      ctx.slots.inject('main', function () {
        return ctx.slots.register({ name: 'main', key: PANEL_KEY }, function Bound(props) {
          var sessionId = useActiveSession(props || {})
          return React.createElement(DenPanel, {
            t: t,
            call: call,
            act: act,
            sessionId: sessionId,
          })
        })
      })
    }

    module.exports = {
      name: 'dsh-den',
      /* Cordis *service* names — a different table from package.json's
       * `dsh.client.inject`, which lists package names. */
      inject: ['slots', 'locale', 'connection'],
      apply: apply,
    }
    return module.exports
  },
})
