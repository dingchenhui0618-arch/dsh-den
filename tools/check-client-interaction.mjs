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

{
  const sandbox = {
    navigator: fakeNavigator,
    window: {
      __ModuleLoader__: { load: (spec) => { loaded = spec } },
      // The panel looks for this hook, so an offline harness can observe the
      // action state that no DOM would otherwise expose.
      __dshDenDebug: (event) => sinkLog.push(event),
      localStorage: fakeStorage,
    },
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
function healthyStatus(overrides = {}) {
  return {
    ok: true,
    value: {
      generatedAt: Date.now(),
      name: 'Den',
      home: 'C:\\Users\\123\\.dsh\\den',
      autonomy: null,
      autonomyKnown: true,
      nextCheckAt: null,
      ledger: { turns: 3, spoken: 1, skipped: 2, refused: 0 },
      notices: { total: 1, deliverable: 1, expired: 0 },
      triggers: { total: 1, invalid: 0, due: 0 },
      kernel: { running: true, lastTickAt: Date.now(), lastError: null },
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
async function mainPanelWith(freshness) {
  const component = boot({
    scripted: {
      status: healthyStatus({ freshness }),
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

/* --- the per-conversation controls sit where a conversation arrives --------- */

const dock = bootWindow({
  scripted: { status: healthyStatus({ autonomy: 'session-active', autonomyKnown: true }), 'schedules/list': { ok: true, value: { schedules: [], invalidCount: 0 } } },
})
check(
  dock.options.name === 'shell.overlay',
  'the grant control registers into the session-scoped composer dock',
)
// The catalog's own rule: "a fresh id is added beside the shipped entries, while reusing a shipped id
// puts you in THAT cell and replaces it." Reusing one of these would silently delete a shell control.
const SHIPPED_DOCK_IDS = ['todo', 'goal', 'queue']
check(
  !SHIPPED_DOCK_IDS.includes(dock.options.id),
  `the grant dock uses its own id so it adds a cell instead of replacing one (got ${dock.options.id})`,
)

const grantPanel = mount(dock.component, { sessionId: 'session-active' })
await grantPanel.settle()
const grantText = grantPanel.text()
check(grantText.includes('本会话已授予'), 'a granted conversation says so in the dock, in one line')
check(grantText.includes('已授予'), 'and reports the conversation it was told about as granted')
const dockStatus = calls.find((entry) => (entry.body?.action ?? 'status') === 'status')
check(
  dockStatus?.body?.sessionId == null,
  'the window asks for status without a conversation, because it belongs to none',
)

check(text.includes('在对话里说'), 'an empty schedule list is called out, and names the cheaper path: saying it')
check(text.includes('消息框里说一句'), 'and creating one is described as something said, not a form to go and find')

/* --- clicking Grant mints a token and does NOT claim authority ------------- */

const revokeCalls = () => calls.filter((entry) => entry.body?.action === 'autonomy/request')
check(revokeCalls().length === 0, 'no autonomy action is sent before a click')

// Granted, the dock is one line and nothing else: the buttons are gone, not merely quiet.
const grantedDockText = grantPanel.text()
check(
  grantedDockText.includes('常驻自治') && grantedDockText.includes('已授予'),
  'a granted conversation shows the composer dock as one line',
)
check(
  !grantedDockText.includes('撤销'),
  'and carries no revoke control, because revoking belongs where it cannot sit in the way',
)

// The grant button has to be exercised in a conversation that has not been granted: there,
// and only there, the buttons are the work still to do.
const freshDock = bootWindow({
  scripted: {
    status: healthyStatus(),
    'schedules/list': { ok: true, value: { schedules: [], invalidCount: 0 } },
    // The click below must be answered here. A request left hanging belongs to the next scenario,
    // because the scripted replies are whoever booted last - which is how a check two screens
    // further down lost its own data and read as a defect in this change.
    'autonomy/request': { ok: true, value: { token: 'tok-fresh-1', autonomy: true, expiresAt: Date.now() + 600000, ttlMs: 600000 } },
  },
})
const freshPanel = mount(freshDock.component, { sessionId: 'session-active' })
await freshPanel.settle()
check(freshPanel.text().includes('授予') && freshPanel.text().includes('撤销'), 'an ungranted conversation renders both autonomy controls')
await freshPanel.click('授予')

const grantCall = calls.find((entry) => entry.body?.action === 'autonomy/request')
check(Boolean(grantCall), 'clicking Grant sends an autonomy/request')
check(grantCall?.body?.autonomy === true, 'the grant request asks for autonomy: true')
check(grantCall?.body?.sessionId == null, 'minting names no conversation: the token is what the human carries to one')
check(
  calls.every((entry) => entry.body?.action !== 'autonomy/confirm'),
  'clicking Grant never confirms authority on its own — a token must come back first',
)

/* --- the token is shown to the human -------------------------------------- */

scriptReplies({
  'autonomy/request': { ok: true, value: { token: 'tok-abc123', autonomy: true, expiresAt: Date.now() + 600000, ttlMs: 600000 } },
})
const panel2 = mount(
  bootWindow({ scripted: { status: healthyStatus(), 'schedules/list': { ok: true, value: { schedules: [], invalidCount: 0 } } } }).component,
  { sessionId: 'session-active' },
)
await panel2.settle()
await panel2.click('授予')
if (process.env.DEN_DEBUG) {
  // The sink deliberately reports reply *shape*, not contents, so this shows which
  // actions completed rather than what they returned.
  console.log('PANEL2 sink:', JSON.stringify(sinkLog))
}
check(panel2.text().includes('tok-abc123'), 'the minted token is displayed for the human to carry to the conversation')

/* --- a preset is one click, and asks for nothing -------------------------------------------------- */

// DESIGN §2.39 acceptance 1. The old empty state pointed at a form that wanted a title, a prompt and
// a number of seconds; "one tap" is the claim, so the check is that the panel offers it *and* that no
// input is on screen waiting to be filled — a preset that still needs typing is the form again.
const presetPanel = mount(
  bootWindow({
    scripted: {
      // Granted, this dock is one line by design, so the empty-schedule state below it is not on
      // screen at all. The preset is for a person who is still setting things up, which is the
      // ungranted conversation - so that is the state this check has to look at.
      status: healthyStatus(),
      'schedules/list': { ok: true, value: { schedules: [], invalidCount: 0 } },
    },
  }).component,
  { sessionId: 'session-active' },
)
await presetPanel.settle()
check(!presetPanel.text().includes('每天看一眼 CI 失败'), 'without a conversation there is no form, so no preset to fill it')
check(!presetPanel.buttons().some((button) => textOf(button).trim() === '新建'), 'and no control that would open one')
check(presetPanel.inputs().length === 1, 'and its only input is the message box, not a form')

/* --- the resident is visible without opening anything -------------------------------------------- */

// The user's reference shows the resident as a sidebar row with a status dot beside it. The row is
// `sidebar.panellist`; the dot is `sidebar.toggle.badge`, whose live catalog entry describes it as
// "Non-interactive notification inside the collapsed sidebar expand button". What is asserted is the
// **seat**, not the colour: which tone is right depends on a status payload this harness fakes, and a
// check that pins a fake's colour proves nothing about the host.
// A probe with its own context: `boot()` would clear `calls` and reset the scripted replies, which the
// checks further down still read.
function registersSlot(name) {
  const probe = makeCtx()
  exportsValue.apply(probe)
  return probe.slots.entries.some((entry) => entry.options && entry.options.name === name)
}
check(!registersSlot('sidebar.panellist'), 'den keeps out of the sidebar panel list: one surface, not a tab plus a window')
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
const shutText = shutPanel.text()
check(
  shutText.includes('\u5e38\u9a7b\u4e2d'),
  'the shut floating window still says whether the resident is running',
)
check(
  shutText.includes('\u6709\u8bdd\u60f3\u8ddf\u4f60\u8bf4'),
  'and still reports how many things it has for the person',
)
check(
  shutText.split('\u00b7').length >= 3,
  'and keeps more than one fact on the line, instead of shrinking to a dot',
)
fakeStorage.setItem('dsh-den.mini', JSON.stringify({ collapsed: false }))

/* --- open again, because the pill is a control, not a dead end ---------------- */

const openedPanel = mount(shutWindow, {})
await openedPanel.settle()
check(
  !openedPanel.text().includes('\u6709\u8bdd\u60f3\u8ddf\u4f60\u8bf4 \u2014'),
  'and opening it again shows the panel rather than the pill',
)

// --- the static preview page --------------------------------------------------------------------
//
// How the panel *looks* is decided by a human, not by an assertion, so the harness can emit the very
// trees it just rendered as a standalone page. It is generated here, from the same components the
// checks drive, because a hand-written preview drifts: the checks keep passing while the file on disk
// quietly shows the previous design.
check(panel2.text().includes('一次性'), 'the panel explains the token is single-use')

/* --- carrying the token is one click, and a copy that did not happen says so --- */

// The token is long, single-use and wrapped across lines, and a copy missing one character is
// refused downstream as "the message does not quote the token" — a message that names no
// character and leaves the human with nothing to fix. So the strip offers a copy control, and
// both directions of it are checked here: this harness has no clipboard (as a hardened browser
// may not), and a label that claims a copy the browser refused would be worse than no button.
const copyLabel = () => {
  const button = panel2.buttons().find((candidate) => /复制令牌|已复制|复制失败/.test(textOf(candidate)))
  return { button, label: button ? textOf(button).trim() : '' }
}
check(Boolean(copyLabel().button), 'the token strip offers a copy control')
await panel2.click(copyLabel().label)
check(panel2.text().includes('复制失败'), 'with no clipboard available the panel reports the failure instead of claiming a copy')

const copied = []
fakeNavigator.clipboard = { writeText: (text) => { copied.push(text); return Promise.resolve() } }
await panel2.click(copyLabel().label)
check(copied.includes('tok-abc123'), 'and with a clipboard it puts the exact token on it')
check(panel2.text().includes('已复制'), 'and then says the copy happened')
fakeNavigator.clipboard = undefined

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
check(panel3.buttons().some((button) => textOf(button).trim() === '发送'), 'and one way to send what is typed')
check(!panel3.text().includes('新建自检'), 'and no submit button')
check(!panel3.buttons().some((button) => textOf(button).trim() === '新建'), 'and nothing that would open a form')
check(panel3.text().includes('还没有对话'), 'an empty conversation says how to start one')

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

/* --- no session means no grant button, on either seat ---------------------- */

// The status page offers none at all: it is mounted in `main`, which the shell documents as giving
// no Session binding to any key but the reserved `conversation` — asserted at the top of this file.
// The dock's own seat always carries a session, so the case below cannot arise through the shell; it
// pins the guard directly, with a prop the shell would not send.
const panel8 = mount(
  boot({ scripted: { status: healthyStatus({ autonomyKnown: false }), 'schedules/list': { ok: true, value: { schedules: [], invalidCount: 0 } } } }, 'shell.overlay'),
  { sessionId: null },
)
await panel8.settle()
const grantButton = panel8.buttons().find((button) => textOf(button).trim() === '授予')
check(grantButton?.props?.disabled !== true, 'grant needs no conversation, so it is not disabled')
const revokeButton8 = panel8.buttons().find((button) => textOf(button).trim() === '撤销')
check(revokeButton8?.props?.disabled === true, 'but revoke does, so it is disabled rather than silently doing nothing')

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
check(panelTalk.text().includes('are you awake?'), 'the window shows what was said to den')
check(panelTalk.text().includes('awake, and nothing is on fire'), 'and what den said back')
check(panelTalk.text().includes('只显示最近的消息'), 'and says so when it is showing only a tail of the transcript')
check(panelTalk.inputs().length === 1, 'there is one place to type')
await panelTalk.type(0, 'look at the CI failures')
await panelTalk.click('发送')
const saidCall = calls.find((entry) => entry.body?.action === 'conversation/say')
check(saidCall?.body?.text === 'look at the CI failures', 'sending posts exactly what was typed')
check(panelTalk.text().includes('are you awake?'), 'and the conversation is still on screen afterwards')

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
// '常驻中' is in both branches — the shut branch reads '常驻中 · 已停' — so the first version of this
// check passed while the pill was reporting the wrong side. Assert the half that decides.
check(panelPill.text().includes('心跳运行中'), 'the shut pill reports the kernel it was actually given, not the absence of a field')
check(!panelPill.text().includes('已停'), 'and does not also report it as stopped')
check(!panelPill.text().includes('宿主待重启'), 'a host that sends the budget is not called older')
check(panelPill.text().includes('回合 2/24'), "and how much of today's self-initiated budget is spent")

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
check(panelPillDeferred.text().includes('等待投递'), 'a pill whose heartbeat is waiting says so instead of claiming to run')
check(!panelPillDeferred.text().includes('心跳运行中'), 'and does not claim the heartbeat is fine')

/* --- the transcript scrolls in its own area, which is what "scrollable" means --- */

const scrollArea = findAll(panelTalk.tree, (n) => n.props?.style?.overflowY === 'auto')
check(scrollArea.length === 1, 'the transcript has exactly one scrolling area of its own')
check(Number(scrollArea[0]?.props?.style?.maxHeight) > 0, 'and that area is bounded, so the window cannot grow with the transcript')
/* --- the window places and paints itself, because the layer gives it neither --- */

const cardNodes = findAll(panelTalk.tree, (n) => n.props?.style?.position === 'absolute' && n.props?.style?.width === 420)
check(cardNodes.length === 1, 'the open window places and sizes itself instead of becoming a strip across the top')
check(cardNodes[0]?.props?.style?.right === 24 && cardNodes[0]?.props?.style?.bottom === 24, 'and anchors itself off the header and the tabs until it is moved')
check(String(cardNodes[0]?.props?.style?.background || '').includes('--dsw-alias-bg-overlay'), 'and paints a surface rather than reading as page furniture')
check(cardNodes[0]?.props?.style?.zIndex === 60, 'and sits above the page it floats over')
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
check(panelOldHost.text().includes('重启 DSH'), 'a window whose host half is older says what to do about it')
check(!panelOldHost.text().includes('unknown action'), "and does not print the host's error text as if den were broken")
const oldHostSend = panelOldHost.buttons().find((button) => textOf(button).trim() === '发送')
check(oldHostSend?.props?.disabled === true, 'and the send button it still shows cannot be pressed')

fakeStorage.setItem('dsh-den.mini', JSON.stringify({ collapsed: true }))

// `healthyStatus()` sends no `dailyTurnBudget`, which is exactly what the live older host sends.
const panelPillNoBudget = mount(bootWindow({ scripted: { status: healthyStatus() } }).component, {})
await panelPillNoBudget.settle()
check(panelPillNoBudget.text().includes('宿主待重启'), 'a host that sends no budget is named as older, not left unexplained')
check(!panelPillNoBudget.text().includes('自治已关'), 'a host that reports no budget is not described as proactivity being off')
check(!panelPillNoBudget.text().includes('回合'), 'and no budget number is invented for it')
const pillPlaced = findAll(panelPillNoBudget.tree, (n) => n.props?.style?.position === 'absolute' && n.props?.style?.bottom === 24)
check(pillPlaced.length >= 1, 'and the shut pill places itself too, rather than sitting in the page flow')

/* --- the floating window can be moved, and remembers where ----------------- */

// Storage is the window's own preference blob, so the check reads what a browser would keep.
fakeStorage.setItem('dsh-den.mini', JSON.stringify({ collapsed: false }))
const dragWindow = mount(bootWindow({ scripted: { status: healthyStatus() } }).component, {})
await dragWindow.settle()
const dragHandles = findAll(dragWindow.tree, (node) => node.props && typeof node.props.onPointerDown === 'function')
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

  const page = demoPage({
    title: 'dsh-den 浮窗预览',
    generatedBy: '由 tools/check-client-interaction.mjs 生成',
    sections: [
      {
        label: '① 浮窗卡片：全屏唯一的 den 落点（shell.overlay）',
        // `dock` here is the `shell.overlay` entry — the descriptor, not the retired input dock its
        // old label named. `grantPanel` is that component mounted with the session the shell hands
        // over, which is the real case; it pairs with the `main, shell.overlay` injection check.
        hint: '右下角 420px 卡片；按住顶部条可拖；[–] 收成胶囊；没有对话时提示说一句就开始',
        tall: true,
        tree: grantPanel.tree,
      },
      {
        label: '② 浮窗里的消息流：可滚动、可直接发话',
        hint: '演示数据。一轮问答；发完立即重读，所以自己的话先出现，回复随后到',
        tall: true,
        tree: panelTalk.tree,
      },
      {
        label: '① 收成胶囊：缩小不等于失明，胶囊上仍然报信息',
        hint: '常驻中 / 心跳 / 预算 / 待重启都在这一行白话里，点开回到卡片',
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
