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

{
  const sandbox = {
    navigator: fakeNavigator,
    window: {
      __ModuleLoader__: { load: (spec) => { loaded = spec } },
      // The panel looks for this hook, so an offline harness can observe the
      // action state that no DOM would otherwise expose.
      __dshDenDebug: (event) => sinkLog.push(event),
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
function bootDock({ scripted = {} } = {}) {
  calls.length = 0
  scriptReplies(scripted)
  const ctx = makeCtx()
  exportsValue.apply(ctx)
  const dock = ctx.slots.entries.find((entry) => entry.options?.name === 'conversation.input.dock')
  if (!dock) throw new Error('the bundle did not register a composer-dock entry')
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
check(text.includes('卡住 1'), 'a stuck step rides on that same line, not behind details')// Looking for the *string* would pass on the copy that says where the control is, so this looks for a
// button: an affordance the page would have to render to be clickable.
check(
  !panel.buttons().some((button) => textOf(button).trim() === '授予'),
  'the status page renders no grant button, because it has no conversation to grant for',
)
check(text.includes('输入框上方'), 'and it says where the grant control is instead')
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
check(
  !calls.some((entry) => entry.body?.action === 'schedules/list'),
  'the status page does not ask for a conversation it cannot name',
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

const dock = bootDock({
  scripted: { status: healthyStatus({ autonomy: 'session-active', autonomyKnown: true }), 'schedules/list': { ok: true, value: { schedules: [], invalidCount: 0 } } },
})
check(
  dock.options.name === 'conversation.input.dock',
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
check(grantText.includes('授予') && grantText.includes('撤销'), 'the dock renders the autonomy controls')
check(grantText.includes('已授予'), 'and reports the conversation it was told about as granted')
const dockStatus = calls.find((entry) => (entry.body?.action ?? 'status') === 'status')
check(
  dockStatus?.body?.sessionId === 'session-active',
  'the dock carries the session the shell handed it, rather than discovering one',
)

check(text.includes('在对话里说'), 'an empty schedule list is called out, and names the cheaper path: saying it')
check(text.includes('消息框里说一句'), 'and creating one is described as something said, not a form to go and find')

/* --- clicking Grant mints a token and does NOT claim authority ------------- */

const revokeCalls = () => calls.filter((entry) => entry.body?.action === 'autonomy/request')
check(revokeCalls().length === 0, 'no autonomy action is sent before a click')

await grantPanel.click('授予')

const grantCall = calls.find((entry) => entry.body?.action === 'autonomy/request')
check(Boolean(grantCall), 'clicking Grant sends an autonomy/request')
check(grantCall?.body?.autonomy === true, 'the grant request asks for autonomy: true')
check(grantCall?.body?.sessionId === 'session-active', 'the grant request is scoped to the active conversation')
check(
  calls.every((entry) => entry.body?.action !== 'autonomy/confirm'),
  'clicking Grant never confirms authority on its own — a token must come back first',
)

/* --- the token is shown to the human -------------------------------------- */

scriptReplies({
  'autonomy/request': { ok: true, value: { token: 'tok-abc123', autonomy: true, expiresAt: Date.now() + 600000, ttlMs: 600000 } },
})
const panel2 = mount(
  bootDock({ scripted: { status: healthyStatus(), 'schedules/list': { ok: true, value: { schedules: [], invalidCount: 0 } } } }).component,
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
  bootDock({
    scripted: {
      status: healthyStatus({ autonomy: 'session-active', autonomyKnown: true }),
      'schedules/list': { ok: true, value: { schedules: [], invalidCount: 0 } },
    },
  }).component,
  { sessionId: 'session-active' },
)
await presetPanel.settle()
check(presetPanel.text().includes('每天看一眼 CI 失败'), 'the empty state offers a preset instead of only a form')
check(presetPanel.inputs().length === 0, 'and it asks for nothing to be typed before anything happens')

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
check(registersSlot('sidebar.panellist'), 'the resident owns a row in the sidebar panel list')
check(registersSlot('sidebar.toggle.badge'), 'and a dot in the seat the shell reserves for one')

// --- the static preview page --------------------------------------------------------------------
//
// How the panel *looks* is decided by a human, not by an assertion, so the harness can emit the very
// trees it just rendered as a standalone page. It is generated here, from the same components the
// checks drive, because a hand-written preview drifts: the checks keep passing while the file on disk
// quietly shows the previous design.
if (process.argv.includes('--demo')) {
  const demoPath = process.argv[process.argv.indexOf('--demo') + 1] || 'docs/demo.html'
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const { demoPage } = await import('./panel-tree.mjs')
  const demoMain = mount(component, {})
  await demoMain.settle()

  const page = demoPage({
    title: 'dsh-den 面板预览',
    generatedBy: '由 tools/check-client-interaction.mjs 生成',
    sections: [
      {
        label: '对话输入框上方那条（dock）：常驻、授权、一键自检都在这一条上',
        // `dock` is the `bootDock()` descriptor — a component plus its options, never mounted — so
        // `dock.tree` was always undefined and this section rendered an empty box. `grantPanel` is the
        // same seat mounted with the session the shell hands over, which is the real case.
        hint: '默认只占一行；点了预设就建好，不需要打字',
        tree: grantPanel.tree,
      },
      {
        label: '页面座位（默认视图，按下 [详情] 之前）',
        hint: '一行状态白话；八行技术指标收在 [详情] 里；异常状态自动展开',
        tree: demoMain.tree,
      },
    ],
  })
  mkdirSync('docs', { recursive: true })
  writeFileSync(demoPath, page, 'utf8')
  console.log('demo written:', demoPath, page.length, 'bytes')
}
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
  bootDock({ scripted: { status: healthyStatus(), 'schedules/list': { ok: true, value: { schedules: [], invalidCount: 0 } } } }).component,
  { sessionId: 'session-active' },
)
await panel3.settle()

// The dock sits in the conversation, so it must cost one line by default. This was measured the
// other way first: the whole creation form — three labelled inputs and a button — rendered
// permanently above the message box and took most of a screen. The capability still has to be
// reachable from here, because `schedules/create` refuses without a conversation, so the form is
// behind a disclosure rather than gone.
check(panel3.inputs().length === 0, `the dock renders no inputs until asked; saw ${panel3.inputs().length}`)
check(!panel3.text().includes('新建自检'), 'and does not show the submit button either')
check(panel3.text().includes('在对话里说'), 'the empty state points at the conversation, which is the cheaper path')

await panel3.click('新建')
const inputs = panel3.inputs()
check(inputs.length === 3, `the form renders three fields (title, prompt, minutes); saw ${inputs.length}`)

await panel3.type(0, 'CI watch')
await panel3.type(1, 'Report only failures.')
await panel3.type(2, '45')
await panel3.click('新建自检')

const createCall = calls.find((entry) => entry.body?.action === 'schedules/create')
check(Boolean(createCall), 'submitting the form sends schedules/create')
check(createCall?.body?.title === 'CI watch', 'the title is carried through')
check(createCall?.body?.prompt === 'Report only failures.', 'the prompt is carried through')
check(createCall?.body?.everySeconds === 2700, `45 minutes becomes 2700 seconds (saw ${createCall?.body?.everySeconds})`)
check(createCall?.body?.kind === 'interval', 'the created schedule is an interval')
check(createCall?.body?.sessionId === 'session-active', 'the new schedule is scoped to the active conversation')
check(panel3.text().includes('不是权限授予'), 'the panel states that a schedule is not a permission grant')

/* --- invalid input is refused locally, without a wasted round trip --------- */

const panel4 = mount(
  bootDock({ scripted: { status: healthyStatus(), 'schedules/list': { ok: true, value: { schedules: [], invalidCount: 0 } } } }).component,
  { sessionId: 'session-active' },
)
await panel4.settle()
await panel4.click('新建')
await panel4.type(0, 'too often')
await panel4.type(1, 'x')
await panel4.type(2, '1')
await panel4.click('新建自检')
check(
  !calls.some((entry) => entry.body?.action === 'schedules/create'),
  'a sub-5-minute interval is refused in the panel rather than sent to the host',
)
check(panel4.text().includes('at least 5 minutes'), 'the refusal says why')

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
  }, 'conversation.input.dock'),
  { sessionId: 'session-active' },
)
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
  boot({ scripted: { status: healthyStatus({ autonomyKnown: false }), 'schedules/list': { ok: true, value: { schedules: [], invalidCount: 0 } } } }, 'conversation.input.dock'),
  { sessionId: null },
)
await panel8.settle()
const grantButton = panel8.buttons().find((button) => textOf(button).trim() === '授予')
check(grantButton?.props?.disabled === true, 'a grant button without a conversation is disabled, not a no-op')

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

/* ----------------------------------------------------------------- report */

// Stop every panel's poll timer before reporting. This is not just tidiness: the
// panel polls on a 15-second interval, so without the cleanup this process never
// exits, and the cleanup is itself the check that unmounting works.
for (const handle of mounted) handle.unmount()

console.log('')
if (failures.length) {
  console.log(`FAIL — ${failures.length} of ${checkCount} checks failed:`)
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
console.log(`PASS — ${checkCount} interaction checks`)
process.exit(0)
