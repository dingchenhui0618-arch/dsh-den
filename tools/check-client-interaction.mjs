/**
 * Interaction test for the browser bundle: render the panel, click its buttons,
 * type into its form, and assert on the RPC calls that come out.
 *
 * ## Why this exists, and why `check-client-bundle.mjs` is not enough
 *
 * That checker runs the bundle against a *stateless* React stand-in: `useState`
 * ignores updates and `useEffect` does nothing. That proves the module loads, both
 * slots register, and the first render does not throw — and it is blind to
 * everything after. A button whose handler is misspelled, or that sends the wrong
 * action name, renders perfectly and does nothing at all.
 *
 * So this harness implements a small but *real* React: hook slots persist across
 * renders, a state update re-renders, and effects run after each render with
 * cleanup. Then it drives the tree the way a human would and reads the RPC
 * traffic.
 *
 * No jsdom and no React install are needed — neither is available in this profile.
 * The tree is plain `{type, props, children}` objects, so it can be walked.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { allText, collect, createElement, findAll, textOf } from './panel-tree.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const bundlePath = resolve(root, pkg.exports['./client'])

const failures = []
let checkCount = 0
function check(ok, message) {
  checkCount += 1
  if (!ok) failures.push(message)
}

/* ------------------------------------------------------------- React shim */

/** The hook slots of whichever component is rendering right now. */
let activeHooks = null

const React = {
  createElement,
  useState(initial) {
    const hooks = activeHooks
    const index = hooks.cursor
    hooks.cursor += 1
    if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === 'function' ? initial() : initial
    const setter = (next) => {
      const current = hooks.slots[index]
      const value = typeof next === 'function' ? next(current) : next
      if (Object.is(value, current)) return
      hooks.slots[index] = value
      hooks.dirty = true
    }
    return [hooks.slots[index], setter]
  },
  useCallback(fn, deps) {
    const hooks = activeHooks
    const index = hooks.cursor
    hooks.cursor += 1
    const previous = hooks.slots[index]
    if (!previous || !sameDeps(previous.deps, deps)) hooks.slots[index] = { fn, deps }
    return hooks.slots[index].fn
  },
  useRef(value) {
    const hooks = activeHooks
    const index = hooks.cursor
    hooks.cursor += 1
    if (!(index in hooks.slots)) hooks.slots[index] = { current: value }
    return hooks.slots[index]
  },
  useEffect(fn, deps) {
    const hooks = activeHooks
    const index = hooks.cursor
    hooks.cursor += 1
    const previous = hooks.slots[index]
    if (previous && sameDeps(previous.deps, deps)) return
    if (previous && typeof previous.cleanup === 'function') previous.cleanup()
    const slot = { deps }
    hooks.slots[index] = slot
    hooks.pending.push({ fn, slot })
  },
}

function sameDeps(a, b) {
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) return false
  return true
}

/* ----------------------------------------------------------------- loading */

let loaded = null
/** What the panel reports about its own actions, via the debug sink. */
const sinkLog = []

/**
 * The host's answer for one request.
 *
 * The bundle posts `{ action, ...payload }` to the route. This resolves it against
 * whatever the current test scripted, which is how the panel's behaviour is driven
 * without a host process or an HTTP server.
 */
const transport = { calls: [], replies: {}, raw: null }

function fakeFetch(url, init) {
  let body = {}
  try {
    body = JSON.parse(init?.body ?? '{}')
  } catch {
    body = {}
  }
  transport.calls.push({ url, method: init?.method, body })

  // A raw reply models the failures that are not refusals: a 404 for an unmounted
  // route, or an HTML error page from something in front of the host. Every other
  // reply here is a 200 with a JSON envelope, so without this the panel's handling
  // of a non-JSON body would never run.
  if (transport.raw) {
    const { status = 404, text = '' } = transport.raw
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return JSON.parse(text)
      },
      async text() {
        return text
      },
    })
  }

  const reply = transport.replies[body.action]
  const value = typeof reply === 'function' ? reply(body) : reply
  const payload = value === undefined ? { ok: true, value: {} } : value
  return Promise.resolve({
    ok: true,
    status: 200,
    async json() {
      return payload
    },
    async text() {
      return JSON.stringify(payload)
    },
  })
}

/**
 * The browser object the panel looks for.
 *
 * This harness starts with no clipboard at all — a real browser state, not a convenience: a
 * hardened browser has none, so the failure path is what the panel meets here by default. The
 * check that needs the success path installs `writeText` on this object and takes it away again.
 */
const fakeNavigator = { clipboard: undefined }

/**
 * A storage the floating window can shut itself into.
 *
 * Without it the harness only ever sees the open panel, and the shut pill - the one part that has
 * to keep reporting while it is small - would be the only surface no check ever drove.
 */
const fakeStorage = (() => {
  const items = new Map()
  return {
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => { items.set(key, String(value)) },
    removeItem: (key) => { items.delete(key) },
  }
})()

const fakeResizeObservers = []
class FakeResizeObserver {
  constructor(callback) {
    this.callback = callback
    this.target = null
    fakeResizeObservers.push(this)
  }
  observe(target) { this.target = target }
  disconnect() { this.target = null }
}

const sandboxWindow = {
  __ModuleLoader__: { load: (spec) => { loaded = spec } },
  // The panel looks for this hook, so an offline harness can observe the
  // action state that no DOM would otherwise expose.
  __dshDenDebug: (event) => sinkLog.push(event),
  __dshDenDebugMode: Boolean(process.env.PROBE_SLOTS),
  localStorage: fakeStorage,
  ResizeObserver: FakeResizeObserver,
}
{
  const sandbox = {
    navigator: fakeNavigator,
    window: sandboxWindow,
    // The bundle reaches the host with the browser's own `fetch`, exactly like the
    // other client plugins. It is a global, not a `window` property, so it belongs
    // on the sandbox itself. Supplied here rather than having the bundle carry a
    // transport shim: a bundle that avoided `fetch` to be testable would not be
    // testing the thing that runs.
    fetch: fakeFetch,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    AbortSignal,
    Response,
    Error,
    Object,
    String,
    Number,
    JSON,
    Date,
    Array,
    isFinite,
  }
  vm.createContext(sandbox)
  new vm.Script(readFileSync(bundlePath, 'utf8'), { filename: bundlePath }).runInContext(sandbox)
}
check(Boolean(loaded), 'the bundle loads and registers itself')
check(loaded?.id === pkg.name, 'the module id equals the package name')

const exportsValue = loaded.factory((name) => {
  if (name === 'react') return React
  throw new Error(`the bundle requested a non-baseline module: ${name}`)
})

/* ------------------------------------------------------------ fake context */

let activeSession = 'session-active'
let renderedSession = null

/** Every request the bundle made, and the answers it was given. */
const calls = transport.calls
function scriptReplies(next) {
  Object.assign(transport.replies, next)
}
function clearReplies() {
  for (const key of Object.keys(transport.replies)) delete transport.replies[key]
}

function makeCtx() {
  return {
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    // The bundle reaches the host with `fetch` now, so there is no optional service
    // to probe; the stub stays here so a reintroduced probe is caught rather than
    // silently working.
    get: () => undefined,
    locale: { register: () => () => {}, locale: () => 'zh-CN' },
    sessions: { current: () => activeSession },
    slots: {
      entries: [],
      inject(_key, callback) {
        callback()
        return () => {}
      },
      register(options, component) {
        this.entries.push({ options, component })
        return () => {}
      },
    },
  }
}

/* -------------------------------------------------------- render machinery */

/** A fresh set of hook slots for one mounted component. */
function mountState() {
  return { slots: [], cursor: 0, pending: [], dirty: false }
}

/** The last mounted panel, so the report can stop its poll timer. */
const mounted = []
let lastMounted = null

/**
 * Mount the slot's registered component.
 *
 * A slot registration hands the shell a *component*, not an element, so it must
 * be rendered through `createElement` — calling it directly returns a nested
 * function and the walker then sees no DOM tree at all. Wrapping it also matches
 * how the shell invokes it, including the owner props.
 */
function mount(registered, props) {
  const Wrapper = (wrapperProps) => React.createElement(registered, wrapperProps)
  const hooks = mountState()
  let tree = null

  function render() {
    activeHooks = hooks
    hooks.cursor = 0
    tree = collect(React.createElement(Wrapper, props))
    activeHooks = null
    return tree
  }

  async function settle(rounds = 12) {
    for (let i = 0; i < rounds; i += 1) {
      // 1. Run any effects queued by the previous render.
      const queued = hooks.pending.splice(0, hooks.pending.length)
      let ranEffect = false
      for (const item of queued) {
        const cleanup = item.fn()
        item.slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
        ranEffect = true
      }

      // 2. Let promises started by those effects resolve. Their `.then` handlers
      //    call setState, which is what marks the tree dirty — so the flush has to
      //    happen *before* the dirty check, not after it.
      await new Promise((tick) => setImmediate(tick))
      await new Promise((tick) => setImmediate(tick))

      const needsRender = hooks.dirty || ranEffect || hooks.pending.length > 0
      if (!needsRender) break
      hooks.dirty = false
      render()
    }
    return tree
  }

  render()
  const handle = {
    hooks,
    render,
    settle,
    /** Run every effect cleanup, which stops the panel's poll timers. */
    unmount() {
      activeHooks = hooks
      for (const slot of hooks.slots) {
        if (slot && typeof slot.cleanup === 'function') {
          try {
            slot.cleanup()
          } catch (error) {
            /* a failing cleanup must not mask the checks */
          }
        }
      }
      activeHooks = null
    },
    get tree() {
      return tree
    },
    buttons: () => findAll(tree, (n) => n.type === 'button'),
    buttonLabels: () => findAll(tree, (n) => n.type === 'button').map((b) => textOf(b).trim()),
    inputs: () => findAll(tree, (n) => n.type === 'input'),
    text: () => allText(tree),
    async click(label) {
      const button = findAll(tree, (n) => n.type === 'button' && textOf(n).trim() === label)[0]
      if (!button) {
        throw new Error(
          `no button labelled ${JSON.stringify(label)}; present: ${findAll(tree, (n) => n.type === 'button').map((b) => textOf(b).trim()).join(' | ') || '(none)'}`,
        )
      }
      button.props.onClick?.()
      await settle()
    },
    /**
     * Press a button that has no text of its own, found by its accessible name.
     *
     * The window's send control is an arrow glyph with `aria-label="发送"`, which is the right shape
     * for a 286px card and invisible to `click(label)`. A screen reader finds it by that label, and so
     * does this.
     */
    async press(label) {
      const button = findAll(tree, (n) => n.type === 'button' && n.props?.['aria-label'] === label)[0]
      if (!button) {
        throw new Error(
          `no button with the accessible name ${JSON.stringify(label)}; present: ${findAll(tree, (n) => n.type === 'button').map((b) => b.props?.['aria-label'] || textOf(b).trim()).join(' | ') || '(none)'}`,
        )
      }
      button.props.onClick?.()
      await settle()
    },
    async type(index, value) {
      const inputs = findAll(tree, (n) => n.type === 'input')
      const input = inputs[index]
      if (!input) throw new Error(`no input at index ${index}; the panel renders ${inputs.length}`)
      input.props.onChange?.({ target: { value } })
      await settle()
    },
  }
  lastMounted = handle
  mounted.push(handle)
  return handle
}

