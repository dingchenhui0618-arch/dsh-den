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
        footNote:
          'Read-only view. Granting or revoking autonomy is a human action and cannot be done from here.',
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
        recovered: '回收的崩溃残file',
        unavailable: '宿主未应答',
        errors: '最近错误',
        footNote: '只读视图。授予或撤销授权是人的动作，不能在这里完成。',
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

    function DenPanel(props) {
      var t = props.t
      var state = React.useState({ phase: 'loading', data: null, error: null })
      var view = state[0]
      var setView = state[1]

      var load = React.useCallback(function () {
        setView(function (prev) {
          return { phase: prev.data ? 'refreshing' : 'loading', data: prev.data, error: null }
        })
        props
          .call(RPC_ENDPOINT, {})
          .then(function (value) {
            setView({ phase: 'ready', data: value, error: null })
          })
          .catch(function (error) {
            setView(function (prev) {
              return { phase: 'error', data: prev.data, error: String((error && error.message) || error) }
            })
          })
      }, [props.call])

      React.useEffect(function () {
        load()
        var timer = setInterval(load, 15000)
        return function () {
          clearInterval(timer)
        }
      }, [load])

      var d = view.data
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

      if (d) {
        var autonomyText = d.autonomyKnown ? (d.autonomy ? t('autonomyOn') : t('autonomyOff')) : t('autonomyUnknown')
        var autonomyTone = d.autonomyKnown ? (d.autonomy ? 'success' : 'warn') : null
        var scenarios = (d.scenarios || []).map(function (s) {
          return s.scenario + ' (' + s.entries + ')'
        })

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
              value: d.kernel && d.kernel.running ? t('kernelOn') + ' · ' + t('lastTick') + ' ' + fmtTime(d.kernel.lastTickAt, t) : t('kernelOff'),
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

      ctx.effect(function () {
        return function () {
          lifetime.abort()
        }
      })

      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_KEY, order: ORDER, label: function () { return t('nav') } }, Icon)
      })

      ctx.slots.inject('main', function () {
        return ctx.slots.register({ name: 'main', key: PANEL_KEY }, function Bound() {
          return React.createElement(DenPanel, { t: t, call: call })
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
