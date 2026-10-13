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

{
  const sandbox = {
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

function boot({ sessionId = 'session-active', scripted = {} } = {}) {
  calls.length = 0
  // Merge rather than replace: a test that scripts one action and then boots would
  // otherwise silently lose the reply it just installed, which reads as the panel
  // ignoring the response.
  scriptReplies(scripted)
  activeSession = sessionId
  const ctx = makeCtx()
  exportsValue.apply(ctx)
  const main = ctx.slots.entries.find((entry) => entry.options?.name === 'main')
  if (!main) throw new Error('the bundle did not register a main panel')
  return main.component
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
const panel = mount(component, { useSessions: () => ({ activeId: 'session-active' }) })
await panel.settle()

if (process.env.DEN_DEBUG) {
  console.log('calls:', JSON.stringify(calls, null, 2))
  console.log('hook slots:', JSON.stringify(panel.hooks.slots.map((s) => (s && s.deps) || s), null, 2))
  console.log('tree text:', panel.text())
  console.log('elements:', findAll(panel.tree, () => true).map((n) => `${n.type}#${JSON.stringify(textOf(n)).slice(0, 40)}`).join('\n  '))
}

/* --- the panel renders the real state ------------------------------------- */

const text = panel.text()
check(text.includes('Den'), 'the panel renders its title')
check(text.includes('授予') && text.includes('撤销'), 'the panel renders both autonomy buttons')
check(text.includes('自检'), 'the panel renders the self-check section')
check(text.includes('运行中'), 'a running heartbeat is reported as running')
check(text.includes('今天') === false, 'no stray copy is invented')

/* --- the snapshot request carries the session ------------------------------ */

const statusCall = calls.find((entry) => (entry.body?.action ?? 'status') === 'status')
check(Boolean(statusCall), 'the panel requests a status snapshot')
check(statusCall?.body?.action === 'status', 'the snapshot request names the status action explicitly')
check(statusCall?.body?.sessionId === 'session-active', 'the snapshot request carries the active conversation id')

const listCall = calls.find((entry) => entry.body?.action === 'schedules/list')
check(Boolean(listCall), 'the panel asks for the schedule list')
check(listCall?.body?.sessionId === 'session-active', 'the schedule list is scoped to the active conversation')
check(text.includes('助理不会自己醒来'), 'an empty schedule list is called out, not left blank')

/* --- clicking Grant mints a token and does NOT claim authority ------------- */

const revokeCalls = () => calls.filter((entry) => entry.body?.action === 'autonomy/request')
check(revokeCalls().length === 0, 'no autonomy action is sent before a click')

await panel.click('授予')

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
const panel2 = mount(boot({ scripted: { status: healthyStatus(), 'schedules/list': { ok: true, value: { schedules: [], invalidCount: 0 } } } }), {
  useSessions: () => ({ activeId: 'session-active' }),
})
await panel2.settle()
await panel2.click('授予')
if (process.env.DEN_DEBUG) {
  // The sink deliberately reports reply *shape*, not contents, so this shows which
  // actions completed rather than what they returned.
  console.log('PANEL2 sink:', JSON.stringify(sinkLog))
}
check(panel2.text().includes('tok-abc123'), 'the minted token is displayed for the human to carry to the conversation')
check(panel2.text().includes('一次性'), 'the panel explains the token is single-use')

/* --- creating a self-check sends the right payload ------------------------ */

const panel3 = mount(boot({ scripted: { status: healthyStatus(), 'schedules/list': { ok: true, value: { schedules: [], invalidCount: 0 } } } }), {
  useSessions: () => ({ activeId: 'session-active' }),
})
await panel3.settle()
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

const panel4 = mount(boot({ scripted: { status: healthyStatus(), 'schedules/list': { ok: true, value: { schedules: [], invalidCount: 0 } } } }), {
  useSessions: () => ({ activeId: 'session-active' }),
})
await panel4.settle()
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
  }),
  { useSessions: () => ({ activeId: 'session-active' }) },
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
  { useSessions: () => ({ activeId: 'session-active' }) },
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
  { useSessions: () => ({ activeId: 'session-active' }) },
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
  { useSessions: () => ({ activeId: 'session-active' }) },
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
  { useSessions: () => ({ activeId: 'session-active' }) },
)
await holdingPanel.settle()
check(!holdingPanel.text().includes('待命'), 'while the host that holds residency is not labelled standby')

/* --- no active conversation disables the actions instead of guessing ------- */

const panel8 = mount(boot({ sessionId: null, scripted: { status: healthyStatus({ autonomyKnown: false }), 'schedules/list': { ok: true, value: { schedules: [], invalidCount: 0 } } } }), {
  useSessions: () => null,
})
await panel8.settle()
const grantButton = panel8.buttons().find((button) => textOf(button).trim() === '授予')
check(grantButton?.props?.disabled === true, 'without a conversation the grant button is disabled')
check(panel8.text().includes('没有活动会话'), 'and the panel says why')

/* --- a host failure is surfaced, not swallowed ---------------------------- */

const panel9 = mount(
  boot({
    scripted: {
      status: { ok: false, error: { code: 'DEN_STATUS_FAILED', message: 'disk on fire' } },
      'schedules/list': { ok: true, value: { schedules: [], invalidCount: 0 } },
    },
  }),
  { useSessions: () => ({ activeId: 'session-active' }) },
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
  { useSessions: () => ({ activeId: 'session-active' }) },
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