/* ------------------------------------------------------------------- suite */

function boot({ sessionId = 'session-active', scripted = {} } = {}, slot = 'main') {
  calls.length = 0
  // Merge rather than replace: a test that scripts one action and then boots would
  // otherwise silently lose the reply it just installed, which reads as the panel
  // ignoring the response.
  scriptReplies(scripted)
  activeSession = sessionId
  const ctx = makeCtx()
  exportsValue.apply(ctx)
  const entry = ctx.slots.entries.find((entry) => entry.options?.name === slot)
  if (!entry) throw new Error(`the bundle did not register a ${slot} entry`)
  return entry.component
}

/**
 * The per-conversation control's registered component, from the seat that actually hands one over.
 *
 * `mount(component, { useSessions: () => ({ activeId: 'session-active' }) })` used to stand in for the
 * shell here, and it proved nothing: `activeId` was a shape the client and the double had agreed on
 * between themselves, while the live `sessions` service has no `current()` and no `activeId()` at all.
 * The seat below is the one whose own live catalog lists `sessionId: SessionId` among its standard
 * props, so the id arrives as a prop and there is nothing left to guess.
 */
function bootWindow({ scripted = {} } = {}) {
  calls.length = 0
  scriptReplies(scripted)
  const ctx = makeCtx()
  exportsValue.apply(ctx)
  const dock = ctx.slots.entries.find((entry) => entry.options?.name === 'shell.overlay')
  if (!dock) throw new Error('the bundle did not register a floating-window entry')
  return { component: dock.component, options: dock.options }
}

/**
 * The snapshot the host would return for a healthy den.
 *
 * Note the shape: the panel's `call` already unwraps the RPC envelope and rejects
 * on `ok !== true`, so a scripted reply is the bare `{ok, value}` — not the full
 * `server-response` frame the route writes onto the wire.
 */
const demoRender = process.argv.includes('--demo')
const demoStatusTime = Date.parse('2026-10-15T00:00:00.000Z')

function healthyStatus(overrides = {}) {
  const statusTime = demoRender ? demoStatusTime : Date.now()
  return {
    ok: true,
    value: {
      generatedAt: statusTime,
      name: 'Den',
      home: 'C:\\Users\\123\\.dsh\\den',
      autonomy: null,
      autonomyKnown: true,
      nextCheckAt: null,
      ledger: { turns: 3, spoken: 1, skipped: 2, refused: 0 },
      notices: { total: 1, deliverable: 1, expired: 0 },
      triggers: { total: 1, invalid: 0, due: 0 },
      kernel: { running: true, lastTickAt: statusTime, lastError: null },
      tasks: { active: 2, blocked: 1, waiting: 1, total: 3 },
      kernelDeferred: null,
      gate: { mounted: true, recent: [] },
      scenarios: [{ scenario: 'personal', entries: 2 }],
      recentEvents: [],
      reapedTempFiles: 0,
      route: { mounted: true, reason: null, message: null },
      ...overrides,
    },
  }
}

const component = boot({ scripted: { status: healthyStatus(), 'schedules/list': { ok: true, value: { schedules: [], invalidCount: 0 } } } })
const panel = mount(component, {})
await panel.settle()

if (process.env.DEN_DEBUG) {
  console.log('calls:', JSON.stringify(calls, null, 2))
  console.log('hook slots:', JSON.stringify(panel.hooks.slots.map((s) => (s && s.deps) || s), null, 2))
  console.log('tree text:', panel.text())
  console.log('elements:', findAll(panel.tree, () => true).map((n) => `${n.type}#${JSON.stringify(textOf(n)).slice(0, 40)}`).join('\n  '))
}

/* --- the panel renders the real state ------------------------------------- */

const text = panel.text()
check(text.includes('常驻助理') && !text.includes('Den ——'), 'the panel renders its title, lowercase to match the nav entry')
check(text.includes('常驻控制台') && text.includes('先看信号'), 'the status page opens with a clear control-room hierarchy')
check(panel.buttons().some((button) => textOf(button).trim() === '↻'), 'the page exposes an explicit refresh control')
check(findAll(panel.tree, (node) => node.props?.style?.gridTemplateColumns === 'repeat(auto-fit, minmax(132px, 1fr))').length === 1, 'the summary uses a responsive signal rail instead of a flat paragraph')
check(text.includes('工具受保护'), 'the approval state is stated in plain language when the gate is armed')
check(text.includes('进行中 2'), 'the plain line carries the task count once there is work')
check(text.includes('卡住 1'), 'a stuck step rides on that same line, not behind details')
  check(text.includes('等你 1'), 'and the step that is waiting on the person is on that line too')
  check(text.includes('怎么用'), 'the panel itself says how to ask, so the person does not have to be told')// Looking for the *string* would pass on the copy that says where the control is, so this looks for a
// button: an affordance the page would have to render to be clickable.
check(
  !panel.buttons().some((button) => textOf(button).trim() === '授予'),
  'the status page renders no grant button, because it has no conversation to grant for',
)
check(text.includes('浮窗里授予'), 'and it says where the grant control is instead')
check(text.includes('自检'), 'the panel renders the self-check section')
check(text.includes('运行中'), 'a running heartbeat is reported as running')
check(text.includes('今天') === false, 'no stray copy is invented')

/* --- the snapshot request carries the session ------------------------------ */

const statusCall = calls.find((entry) => (entry.body?.action ?? 'status') === 'status')
check(Boolean(statusCall), 'the panel requests a status snapshot')
check(statusCall?.body?.action === 'status', 'the snapshot request names the status action explicitly')
check(
  statusCall?.body?.sessionId == null,
  'the status page sends no conversation id, because it has none to send',
)
// Read here, before the dock below is mounted: `calls` is shared, so a check placed after that mount
// would be reading the dock's requests while describing this page.
const pageSchedules = calls.find((entry) => entry.body?.action === 'schedules/list')
check(
  Boolean(pageSchedules),
  'the status page asks for schedules even with no conversation, because the host answers with all of them',
)
check(
  pageSchedules?.body?.sessionId == null,
  'and it asks without naming a conversation, since it has none to name',
)

/* --- the panel says whether the running process loaded this code ----------- */

/**
 * The page as it renders for a given freshness verdict from the host.
 *
 * A healthy-looking panel is precisely what makes a stale host invisible, so the verdict has
 * to reach the panel: the human is the only one who can restart DSH, and this is the one place
 * they are already looking.
 */
async function mainPanelWith(freshness, overrides = {}) {
  const component = boot({
    scripted: {
      status: healthyStatus({ freshness, ...overrides }),
      'schedules/list': { ok: true, value: { schedules: [], invalidCount: 0 } },
    },
  })
  const mounted = mount(component, {})
  await mounted.settle()
  return mounted.text()
}

const staleText = await mainPanelWith({ known: true, stale: true, newestSourceFile: 'client\\client.js', toleranceMs: 1000 })
check(staleText.includes('比代码树旧'), 'a stale instance is reported as stale where the human is already looking')
check(staleText.includes('client\\client.js'), 'and it names the file that is newer than the running process')

const currentText = await mainPanelWith({ known: true, stale: false, newestSourceFile: 'src/index.js' })
check(currentText.includes('与代码树一致'), 'a current instance says so, on the same row')

const unknownText = await mainPanelWith({ known: false, stale: null, detail: 'this instance did not say when it loaded' })
check(unknownText.includes('判断不了'), 'an instance that cannot judge itself says so')
check(
  !unknownText.includes('与代码树一致'),
  'which is the point: "I cannot tell" must not render as "fine"',
)
const directToolsText = await mainPanelWith(null, { gate: { mounted: false, recent: [] } })
check(directToolsText.includes('工具直通'), 'an explicitly disabled approval gate is explained as direct tool access, not as a red failure')

/* --- the floating window sits in the one seat the shell gives it -------- */

const dock = bootWindow({ scripted: { status: healthyStatus(), 'schedules/list': { ok: true, value: { schedules: [], invalidCount: 0 } } } })
check(
  dock.options.name === 'shell.overlay',
  'the window registers into the shell overlay, outside every conversation frame',
)
// The catalog's own rule: "a fresh id is added beside the shipped entries, while reusing a shipped id
// puts you in THAT cell and replaces it." Reusing one of these would silently delete a shell control.
check(
  dock.options.id === 'den-mini',
  `the window uses its own id so it adds a cell instead of replacing one (got ${dock.options.id})`,
)
check(
  dock.options.id !== sidebarEntryId(),
  'and does not reuse the sidebar\u2019s id, which would put the panel and the window in one cell',
)
const dockWindow = mount(dock.component, {})
await dockWindow.settle()
// The preview page used to draw this section from `dock.tree`, and `dock` is the *registration
// descriptor* — `bootWindow` returns `{component, options}` and nothing else, so there is no tree on it
// and the section titled "the floating card" rendered as an empty box from the day it was written.
// Nobody saw it: a section that draws nothing still renders, still passes every check, and is only
// visible to the person the page is for. Pinned here so the next rewrite of that line is caught.
check(
  dockWindow.tree !== undefined &&
    findAll(dockWindow.tree, (node) => node.props?.style?.width === 286 && node.props?.style?.height === 216).length === 1,
  'the window the preview page draws is the mounted card, not the descriptor object that carries no tree',
)
const dockStatus = calls.find((entry) => (entry.body?.action ?? 'status') === 'status')
check(
  dockStatus?.body?.sessionId == null,
  'the window asks for status without a conversation, because it belongs to none',
)

check(text.includes('在对话里说'), 'an empty schedule list is called out, and names the cheaper path: saying it')
check(text.includes('消息框里说一句'), 'and creating one is described as something said, not a form to go and find')

/* --- the window carries no way to act on the person's behalf --------------- */

// The window reads den's state and carries the person's words, and that is all it does. The grant
// control it used to carry is gone with the permission tab: a shape that offered to grant standing
// authority from the always-on surface was the one control the window should never have had.
//
// These are pinned as counts, not as "a label is missing". A checklist of forbidden strings passes the
// moment somebody rewrites the copy, while a count of controls that are not collapse/details/shortcuts/
// composer fails the moment one is added back under any name at all. `活动`/`对话` left this list with
// the tab strip itself: they are no longer labels any control in this window may carry.
const WINDOW_CONTROL_LABELS = ['收起', '−', '详情', '查看活动', '解释状态', '运行自检', '发送', '↗']
const foreignWindowControls = (handle) =>
  handle
    .buttons()
    .map((button) => textOf(button).trim())
    .filter((label) => !WINDOW_CONTROL_LABELS.includes(label))

const noHandsWindow = mount(
  bootWindow({
    scripted: { status: healthyStatus(), 'schedules/list': { ok: true, value: { schedules: [], invalidCount: 0 } } },
  }).component,
  { sessionId: 'session-active' },
)
await noHandsWindow.settle()
check(
  foreignWindowControls(noHandsWindow).length === 0,
  `the floating window offers nothing but its own views and one box to type in (saw ${JSON.stringify(foreignWindowControls(noHandsWindow))})`,
)
check(
  !noHandsWindow.text().includes('授予') && !noHandsWindow.text().includes('撤销'),
  'and carries no grant or revoke control, so nothing in it can change den\'s authority',
)
check(
  !noHandsWindow.text().includes('工具受保护') && !noHandsWindow.text().includes('工具直通'),
  'and says nothing about the approval gate, armed or direct: this window cannot answer a gate question',
)
check(
  !calls.some((entry) => entry.body?.action === 'autonomy/request' || entry.body?.action === 'autonomy/confirm'),
  'and opening it asks for no authority at all',
)
check(
  noHandsWindow.inputs().length === 1,
  `and its one input is the message box, not a form (saw ${noHandsWindow.inputs().length})`,
)

/* --- the window's three states, and no fourth ------------------------------ */

/**
 * The state dot the window drew for one scripted status.
 *
 * `data-state` is the contract: it is read from the settled tree, so a check cannot pass on a label
 * that happens to be on screen from an unrelated row — and it cannot pass on the first render either,
 * which has no snapshot yet and honestly reports `quiet` until one arrives.
 */
async function windowMode(status) {
  const handle = mount(bootWindow({ scripted: { status: { ok: true, value: status } } }).component, {})
  await handle.settle()
  const dot = findAll(handle.tree, (node) => node.props?.['data-dsh-role'] === 'status-dot')[0]
  if (process.env.PROBE_SLOTS) {
    console.log('  renders:', JSON.stringify(sandboxWindow.__probe || []))
    console.log('  modes:', JSON.stringify(sandboxWindow.__probeModes || []))
  }
  return { handle, state: dot?.props?.['data-state'], color: String(dot?.props?.style?.background || '') }
}

/**
 * The text of the window's always-on activity rail, as drawn.
 *
 * Read off the rail node rather than off the whole tree on purpose: `运行中` also occurs inside the
 * measurements the fold hides (`常驻中 · 心跳运行中`), so a check that searched the tree could pass on a
 * row nobody can see and report the one line that is always on screen as saying something it does not.
 */
const railTextOf = (handle) =>
  textOf(findAll(handle.tree, (node) => node.props?.['data-dsh-role'] === 'pet-rail')[0])

// `healthyStatus()` is den's healthy week: it carries a step parked on the person
// (`tasks.waiting: 1`), which is exactly what the amber state is for — the pill's own state check
// further down pins that reading. So a check about "nothing owed" has to say so in its fixture:
// the claim is about the state a live heartbeat with an empty to-do list gets, and a fixture that
// borrows `healthyStatus()` whole would be asserting the claim against the opposite input.
const NOTHING_OWED = { notices: { total: 0, deliverable: 0, expired: 0, pending: [] }, tasks: { active: 0, blocked: 0, waiting: 0, total: 0 }, triggers: { total: 0, invalid: 0, due: 0 }, kernelDeferred: null }

const idleDot = await windowMode({ ...healthyStatus().value, ...NOTHING_OWED })
check(idleDot.state === 'running', `a live heartbeat with nothing owed is running (saw ${idleDot.state})`)
// This used to read the activity *view*, which only existed once its tab had been pressed. The rail is
// always on screen, so the claim is now the stronger one: the word that goes with the light is in the
// line under the bar on the open, with nothing pressed to get it there.
check(
  railTextOf(idleDot.handle).includes('运行中') && railTextOf(idleDot.handle).includes('没有新信号'),
  `and the always-on rail says in words what the green light means (saw ${JSON.stringify(railTextOf(idleDot.handle))})`,
)
// The notice is put in `notices.pending`, which is the field the host fills with the text of what is
// owed (`src/index.js`), and the to-do list is emptied so the amber light can only come from the
// notice: a fixture that also parked a step on the person would light up either way and prove neither.
const waitingDot = await windowMode({
  ...healthyStatus().value,
  ...NOTHING_OWED,
  notices: { total: 1, deliverable: 1, expired: 0, pending: [{ id: 'notice-1', text: '磁盘快满了', createdAt: 1 }] },
})
check(waitingDot.state === 'waiting', `an unread notice for the person is waiting, not running (saw ${waitingDot.state})`)
// The other two states, in the same always-on line: the three words the design names have to be
// readable on the rail, not only encoded in the colour of the light beside them.
check(
  railTextOf(waitingDot.handle).includes('等待你') && railTextOf(waitingDot.handle).includes('1 个信号'),
  `and the rail names the amber state and what put it there (saw ${JSON.stringify(railTextOf(waitingDot.handle))})`,
)
const dueDot = await windowMode({ ...healthyStatus().value, ...NOTHING_OWED, triggers: { total: 1, invalid: 0, due: 1 } })
check(dueDot.state === 'waiting', `a self-check that came due is waiting too (saw ${dueDot.state})`)
const offDot = await windowMode({ ...healthyStatus().value, kernel: { running: false, lastTickAt: 1, lastError: null } })
check(offDot.state === 'quiet', `a stopped heartbeat is quiet rather than a fault to chase (saw ${offDot.state})`)
const spentDot = await windowMode({ ...healthyStatus().value, dailyTurnBudget: 0 })
check(spentDot.state === 'quiet', `a zero daily budget is quiet, because den may start nothing today (saw ${spentDot.state})`)
check(
  railTextOf(spentDot.handle).includes('安静'),
  `and the rail says 安静 rather than leaving the grey light unexplained (saw ${JSON.stringify(railTextOf(spentDot.handle))})`,
)

// The mode the old design called `approval` no longer exists in any input: a busy gate is not a
// fourth state, because the light would ask for a decision this window cannot take. The rest of the
// snapshot is emptied so the expected `running` is a claim about the gate alone — with work also
// parked on the person the light would be amber whatever the gate did, and the check would pass
// without ever having exercised the thing it is named after.
const busyGateDot = await windowMode({
  ...healthyStatus().value,
  ...NOTHING_OWED,
  gate: { mounted: true, recent: [{ at: Date.now(), decision: 'ask', tool: 'web_fetch' }] },
})
check(
  busyGateDot.state === 'running',
  `a pending approval is not a state this window reports (saw ${busyGateDot.state})`,
)
check(
  foreignWindowControls(busyGateDot.handle).length === 0,
  `and a busy gate adds no control for answering it (saw ${JSON.stringify(foreignWindowControls(busyGateDot.handle))})`,
)
check(
  !findAll(busyGateDot.handle.tree, (node) => node.props?.['data-dsh-role'] === 'permission-card').length,
  'and renders no approval card, whatever the gate is doing',
)

/* --- the resident is visible without opening anything -------------------------------------------- */

// The resident is discoverable as a sidebar row, while the floating pet remains the always-on
// compact surface. The row is `sidebar.panellist`; a separate toggle badge is intentionally not
// added because den has its own status dot and that badge belongs to the shell's global toggle.
// A probe with its own context: `boot()` would clear `calls` and reset the scripted replies, which the
// checks further down still read.
function registersSlot(name) {
  const probe = makeCtx()
  exportsValue.apply(probe)
  return probe.slots.entries.some((entry) => entry.options && entry.options.name === name)
}
/**
 * den's own sidebar entry id, probed without clearing `calls`.
 *
 * The window and the page must not share an id: reusing the sidebar's key would put the floating
 * window in the sidebar's cell. Read from a probe context with its own `apply`, because `boot()`
 * resets the scripted replies the checks further down still read.
 */
function sidebarEntryId() {
  const probe = makeCtx()
  exportsValue.apply(probe)
  const entry = probe.slots.entries.find((item) => item.options?.name === 'sidebar.panellist')
  return entry?.options?.id
}
check(registersSlot('sidebar.panellist'), 'den is discoverable from the sidebar panel list')
check(!registersSlot('sidebar.toggle.badge'), 'and puts no dot in the sidebar toggle either')
check(registersSlot('shell.overlay'), 'and a floating window in the shell overlay, outside every conversation frame')
/* --- shut, the floating window still has to report ---------------------------- */

fakeStorage.setItem('dsh-den.mini', JSON.stringify({ collapsed: true }))
const shutWindow = boot(
  { scripted: { status: healthyStatus(), 'schedules/list': { ok: true, value: { schedules: [], invalidCount: 0 } } } },
  'shell.overlay',
)
const shutPanel = mount(shutWindow, {})
await shutPanel.settle()
// The pill fetches its numbers in an effect, so one settle is not enough: the poll needs a turn.
await shutPanel.settle()
const shutButton = shutPanel.buttons().find((button) => button.props?.['aria-label']?.includes('打开 den 面板'))
const shutLabel = String(shutButton?.props?.['aria-label'] || '')
check(
  shutLabel.includes('\u8fd0\u884c\u4e2d'),
  'the shut floating window keeps the state it can see in its accessible label',
)
check(
  shutLabel.includes('\u6709\u8bdd\u60f3\u8ddf\u4f60\u8bf4'),
  'and keeps how many things it has for the person in that label',
)
check(
  shutLabel.split('\u00b7').length >= 3 && shutButton?.children?.length === 1,
  'and keeps the facts accessible while the visible control shrinks to den\'s mark and a dot',
)
fakeStorage.setItem('dsh-den.mini', JSON.stringify({ collapsed: false }))

/* --- open again, because the pill is a control, not a dead end ---------------- */

const openedPanel = mount(shutWindow, {})
await openedPanel.settle()
check(
  !openedPanel.text().includes('\u6709\u8bdd\u60f3\u8ddf\u4f60\u8bf4 \u2014'),
  'and opening it again shows the panel rather than the pill',
)

// --- the window says what it can and cannot do ----------------------------------------------------
//
// This block used to drive the grant strip and its copy control — a token the window handed to the
// person so they could carry it to a conversation. The strip is gone with the permission tab, and
// with it the whole class of checks that watched a window hand out authority. What replaces them
// watches the two directions the window still has: typing into it, and being told the host is older.

const panelPrompt = mount(
  bootWindow({
    scripted: {
      status: healthyStatus(),
      'conversation/read': { ok: true, value: { sessionId: 'sess-prompt', state: 'live', total: 0, truncated: false, messages: [] } },
      'conversation/say': { ok: true, value: { messageId: 'den-say-2', sessionId: 'sess-prompt', state: 'live' } },
    },
  }).component,
  {},
)
await panelPrompt.settle()
check(
  (panelPrompt.inputs()[0]?.props?.placeholder || '').includes('问 den 一句'),
  'the message box names itself as the way to talk to den',
)
await panelPrompt.type(0, '帮我看一眼 CI')
check(
  (findAll(panelPrompt.tree, (node) => node.props?.['data-dsh-role'] === 'pet-input')[0]?.props?.value || '') === '帮我看一眼 CI',
  'and keeps what was typed in it',
)
await panelPrompt.press('发送')
check(
  calls.some((entry) => entry.body?.action === 'conversation/say' && entry.body?.text === '帮我看一眼 CI'),
  'and Send posts exactly that sentence to the standing conversation',
)

/* --- creating a self-check sends the right payload ------------------------ */

const panel3 = mount(
  bootWindow({ scripted: { status: healthyStatus(), 'schedules/list': { ok: true, value: { schedules: [], invalidCount: 0 } } } }).component,
  { sessionId: 'session-active' },
)
await panel3.settle()

// The window carries no conversation, so there is no schedule form here at all: `schedules/create`
// refuses without one, and a schedule with nowhere to speak is not worth making. This was measured
// the other way first — the whole form, three labelled inputs and a button, once rendered
// permanently above the message box and took most of a screen.
check(panel3.inputs().length === 1, `the window has exactly one input, the message box; saw ${panel3.inputs().length}`)
// The send control is an arrow with an accessible name rather than a word, so it is found the way a
// person using a screen reader would find it.
const sendButton = (handle) => handle.buttons().find((button) => button.props?.['aria-label'] === '发送')
check(Boolean(sendButton(panel3)), 'and one way to send what is typed')
check(!panel3.text().includes('新建自检'), 'and no submit button')
check(!panel3.buttons().some((button) => textOf(button).trim() === '新建'), 'and nothing that would open a form')
// The empty state is in the window's body, which is on screen the moment the window is, so this is a
// claim about the open with no press in between. It used to need the conversation tab pressed first —
// and that press is exactly what the user reported as the cost (2026-10-16).
check(panel3.text().includes('还没有对话'), 'an empty conversation says how to start one, without opening anything')
check(
  findAll(panel3.tree, (node) => node.props?.['data-dsh-role'] === 'pet-chat')[0]?.props?.style?.display === 'flex',
  'and the transcript is the window body, drawn on the open instead of hidden behind a tab',
)

check(
  !calls.some((entry) => entry.body?.action === 'schedules/create'),
  'nothing was created: a schedule with no conversation has nowhere to speak',
)
check(text.includes('不是权限授予'), 'the panel states that a schedule is not a permission grant')

/* --- the form is unreachable without a conversation, on both surfaces ------ */

// This scenario used to drive the form and assert that a sub-5-minute interval is refused locally.
// The form is now gated on having a conversation and no surface carries one, so that path is
// unreachable rather than merely untested; the interval rule itself is still covered by the host
// tests. Keeping the old interaction would only assert that a missing button is missing.
check(!text.includes('新建自检'), 'the page offers no submit either: with no conversation there is nothing to bind a schedule to')

/* --- an existing schedule can be removed ---------------------------------- */

const panel5 = mount(
  boot({
    scripted: {
      status: healthyStatus(),
      'schedules/list': {
        ok: true,
        value: { schedules: [{ id: 'sch-1', kind: 'interval', title: 'CI watch', enabled: true, fireCount: 4, dueNow: true }], invalidCount: 0 },
      },
    },
  }),
  {},
)
await panel5.settle()
// The list belongs to den's page now: the window is the conversation.
await panel5.click('详情')
await panel5.settle()
check(panel5.text().includes('CI watch'), 'an existing schedule is listed by title')
check(panel5.text().includes('待触发'), 'a due schedule is marked as due')
await panel5.click('删除')
const deleteCall = calls.find((entry) => entry.body?.action === 'schedules/delete')
check(deleteCall?.body?.id === 'sch-1', 'removing a schedule sends its id')

/* --- a deferred heartbeat is reported as a problem, not as silence --------- */

const panel6 = mount(
  boot({
    scripted: {
      status: healthyStatus({
        kernel: null,
        kernelDeferred: { reason: 'no delivery path available in this profile', attempts: 3, retrying: true },
      }),
      'schedules/list': { ok: true, value: { schedules: [], invalidCount: 0 } },
    },
  }),
  { sessionId: 'session-active' },
)
await panel6.settle()
check(panel6.text().includes('等待投递通道'), 'a deferred heartbeat is shown as waiting, not as running')
check(panel6.text().includes('3/24'), 'the retry progress is shown')

const panel7 = mount(
  boot({
    scripted: {
      status: healthyStatus({
        kernel: null,
        kernelDeferred: { reason: 'no delivery path available in this profile', attempts: 24, retrying: false },
      }),
      'schedules/list': { ok: true, value: { schedules: [], invalidCount: 0 } },
    },
  }),
  { sessionId: 'session-active' },
)
await panel7.settle()
check(panel7.text().includes('已放弃'), 'giving up on the heartbeat is stated plainly')

/* --- a standby host is reported as standby, not as a fault ---------------- */

// Standing down is correct behaviour when another host holds residency over the same state tree,
// so it must not read as a broken heartbeat: an operator sent hunting a fault that is not there
// is the cost of getting this wrong. Both directions are pinned, because a branch that labels
// every host standby would pass the first check on its own.
const standbyPanel = mount(
  boot({
    scripted: {
      status: healthyStatus({ residency: { held: false, holderPid: 4242, staleMs: 180_000, lastError: null } }),
      'schedules/list': { ok: true, value: { schedules: [], invalidCount: 0 } },
    },
  }),
  { sessionId: 'session-active' },
)
await standbyPanel.settle()
check(standbyPanel.text().includes('待命'), 'a host that stood down says standby instead of "running"')
check(standbyPanel.text().includes('4242'), 'and names the process that holds residency')

const holdingPanel = mount(
  boot({
    scripted: {
      status: healthyStatus({ residency: { held: true, holderPid: null, staleMs: 180_000, lastError: null } }),
      'schedules/list': { ok: true, value: { schedules: [], invalidCount: 0 } },
    },
  }),
  { sessionId: 'session-active' },
)
await holdingPanel.settle()
check(!holdingPanel.text().includes('待命'), 'while the host that holds residency is not labelled standby')

/* --- no session is no impediment, because there is nothing to grant --------- */

// The window used to carry a grant control whose `revoke` half was disabled without a conversation.
// Both halves are gone: an assistant that reads everything, drafts, and never writes needs no
// authority button on the surface that is always on screen — and the disabled state that used to be
// pinned here cannot arise at all any more. What is pinned instead is that the window renders, and
// asks for nothing, even when the host says nothing about autonomy and no session is handed over.
const panel8 = mount(
  boot({ scripted: { status: healthyStatus({ autonomyKnown: false }), 'schedules/list': { ok: true, value: { schedules: [], invalidCount: 0 } } } }, 'shell.overlay'),
  { sessionId: null },
)
await panel8.settle()
check(panel8.buttons().length > 0, 'the floating window renders with no session handed to it at all')
check(
  foreignWindowControls(panel8).length === 0,
  `and asks for nothing, offering no grant, approve or deny control (saw ${JSON.stringify(foreignWindowControls(panel8))})`,
)

/* --- the window is the conversation: what was said, and a way to say more --- */

/* --- the window is the conversation: what was said, and a way to say more --- */

const panelTalk = mount(
  bootWindow({
    scripted: {
      status: healthyStatus(),
      'conversation/read': {
        ok: true,
        value: {
          sessionId: 'sess-standing',
          state: 'stored',
          // The host names the path it read (`src/conversation.js`): store, log, or none. Without it
          // here the window was shown a reply the real host never sends, and reported — correctly —
          // that it had not been told where the transcript came from.
          readFrom: 'store',
          total: 12,
          truncated: true,
          messages: [
            { role: 'user', text: 'are you awake?', seq: 11, time: 1 },
            { role: 'assistant', text: 'awake, and nothing is on fire', seq: 12, time: 2 },
          ],
        },
      },
      'conversation/say': { ok: true, value: { messageId: 'den-say-1', sessionId: 'sess-standing', state: 'live' } },
    },
  }).component,
  {},
)
await panelTalk.settle()
// The window used to ship a two-word tab strip, and the transcript was only mounted once `对话` had
// been pressed — so opening the window showed activity and nothing else, which is the press the user
// reported as the cost ("好了已经 活动/对话 都放在一起 这样还得切换才能看到对话内容多麻烦", 2026-10-16).
// What is pinned here is the replacement fact, not a weaker one: there is no tab left to press, the
// transcript is asked for *by the open itself*, and the rail's sentence is on screen with the messages.
const petTabs = findAll(panelTalk.tree, (node) => node.props?.['data-dsh-role'] === 'pet-tab')
check(petTabs.length === 0, `the window offers no tab strip to switch views with (saw ${petTabs.length})`)
check(
  findAll(panelTalk.tree, (node) => node.props?.['data-dsh-role'] === 'pet-rail').length === 1,
  'and the activity it used to be one of is a rail under the bar instead of a screen of its own',
)
const chatRequestsAtOpen = calls.filter((entry) => entry.body?.action === 'conversation/read').length
check(
  chatRequestsAtOpen >= 1,
  `opening the window is what asks the host for the transcript, before anything in it is pressed (saw ${chatRequestsAtOpen} read(s))`,
)
check(
  findAll(panelTalk.tree, (node) => node.props?.['data-dsh-role'] === 'pet-chat').length === 1,
  'and the open, not a press, is what draws it',
)
check(
  !findAll(panelTalk.tree, (node) => node.props?.['data-dsh-role'] === 'permission-card').length,
  'and there is no permission card anywhere in it',
)
// The point of the change in one assertion: the messages and the rail's sentence are in the same
// render, with no press between them. Both halves are named, so a rail that rendered empty fails.
check(
  railTextOf(panelTalk).includes('2 个信号') && panelTalk.text().includes('are you awake?'),
  `and the rail's activity sentence is on screen together with the messages (rail: ${JSON.stringify(railTextOf(panelTalk))})`,
)
check(panelTalk.text().includes('are you awake?'), 'the window shows what was said to den')
check(panelTalk.text().includes('awake, and nothing is on fire'), 'and what den said back')
check(
  panelTalk.text().includes('更早的消息仍在磁盘转录里'),
  'and says so when it is showing only a tail of the transcript',
)
// Where the transcript came from is stated rather than inferred: the host answers from a live
// session, a stored session, or the log on disk, and a window that silently fell back to the log was
// read as "den lost the conversation" (measured 2026-10-15).
check(panelTalk.text().includes('来自会话存储'), 'and names the store as where it read them')
// The old design's other direction — pressing `活动` folded the transcript away — is gone with the
// tabs. What replaces it is the rail's own fold, and the fact worth pinning is that folding the
// measurements does *not* take the conversation off screen: it is a line of chrome, not a screen.
const detailsToggle = findAll(panelTalk.tree, (node) => node.props?.['data-dsh-role'] === 'pet-details-toggle')[0]
check(Boolean(detailsToggle), 'the rail carries a fold for the measurements, under its own accessible name')
check(
  findAll(panelTalk.tree, (node) => node.props?.['data-dsh-role'] === 'pet-details').length === 0,
  'and it starts folded, so the window opens on the conversation rather than on a wall of numbers',
)
detailsToggle?.props?.onClick()
await panelTalk.settle()
// Measured in a real browser at the shipped 286×216 (2026-10-16): as a flex row under the rail, the
// four measurements took 113px and the transcript box got 0px — so "the transcript is still on screen"
// was false while a check reading `display: flex` said it was true. The sheet hangs from the rail now,
// and what is pinned is the thing that made the difference: it is positioned, not a row.
const unfoldedSheet = findAll(panelTalk.tree, (node) => node.props?.['data-dsh-role'] === 'pet-details')[0]
check(
  unfoldedSheet?.props?.style?.position === 'absolute' && unfoldedSheet?.props?.style?.top === '100%',
  'and the measurements hang under the rail as a sheet instead of taking a row away from the transcript',
)
check(
  unfoldedSheet?.props?.style?.overflowY === 'auto' &&
    Number(unfoldedSheet?.props?.style?.maxHeight) > 0 &&
    findAll(panelTalk.tree, (node) => node.props?.['data-dsh-role'] === 'pet-chat')[0]?.props?.style?.display === 'flex',
  'and the sheet is bounded and scrolls while the transcript keeps its own height behind it',
)
check(
  railTextOf(panelTalk).includes('心跳运行中') && railTextOf(panelTalk).includes('上次心跳'),
  `and what it reveals is the heartbeat reading the sentence above does not carry (saw ${JSON.stringify(railTextOf(panelTalk))})`,
)
// The count is written before its noun, the way the sentence above spells it. The folded rows said
// `个信号 · 2` — a fragment, not a phrase — and no check could see it: it is grammar, not structure, and
// it took reading the generated page (2026-10-16) to notice. Read off the sheet, not the rail: the
// sentence legitimately contains `2 个信号 · 等你 1`, so the rail's own text cannot tell the two apart.
check(
  textOf(unfoldedSheet).includes('2 个信号') && !textOf(unfoldedSheet).includes('个信号 · '),
  `and its counts read as phrases rather than fragments (saw ${JSON.stringify(textOf(unfoldedSheet))})`,
)
// The toggle is looked up again rather than reused: its handler closes over the state of the render it
// was built in, so pressing the *old* node a second time would ask for the fold to be opened again —
// the same value, no re-render, and a check that read that as "still open" would be measuring the
// harness. Re-reading the control is what makes the second press a press on the window as it now is.
findAll(panelTalk.tree, (node) => node.props?.['data-dsh-role'] === 'pet-details-toggle')[0]?.props?.onClick()
await panelTalk.settle()
check(
  findAll(panelTalk.tree, (node) => node.props?.['data-dsh-role'] === 'pet-details').length === 0,
  'and folding it back leaves the window as it was found',
)
check(panelTalk.inputs().length === 1, 'there is one place to type')
check(
  (panelTalk.inputs()[0]?.props?.placeholder || '').includes('问 den 一句'),
  'and it says it is the box you talk to den with',
)
// Three shortcuts, and only three. They fill the box; they do not send. A shortcut that fired a turn
// by itself would be the window acting for the person, which is exactly what this surface must not do.
const shortcuts = findAll(panelTalk.tree, (node) => node.props?.['data-dsh-role'] === 'pet-shortcut')
check(shortcuts.length === 3, `the box carries three quick things to say (saw ${shortcuts.length})`)
check(
  shortcuts.map((node) => textOf(node).trim()).join('|') === '查看活动|解释状态|运行自检',
  `and they are the three named in the design (saw ${shortcuts.map((node) => textOf(node).trim()).join('|')})`,
)
const saysBeforeShortcut = calls.filter((entry) => entry.body?.action === 'conversation/say').length
const focused = []
;(panelTalk.inputs()[0]?.props?.ref || {}).current = { focus: () => focused.push('input') }
findAll(panelTalk.tree, (node) => node.props?.['data-dsh-role'] === 'pet-shortcut')[0]?.props?.onClick()
await panelTalk.settle()
check(
  calls.filter((entry) => entry.body?.action === 'conversation/say').length === saysBeforeShortcut,
  'a shortcut sends nothing: it only puts the words in the box',
)
check(
  (findAll(panelTalk.tree, (node) => node.props?.['data-dsh-role'] === 'pet-input')[0]?.props?.value || '') === '查看活动',
  'and the words it puts there are the shortcut\u2019s own',
)
check(focused.length === 1, 'and the cursor is put in the box so the sentence can be finished or rewritten')
await panelTalk.type(0, 'look at the CI failures')
await panelTalk.press('发送')
const saidCall = calls.find((entry) => entry.body?.action === 'conversation/say')
check(saidCall?.body?.text === 'look at the CI failures', 'sending posts exactly what was typed')
check(panelTalk.text().includes('are you awake?'), 'and the conversation is still on screen afterwards')
// The host admits a prompt before the log carries it, so the read that follows a send can honestly
// come back without the sentence. What must never happen is the human watching it disappear.
check(leafText(panelTalk.tree).includes('look at the CI failures'), 'what was just sent is shown at once, before the host has logged it')
check(panelTalk.inputs()[0] && panelTalk.inputs()[0].props.value === '', 'and the box is cleared, so it cannot look unsent')

/* --- a dead turn explains itself, in the host's own words --------------- */

// Three turns of this conversation ended in 'prompt variable "{{model}}" has no value', and every one
// of them wrote no message, so the window was empty and silent. The host's reason travels with the read
// result now: a person looking at an empty window can see which half is broken.
const panelDead = mount(
  bootWindow({
    scripted: {
      status: healthyStatus(),
      'conversation/read': {
        ok: true,
        value: {
          sessionId: 'sess-standing',
          state: 'live',
          total: 0,
          truncated: false,
          messages: [],
          lastError: 'prompt variable "{{model}}" has no value for this assembly',
        },
      },
    },
  }).component,
  {},
)
await panelDead.settle()
// The reason the window is empty is drawn by the transcript, which is now the window's body: the
// host's own words are on screen from the open, with no tab pressed to bring them there.
check(panelDead.text().includes('上一回合没能完成'), 'an empty conversation says why it is empty, on the open')
check(
  panelDead.text().includes('has no value'),
  'and quotes the host rather than smoothing it into "something went wrong"',
)
// The same line must not appear when the last turn was fine.
check(!panelTalk.text().includes('上一回合没能完成'), 'a conversation that answered carries no failure line')

/* --- a line the log already carries is not drawn twice --- */

/*
 * The text of one render tree, as the leaves that were actually drawn.
 *
 * `textOf` on every node double-counts, because a parent already contains its children, and the
 * harness keeps the text of every frame it has seen — so a check that counts occurrences across
 * `text()` is really counting frames. Counting leaf nodes in the tree judges the render in hand.
 */
function leafText(node, out = []) {
  if (!node) return out
  // `mount().tree` is an array of nodes, not one node: without this branch the walk finds nothing
  // and a check that counts what was drawn reports zero instead of a count.
  if (Array.isArray(node)) {
    for (const child of node) leafText(child, out)
    return out
  }
  if (node.kind === 'text') {
    out.push(node.text)
    return out
  }
  for (const child of node.children || []) leafText(child, out)
  return out
}

const panelEcho = mount(
  bootWindow({
    scripted: {
      'conversation/read': {
        ok: true,
        value: {
          state: 'live',
          sessionId: 'sess-echo',
          total: 1,
          truncated: false,
          messages: [{ role: 'user', text: 'already logged', seq: 1, time: 1 }],
        },
      },
      'conversation/say': { ok: true, value: { delivery: 'prompt', sessionId: 'sess-echo', state: 'live' } },
    },
  }).component,
  {},
)
await panelEcho.settle()
// The optimistic copy lives in the transcript, and the transcript is the window's body now: it is
// mounted with the window, so the sentence has somewhere to be drawn without anything being pressed.
await panelEcho.type(0, 'already logged')
await panelEcho.press('发送')
await panelEcho.settle()
const echoCount = leafText(panelEcho.tree).filter((text) => text === 'already logged').length
check(echoCount === 1, 'a line the log already carries is not shown twice when it is sent again (drawn ' + String(echoCount) + ' times)')

/* --- the shut pill is the monitor: budget, what is owed, and whether it can speak --- */

// Collapsed before boot, through the same storage the window writes. `setItem`, which is the API
// the other scenarios already use; an earlier draft called `.set` and stopped the whole checker.
fakeStorage.setItem('dsh-den.mini', JSON.stringify({ collapsed: true }))

const panelPill = mount(
  bootWindow({
    scripted: {
      status: healthyStatus({
        dailyTurnBudget: 24,
        ledger: { turns: 2, spoken: 1, skipped: 1, refused: 0 },
        kernel: { running: true, lastTickAt: 1, lastError: null },
        kernelDeferred: null,
      }),
    },
  }).component,
  {},
)
await panelPill.settle()
const panelPillButton = panelPill.buttons().find((button) => button.props?.['aria-label']?.includes('打开 den 面板'))
const panelPillLabel = String(panelPillButton?.props?.['aria-label'] || '')
check(panelPillLabel.includes('运行中'), 'the shut pill keeps the real state in its accessible label')
check(!panelPillLabel.includes('宿主待重启'), 'a host that sends the budget is not called older')
check(!panelPillLabel.includes('工具受保护') && !panelPillLabel.includes('工具直通'), 'and says nothing about the approval gate')
check(panelPillLabel.includes('回合 2/24'), "and keeps today's self-initiated budget in the accessible label")
check(
  panelPillButton?.props?.style?.width === 44 && panelPillButton?.props?.style?.height === 44,
  'and reduces the shut control to the 44px rounded square the design asks for',
)
check(panelPillButton?.props?.style?.borderRadius === 15, 'with the corner radius that goes with that square')
check(panelPillButton?.children?.length === 1, 'and shows only den\'s mark, with the state dot in its corner')
// The state dot has to survive the collapse: the shut pill is the surface a person actually sees, so
// a light that only exists while the window is open is a light that is never on when it matters.
const pillDot = findAll(panelPill.tree, (node) => node.props?.['data-dsh-role'] === 'status-dot')[0]
check(pillDot?.props?.['data-state'] === 'waiting', `and carries the same state the open window would (saw ${pillDot?.props?.['data-state']})`)

const panelPillDeferred = mount(
  bootWindow({
    scripted: {
      status: healthyStatus({
        dailyTurnBudget: 24,
        ledger: { turns: 2, spoken: 1, skipped: 1, refused: 0 },
        kernel: { running: false, lastTickAt: 1, lastError: null },
        kernelDeferred: { reason: 'no delivery path available in this profile', attempts: 3, retrying: true },
      }),
    },
  }).component,
  {},
)
await panelPillDeferred.settle()
const panelPillDeferredButton = panelPillDeferred.buttons().find((button) => button.props?.['aria-label']?.includes('打开 den 面板'))
const panelPillDeferredLabel = String(panelPillDeferredButton?.props?.['aria-label'] || '')
check(panelPillDeferredLabel.includes('等待投递'), 'a pill whose heartbeat is waiting says so instead of claiming to run')
check(!panelPillDeferredLabel.includes('心跳运行中'), 'and does not claim the heartbeat is fine')

/* --- the transcript scrolls in its own area, which is what "scrollable" means --- */

// The transcript has a bounded scroll area of its own, and the bound is what is pinned: "scrollable"
// in a 216px card means it grows inside a limit rather than growing the card. The rail's own fold is
// bounded the same way, but it is folded here — which is why exactly one such area is on screen, and
// why a second one appearing means something was unfolded without being asked for.
const transcriptScroll = findAll(panelTalk.tree, (n) => n.props?.style?.overflowY === 'auto' && Number(n.props?.style?.maxHeight) > 0)
check(transcriptScroll.length === 1, `the transcript has exactly one scrolling area of its own (saw ${transcriptScroll.length})`)
check(Number(transcriptScroll[0]?.props?.style?.maxHeight) > 0, 'and that area is bounded, so the window cannot grow with the transcript')
// The 216px card is the constraint this whole layout answers to, and the transcript's own chrome is
// where it used to lose: three provenance lines plus a "type below" hint were most of the view's
// height once the card was that small, so the messages were what got clipped — the exact failure this
// change exists to avoid. Pinned as the shape of the render rather than as pixels, which this harness
// cannot measure: one chrome line, and a scroll box that is the flexible child with a low floor.
const transcriptChrome = findAll(panelTalk.tree, (n) => n.props?.['data-dsh-role'] === 'pet-meta')
check(
  transcriptChrome.length === 1,
  `the transcript's provenance, its count and its tail notice share one line (saw ${transcriptChrome.length} such line(s))`,
)
check(
  String(transcriptScroll[0]?.props?.style?.flex || '').startsWith('1 1') &&
    Number(transcriptScroll[0]?.props?.style?.minHeight) <= 40,
  `and the box that holds the messages is the one that grows, with a floor a 216px card can pay (minHeight ${transcriptScroll[0]?.props?.style?.minHeight})`,
)
// Two more facts that decide whether the conversation is readable at all at 286×216, and that a check
// asking "is the text in the tree" cannot see. Both were sized against browser measurements
// (2026-10-16): a message row cost ~65px, the box is ~58px, so the speaker label was on screen and the
// sentence under it was not — and with the box parked at `scrollTop: 0` the line in view was the
// oldest of the tail, not the sentence the person had just sent.
const messageRows = findAll(panelTalk.tree, (node) => node.props?.['data-dsh-role'] === 'pet-message')
check(
  messageRows.length === 3,
  `the transcript draws the tail's two messages and the sentence sent above as rows (saw ${messageRows.length})`,
)
check(
  messageRows.length > 0 && messageRows.every((node) => (Number.parseInt(String(node.props?.style?.margin), 10) || 0) <= 4),
  `and each row is spaced for the card rather than for the page (${messageRows.map((node) => node.props?.style?.margin).join(', ')})`,
)
// The box is scrolled by an effect, so the assertion drives a real render with a stand-in node: the
// harness has no layout, and a check that only read the effect's source would be measuring the file.
const scrollBox = transcriptScroll[0]
if (scrollBox?.props?.ref) scrollBox.props.ref.current = { scrollHeight: 812, scrollTop: 0 }
panelTalk.render()
await panelTalk.settle()
check(
  scrollBox?.props?.ref?.current?.scrollTop === 812,
  `and the box follows the log, so the newest line is the one in view (scrollTop ${scrollBox?.props?.ref?.current?.scrollTop})`,
)
/* --- the window places and paints itself, because the layer gives it neither --- */

const cardNodes = findAll(panelTalk.tree, (n) => n.props?.style?.position === 'absolute' && n.props?.style?.width === 286)
check(cardNodes.length === 1, 'the open window places and sizes itself instead of becoming a strip across the top')
check(cardNodes[0]?.props?.style?.right === 24 && cardNodes[0]?.props?.style?.top === 72 && cardNodes[0]?.props?.style?.bottom === 'auto', 'and starts below the page header instead of colliding with it')
check(String(cardNodes[0]?.props?.style?.background || '').includes('--dsw-alias-bg-layer-1'), 'and paints a surface rather than reading as page furniture')

/* --- the collapse control actually collapses, through a real press ---------- */

// The bar behind it is a drag handle that captures the pointer on pointerdown, and a click inside a captured
// pointer is retargeted to the capturing element — so this button's onClick never ran at all. Measured report
// (2026-10-15, the user): "我现在点击缩小没反应". Every earlier check seeded `collapsed: true` in storage
// instead of pressing the control, which is exactly how 126 green checks missed a button that did nothing.
let collapseStopped = 0
const collapseButton = findAll(panelTalk.tree, (n) => n.props?.['aria-label'] === '收起')[0]
check(Boolean(collapseButton), 'the open window offers a collapse control under its accessible name')
check(typeof collapseButton?.props?.onPointerDown === 'function', 'and stops the drag handle from capturing a press on it')
collapseButton?.props?.onPointerDown({ stopPropagation: () => { collapseStopped += 1 } })
check(collapseStopped === 1, 'so pressing it is not read as the start of a drag')
collapseButton?.props?.onClick()
await panelTalk.settle()
check(
  findAll(panelTalk.tree, (n) => n.props?.style?.width === 286).length === 0,
  'and pressing it puts the window away instead of doing nothing',
)
const reopened = findAll(panelTalk.tree, (n) => n.props?.['aria-label']?.includes('打开 den 面板'))[0]
check(Boolean(reopened), 'leaving the shut pill in its place')
// The press above was a real one, so the pill it leaves behind is judged as rendered: 44×44, rounded,
// and no longer a circle, which is the shape the design asks for.
check(
  reopened?.props?.style?.width === 44 && reopened?.props?.style?.height === 44,
  `and that pill is the 44×44 square the design asks for (saw ${reopened?.props?.style?.width}×${reopened?.props?.style?.height})`,
)
reopened?.props?.onClick()
await panelTalk.settle()
check(findAll(panelTalk.tree, (n) => n.props?.style?.width === 286).length === 1, 'and the pill brings the window back')
check(cardNodes[0]?.props?.style?.zIndex === 60, 'and sits above the page it floats over')
check(cardNodes[0]?.props?.style?.height === 216, 'and starts with the desktop-pet footprint the design specifies')
check(cardNodes[0]?.props?.style?.resize === 'both', 'and exposes a native two-axis resize affordance')
check(cardNodes[0]?.props?.style?.minWidth === 240 && cardNodes[0]?.props?.style?.minHeight === 170, 'and keeps the pet usable at its smallest size')
check(cardNodes[0]?.props?.style?.borderRadius === 18, 'and is rounded like the design, not like a page card')
check(cardNodes[0]?.props?.['aria-label'] === '常驻会话', 'and gives the floating pet an accessible identity')

fakeStorage.setItem('dsh-den.mini', JSON.stringify({ collapsed: false, width: 280, height: 190, sizeVersion: 4 }))
const rememberedSizeWindow = mount(bootWindow({ scripted: { status: healthyStatus() } }).component, {})
const rememberedSizeCard = findAll(rememberedSizeWindow.tree, (node) => node.props?.style?.position === 'absolute' && node.props?.style?.resize === 'both')[0]
check(rememberedSizeCard?.props?.style?.width === 280 && rememberedSizeCard?.props?.style?.height === 190, 'and reopens at the dimensions the person chose')
fakeStorage.setItem('dsh-den.mini', JSON.stringify({ collapsed: false, width: 280, height: 190, sizeVersion: 3 }))
const legacyCustomWindow = mount(bootWindow({ scripted: { status: healthyStatus() } }).component, {})
const legacyCustomCard = findAll(legacyCustomWindow.tree, (node) => node.props?.style?.position === 'absolute' && node.props?.style?.resize === 'both')[0]
check(legacyCustomCard?.props?.style?.width === 280 && legacyCustomCard?.props?.style?.height === 190, 'and keeps a custom size from the previous preference version')
fakeStorage.setItem('dsh-den.mini', JSON.stringify({ collapsed: false, width: 260, height: 180, sizeVersion: 3 }))
const legacyDefaultWindow = mount(bootWindow({ scripted: { status: healthyStatus() } }).component, {})
const legacyDefaultCard = findAll(legacyDefaultWindow.tree, (node) => node.props?.style?.position === 'absolute' && node.props?.style?.resize === 'both')[0]
check(legacyDefaultCard?.props?.style?.width === 286 && legacyDefaultCard?.props?.style?.height === 216, 'and migrates the old built-in size to the redrawn default')
const resizeTarget = { getBoundingClientRect: () => ({ width: 412, height: 318 }) }
if (rememberedSizeCard?.props?.ref) rememberedSizeCard.props.ref.current = resizeTarget
await rememberedSizeWindow.settle()
const resizeObserver = fakeResizeObservers[fakeResizeObservers.length - 1]
resizeObserver?.callback([{ target: resizeTarget }])
await rememberedSizeWindow.settle()
const rememberedAfterResize = JSON.parse(fakeStorage.getItem('dsh-den.mini') || '{}')
check(rememberedAfterResize.width === 412 && rememberedAfterResize.height === 318, 'and remembers a later resize through the same preference blob')
fakeStorage.setItem('dsh-den.mini', JSON.stringify({ collapsed: false }))
/* --- a host that has not been reloaded: say so, and disable what cannot work --- */

fakeStorage.setItem('dsh-den.mini', JSON.stringify({ collapsed: false }))

const panelOldHost = mount(
  bootWindow({
    scripted: {
      status: healthyStatus(),
      'conversation/read': {
        ok: false,
        error: { code: 'DEN_ACTION_FAILED', message: 'unknown action "conversation/read"; known actions: status' },
      },
    },
  }).component,
  {},
)
await panelOldHost.settle()
// The verdict itself is the transcript's, and the transcript is the window's body: it is read off the
// screen from the open, with no tab to press first. The rail above it has to survive that verdict —
// an older host is still a host the state light can report on.
check(
  findAll(panelOldHost.tree, (node) => node.props?.['data-dsh-role'] === 'pet-rail').length === 1,
  'and the activity rail is still drawn while the transcript reports an older host',
)
check(panelOldHost.text().includes('重启 DSH'), 'a window whose host half is older says what to do about it')
check(!panelOldHost.text().includes('unknown action'), "and does not print the host's error text as if den were broken")
// The send control is an arrow with an accessible name rather than a word, so it is found the way the
// earlier check found it and the way a screen reader would: by that name. Looking for a button whose
// *text* is 发送 found nothing at all, so `disabled` was read off `undefined` and the check passed
// without ever touching the control.
//
// A sentence is typed first on purpose. With the box empty the control is disabled for that reason
// alone, so "cannot be pressed" would say nothing about the older host; with words in the box the only
// thing that can still be holding it shut is the phase the transcript reported.
await panelOldHost.type(0, '这一句不该发出去')
const oldHostSend = panelOldHost.buttons().find((button) => button.props?.['aria-label'] === '发送')
check(Boolean(oldHostSend), 'the window still shows its one send control')
check(oldHostSend?.props?.disabled === true, 'and the send button it still shows cannot be pressed')

fakeStorage.setItem('dsh-den.mini', JSON.stringify({ collapsed: true }))

// `healthyStatus()` sends no `dailyTurnBudget`, which is exactly what the live older host sends.
const panelPillNoBudget = mount(bootWindow({ scripted: { status: healthyStatus() } }).component, {})
await panelPillNoBudget.settle()
const panelPillNoBudgetButton = panelPillNoBudget.buttons().find((button) => button.props?.['aria-label']?.includes('打开 den 面板'))
const panelPillNoBudgetLabel = String(panelPillNoBudgetButton?.props?.['aria-label'] || '')
check(panelPillNoBudgetLabel.includes('宿主待重启'), 'a host that sends no budget is named as older, not left unexplained')
check(!panelPillNoBudgetLabel.includes('自治已关'), 'a host that reports no budget is not described as proactivity being off')
check(!panelPillNoBudgetLabel.includes('回合'), 'and no budget number is invented for it')
const pillPlaced = findAll(panelPillNoBudget.tree, (n) => n.props?.style?.position === 'absolute' && n.props?.style?.top === 72)
check(pillPlaced.length >= 1, 'and the shut pill places itself too, rather than sitting in the page flow')

/* --- the floating window can be moved, and remembers where ----------------- */

// Storage is the window's own preference blob, so the check reads what a browser would keep.
fakeStorage.setItem('dsh-den.mini', JSON.stringify({ collapsed: false }))
const dragWindow = mount(bootWindow({ scripted: { status: healthyStatus() } }).component, {})
await dragWindow.settle()
const dragHandles = findAll(dragWindow.tree, (node) => node.props?.['data-dsh-role'] === 'pet-header')
check(dragHandles.length === 1, `the window offers exactly one drag handle; saw ${dragHandles.length}`)

let measured = 0
const handleTarget = {
  getBoundingClientRect: () => { measured += 1; return { left: 400, top: 300, width: 320, height: 240 } },
  setPointerCapture: () => {},
}
const handleOf = () => findAll(dragWindow.tree, (node) => node.props && typeof node.props.onPointerMove === 'function')[0]
handleOf().props.onPointerDown({ currentTarget: handleTarget, pointerId: 7, preventDefault: () => {} })
await dragWindow.settle()
handleOf().props.onPointerMove({ movementX: 120, movementY: -40 })
await dragWindow.settle()
handleOf().props.onPointerUp({})
await dragWindow.settle()

const keptPreference = JSON.parse(fakeStorage.getItem('dsh-den.mini') || '{}')
check(measured === 1, 'the window measures where it already is before the first movement, so it does not jump')
check(keptPreference.x === 520 && keptPreference.y === 260, `the window stays where it was put (${keptPreference.x}, ${keptPreference.y})`)
const placedTree = findAll(
  dragWindow.tree,
  (node) => node.props?.style?.left === 520 && node.props?.style?.top === 260 && node.props?.style?.right === 'auto',
)
check(placedTree.length >= 1, 'and the remembered place is applied, rather than only stored')

// The other half of the same guard: a press that lands on a control *inside* the bar is not a drag.
// The bar captures the pointer on pointerdown, which is how a press on the collapse button came to do
// nothing at all, so the two cases have to be told apart rather than both being allowed through.
// What makes them different is whether the pressed control is the element the handler is bound to.
let measuredOnControl = 0
const rivalButton = { closest: () => rivalButton }
const rivalBar = {
  getBoundingClientRect: () => { measuredOnControl += 1; return { left: 400, top: 300, width: 320, height: 240 } },
  setPointerCapture: () => {},
}
handleOf().props.onPointerDown({ currentTarget: rivalBar, target: rivalButton, pointerId: 9, preventDefault: () => {} })
check(measuredOnControl === 0, 'and a press that lands on a different control inside the bar never starts a drag')

/* --- the shut pill can be moved without opening it ----------------------- */

fakeStorage.setItem('dsh-den.mini', JSON.stringify({ collapsed: true }))
const dragPillWindow = mount(bootWindow({ scripted: { status: healthyStatus() } }).component, {})
await dragPillWindow.settle()
const dragPill = dragPillWindow.buttons().find((button) => button.props?.['aria-label']?.includes('打开 den 面板'))
const pillTarget = {
  getBoundingClientRect: () => ({ left: 100, top: 120, width: 44, height: 44 }),
  setPointerCapture: () => {},
}
dragPill?.props?.onPointerDown({ currentTarget: pillTarget, pointerId: 8, clientX: 110, clientY: 130, stopPropagation: () => {} })
dragPill?.props?.onPointerMove({ clientX: 210, clientY: 190, movementX: 100, movementY: 60, preventDefault: () => {} })
dragPill?.props?.onPointerUp({})
await dragPillWindow.settle()
const keptPillPreference = JSON.parse(fakeStorage.getItem('dsh-den.mini') || '{}')
check(keptPillPreference.x === 200 && keptPillPreference.y === 180, `the shut pill moves with the pointer (${keptPillPreference.x}, ${keptPillPreference.y})`)
dragPill?.props?.onClick({ preventDefault: () => {} })
await dragPillWindow.settle()
// The pill stays a pill: one shut control, still carrying its accessible name, with no open card
// behind it. Counting nodes with `width === 44` looked like the same question and was not — the
// pill's own mark span is a 44px box too, so the count was two for a pill that had correctly
// refused to open, and the check was red on a control that did the right thing.
check(
  findAll(dragPillWindow.tree, (node) => node.props?.['aria-label']?.includes('打开 den 面板')).length === 1,
  'and a drag does not accidentally open the pill',
)
check(
  findAll(dragPillWindow.tree, (node) => node.props?.style?.width === 286).length === 0,
  'and the window it would open stays shut behind it',
)

/* --- a press on the pill's own mark moves it, wherever it lands ------------ */

// Reported by the user (2026-10-16), with the window shut: the pill could not be moved when the press
// landed on den's mark or on the status dot pinned over it. Both are children of the pill's own
// button, so `closest('button')` resolves to the button the drag handler is bound to — which the guard
// must read as "this control", not as "a different one". A drag that only works on the bare background
// of a 44px square is not a draggable control, and the case the report named is the case worth pinning:
// the drag check above presses the pill with no target at all, which is the one press that never had
// the problem.
for (const pressedOn of ['den 的标记', '压在上面的状态点']) {
  fakeStorage.setItem('dsh-den.mini', JSON.stringify({ collapsed: true, x: 100, y: 120 }))
  const markPillWindow = mount(bootWindow({ scripted: { status: healthyStatus() } }).component, {})
  await markPillWindow.settle()
  const markPill = markPillWindow.buttons().find((button) => button.props?.['aria-label']?.includes('打开 den 面板'))
  const markPillTarget = {
    getBoundingClientRect: () => ({ left: 100, top: 120, width: 44, height: 44 }),
    setPointerCapture: () => {},
  }
  const childOfThePill = { closest: () => markPillTarget }
  markPill?.props?.onPointerDown({
    currentTarget: markPillTarget,
    target: childOfThePill,
    pointerId: 11,
    clientX: 110,
    clientY: 130,
    stopPropagation: () => {},
  })
  markPill?.props?.onPointerMove({ clientX: 250, clientY: 230, movementX: 140, movementY: 100, preventDefault: () => {} })
  markPill?.props?.onPointerUp({})
  await markPillWindow.settle()
  const movedByMark = JSON.parse(fakeStorage.getItem('dsh-den.mini') || '{}')
  check(
    movedByMark.x === 240 && movedByMark.y === 220,
    `a press on ${pressedOn} still moves the pill (${movedByMark.x}, ${movedByMark.y})`,
  )
  markPill?.props?.onClick({ preventDefault: () => {} })
  await markPillWindow.settle()
  check(
    findAll(markPillWindow.tree, (node) => node.props?.['aria-label']?.includes('打开 den 面板')).length === 1,
    `and a drag that began on ${pressedOn} does not open the window either`,
  )
}

fakeStorage.setItem('dsh-den.mini', JSON.stringify({ collapsed: true }))
const clickPillWindow = mount(bootWindow({ scripted: { status: healthyStatus() } }).component, {})
await clickPillWindow.settle()
const clickPill = clickPillWindow.buttons().find((button) => button.props?.['aria-label']?.includes('打开 den 面板'))
clickPill?.props?.onClick({})
await clickPillWindow.settle()
check(findAll(clickPillWindow.tree, (node) => node.props?.style?.width === 286).length === 1, 'and a short click still opens the den window')

/* --- a remembered place that no longer fits is pulled back into view -------- */

// Measured symptom (2026-10-15, the user): "I cannot even find den in my sidebar." The pill had been saved at
// a spot the current viewport no longer contains, and the load path clamped only the low side, so it rendered
// past the right or bottom edge — mounted, `active: true`, and unreachable.
fakeStorage.setItem('dsh-den.mini', JSON.stringify({ collapsed: true, x: 4000, y: 3000 }))
const offscreenWindow = mount(bootWindow({ scripted: { status: healthyStatus() } }).component, {})
await offscreenWindow.settle()
const offscreenPill = findAll(
  offscreenWindow.tree,
  (node) =>
    node.props?.style?.position === 'absolute' &&
    node.props?.style?.width === 44 &&
    Number.isFinite(Number(node.props?.style?.left)),
)[0]
check(Boolean(offscreenPill), 'a shut pill with an off-screen remembered place is still rendered')
const pillLeft = Number(offscreenPill?.props?.style?.left)
const pillTop = Number(offscreenPill?.props?.style?.top)
check(pillLeft < 4000 && pillTop < 3000, `and is pulled back into view rather than left off the edge (${pillLeft}, ${pillTop})`)
check(pillLeft >= 0 && pillTop >= 0, 'and never lands at a negative offset')
fakeStorage.setItem('dsh-den.mini', JSON.stringify({ collapsed: false }))

/* --- a host failure is surfaced, not swallowed ---------------------------- */

const panel9 = mount(
  boot({
    scripted: {
      status: { ok: false, error: { code: 'DEN_STATUS_FAILED', message: 'disk on fire' } },
      'schedules/list': { ok: true, value: { schedules: [], invalidCount: 0 } },
    },
  }),
  { sessionId: 'session-active' },
)
await panel9.settle()
check(panel9.text().includes('disk on fire'), 'a host error is shown to the human')

/* --- a non-JSON reply is reported as a transport failure, not a parse error -- */

// The realistic case: the host half has not been restarted, so the route is not
// mounted and something answers 404 with HTML. `res.json()` on that produces
// "Unexpected token '<'", which says nothing about the host. The panel has to name
// the status instead, because this is the exact state a user meets first.
transport.raw = { status: 404, text: '<!doctype html><html>Not Found</html>' }
const panel10 = mount(
  boot({
    scripted: { 'schedules/list': { ok: true, value: { schedules: [], invalidCount: 0 } } },
  }),
  { sessionId: 'session-active' },
)
await panel10.settle()
const transportError = panel10.text()
check(transportError.includes('404'), 'a non-JSON reply surfaces the HTTP status')
check(
  !transportError.includes('Unexpected token'),
  'and does not surface a JSON parse error in its place',
)
transport.raw = null

/* ----------------------------------------------------------------- preview page */

// How the panel looks is decided by a human, not by an assertion, so the harness emits the very
// trees it just rendered as a standalone page — generated here, from the same components the checks
// drive, because a hand-written preview drifts: the checks keep passing while the file on disk
// quietly shows the previous design.
//
// It sits *below* every scenario on purpose. `panelTalk` and `panelPill` are `const`s declared with
// the other scenarios, so a preview above them could not name them at all — which is how the two
// seats ① retired kept being what this page showed, with the floating window mislabelled as the old
// dock and the collapsed pill absent.
if (process.argv.includes('--demo')) {
  const demoPath = process.argv[process.argv.indexOf('--demo') + 1] || 'docs/demo.html'
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const { demoPage } = await import('./panel-tree.mjs')
  const demoMain = mount(component, {})
  await demoMain.settle()

  /**
   * The rail's fold, as a human would meet it.
   *
   * Mounted here rather than reusing `panelTalk`, because that handle was deliberately folded back to
   * the state the window opens in — a preview section has to show the state its own caption names.
   * The messages are demo copy on purpose: the page says so in its banner, and the numbers in the rail
   * come from `healthyStatus()`, which is the same fixture every check above drives.
   */
  const demoDetails = mount(
    bootWindow({
      scripted: {
        status: healthyStatus(),
        'conversation/read': {
          ok: true,
          value: {
            sessionId: 'sess-demo',
            state: 'live',
            readFrom: 'store',
            total: 4,
            truncated: true,
            messages: [
              { role: 'user', text: '磁盘快满了吗？', seq: 3, time: 1 },
              { role: 'assistant', text: '还剩 12%，我先盯着，到 8% 再叫你。', seq: 4, time: 2 },
            ],
          },
        },
      },
    }).component,
    {},
  )
  await demoDetails.settle()
  await demoDetails.click('详情')

  /**
   * The conversation at a size that can show it.
   *
   * The default footprint is 286×216 and it is honest about what that costs: the bar, the rail and the
   * composer take 143px of it, so the transcript holds one message (measured in a browser, 2026-10-16).
   * A preview section whose subject is "the conversation is the body" has to show more than one line of
   * it, so this card is the same window after the human has pulled the corner — 286×340, through the
   * same preference blob the resize writes. ① below is the untouched footprint, and every check above
   * still measures the window at 216.
   */
  fakeStorage.setItem('dsh-den.mini', JSON.stringify({ collapsed: false, width: 286, height: 340, sizeVersion: 4 }))
  const demoChat = mount(
    bootWindow({
      scripted: {
        status: healthyStatus(),
        'conversation/read': {
          ok: true,
          value: {
            sessionId: 'sess-demo',
            state: 'live',
            readFrom: 'store',
            total: 4,
            truncated: true,
            messages: [
              { role: 'user', text: '磁盘快满了吗？', seq: 1, time: 1 },
              { role: 'assistant', text: '还剩 12%，我先盯着，到 8% 再叫你。', seq: 2, time: 2 },
            ],
          },
        },
      },
    }).component,
    {},
  )
  await demoChat.settle()
  fakeStorage.setItem('dsh-den.mini', JSON.stringify({ collapsed: false }))

  const page = demoPage({
    title: 'dsh-den 浮窗预览',
    generatedBy: '由 tools/check-client-interaction.mjs 生成',
    sections: [
      {
        label: '① 浮窗卡片：全屏唯一的 den 落点（shell.overlay）',
        // `dock` here is the `shell.overlay` entry — the descriptor, not the retired input dock its
        // old label named. It is that component mounted with the session the shell hands over, which
        // is the real case; it pairs with the `main, shell.overlay` injection check. (`grantPanel`
        // was named here and never existed: the reference threw a ReferenceError, so the harness
        // could not run at all and `docs/demo.html` could not be regenerated either.)
        hint: '默认 286×216；按住顶部条移动，拖右下角调整大小；[–] 收成 44×44 的 den 图标',
        tall: true,
        // `dockWindow`, not `dock`: the descriptor carries `{component, options}` and no tree at all.
        tree: dockWindow.tree,
      },
      {
        label: '② 浮窗里的消息流：打开就是对话，不用切标签',
        hint: '顶部那条细线就是活动（状态点 + 一句白话摘要 + [详情]），下面同时就是消息流。这张是拖大后的 286×340；默认 216 时这里只放得下一条消息，窗口本身会自动滚到最新一行',
        tall: true,
        tree: demoChat.tree,
      },
      {
        label: '② 细线上的 [详情]：技术指标叠在细线下面，收起就回到对话',
        hint: '默认折叠。展开后测量值在自己的滚动区里（心跳与上次心跳、有话想跟你说、回合数），它浮在消息流之上、不参与布局，所以 216px 的卡片不会因为展开而把消息挤没；收起后消息原位还在',
        tall: true,
        tree: demoDetails.tree,
      },
      {
        label: '② 一回合没成话：窗口把宿主的原因原话报出来',
        hint: '空窗口不再沉默 —— 上一回合的失败原文显示在输入框上方（这里演示 {{model}} 无值那次）',
        tall: true,
        tree: panelDead.tree,
      },
      {
        label: '① 收成 den 图标：小尺寸仍有状态反馈',
        hint: '收起后只保留 den 图标和状态点；完整状态在无障碍标签里，点开回到卡片',
        tall: true,
        tree: panelPill.tree,
      },
      {
        label: '整页面板（main）：打开 den 自己的页面时',
        hint: '一行状态白话；八行技术指标收在 [详情] 里；异常状态自动展开',
        tree: demoMain.tree,
      },
    ],
  })
  mkdirSync('docs', { recursive: true })
  writeFileSync(demoPath, page, 'utf8')
  console.log('demo written:', demoPath, page.length, 'bytes')
}

/* ----------------------------------------------------------------- report */

// Stop every panel's poll timer before reporting. This is not just tidiness: the
// panel polls on a 15-second interval, so without the cleanup this process never
// exits, and the cleanup is itself the check that unmounting works.
for (const handle of mounted) handle.unmount()

console.log('')
if (failures.length) {
  console.log(`FAIL — ${failures.length} of ${checkCount} checks failed:`)
  for (const failure of failures) console.log(`  - ${failure}`)
  /**
   * 负向断言，所以它无条件生效 —— 不会变成那种"看着有用、永远不触发"的假断言。
   *
   * 面板不该用这个插件自己的词汇来描述人的状态。「待读」指的是"我攒了话想跟你说、你还没看"，
   * 但对看面板的人来说那是个要先学的名词。它被换成了「有话想跟你说」，这条断言负责让它别再回来：
   * 只要有人把字符串改回去，这里就红。
   */
  check(
    !text.includes('待读'),
    'the panel does not say 待读 — that is the den’s word, not the person’s',
  )
  process.exit(1)
}
console.log(`PASS — ${checkCount} interaction checks`)
process.exit(0)
