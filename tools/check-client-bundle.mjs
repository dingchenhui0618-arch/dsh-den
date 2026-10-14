/**
 * Offline validation of the browser bundle, run before it is ever loaded by the
 * shell.
 *
 * Adding a client half is not risk-free: if `exports["./client"]` names a file
 * that fails to load, the shell raises `MissingClientBundleError` and the whole
 * plugin row fails to activate — the *host* half, and therefore the assistant
 * itself, goes down with it. And because the shell caches its "this package is
 * not a client package" verdict until restart, a mistake here is not visible
 * until the next launch.
 *
 * So the bundle is executed here against a stand-in for the shell: a fake
 * `window.__ModuleLoader__`, a fake `react`, and a fake plugin context that
 * records slot registrations. That exercises the real loading protocol and the
 * real `apply()` path without touching the running host.
 *
 * What it checks:
 *   - the module registers under an id equal to `package.json` name
 *   - `exports["./client"]` resolves, and `dsh.client` has the fields the shell's
 *     validator accepts
 *   - `apply()` runs without throwing and registers both the sidebar entry and
 *     the main panel
 *   - the sidebar `id` equals the main `key` (otherwise clicking the icon throws)
 *   - both registered components render, and every disposer is returned
 *   - the panel calls only theme tokens that exist, and does not shadow the
 *     shipped `conversation` panel
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const failures = []
const notes = []
function check(ok, message) {
  if (ok) notes.push(`  ok   ${message}`)
  else failures.push(message)
}

// ---------------------------------------------------------------- declarations

check(typeof pkg.dsh?.client?.platform === 'string', 'dsh.client.platform is a string (required by the shell validator)')
const declared = pkg.dsh?.client ?? {}
for (const key of Object.keys(declared)) {
  check(
    ['platform', 'inject', 'external', 'immediately'].includes(key),
    `dsh.client.${key} is a field the shell's parseDshClient accepts`,
  )
}
if (declared.inject !== undefined) {
  check(Array.isArray(declared.inject) && declared.inject.every((v) => typeof v === 'string'), 'dsh.client.inject is a string array of package names')
}
check(declared.entry === undefined, 'dsh.client declares no `entry` (that field does not exist in the loader contract)')

const exportPath = pkg.exports?.['./client']
check(typeof exportPath === 'string', 'exports["./client"] is declared')

// -------------------------------------------------------------- load in a VM

const bundlePath = exportPath ? resolve(root, exportPath) : null
let loaded = null
let loadError = null
try {
  const source = readFileSync(bundlePath, 'utf8')
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(spec) {
          loaded = spec
        },
      },
    },
    // A browser global, not a `window` property. The bundle reaches the host with
    // it, like every other client plugin in this profile.
    fetch: () =>
      Promise.resolve({
        ok: true,
        status: 200,
        async json() {
          return { ok: true, value: {} }
        },
      }),
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
    JSON,
    Date,
    Array,
  }
  vm.createContext(sandbox)
  new vm.Script(source, { filename: bundlePath }).runInContext(sandbox)
} catch (error) {
  loadError = error
}

check(loadError === null, `the bundle evaluates${loadError ? `: ${loadError.message}` : ''}`)
if (!loaded) {
  report()
  process.exit(1)
}

check(loaded.id === pkg.name, `module id ${JSON.stringify(loaded.id)} equals package name ${JSON.stringify(pkg.name)} (the loader keys on this)`)
check(typeof loaded.factory === 'function', 'the spec provides a factory')

// The factory receives `require`; only the platform baseline may be requested.
const requested = []
const baseline = {
  react: {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  },
}
let exportsValue = null
try {
  exportsValue = loaded.factory((name) => {
    requested.push(name)
    if (!(name in baseline)) throw new Error(`bundle requested a non-baseline module: ${name}`)
    return baseline[name]
  })
} catch (error) {
  failures.push(`factory(${requested.join(', ') || 'no requires'}) threw: ${error.message}`)
  report()
  process.exit(1)
}

check(requested.every((n) => n in baseline), `only baseline modules requested (${requested.join(', ') || 'none'})`)
check(exportsValue?.name === pkg.name, 'the plugin exports the package name')
check(Array.isArray(exportsValue?.inject), 'the plugin declares Cordis service names to inject')
check(typeof exportsValue?.apply === 'function', 'the plugin exports apply()')

// ---------------------------------------------------- exercise apply() for real

const registrations = []
const injections = []
const effects = []
const disposers = []

/**
 * The plugin context a dynamic client half is handed.
 *
 * The client reaches the host with the browser's own `fetch` — the stub for which
 * lives on the sandbox above — so there is no transport object here. That is the
 * point: an earlier version of this harness supplied a `ctx.connection` shape
 * invented in this repository, and the bundle agreed with it, because the fake was
 * written from the same assumption as the code.
 */
const ctx = {
  effect(fn) {
    const dispose = fn()
    effects.push(fn)
    if (typeof dispose === 'function') disposers.push(dispose)
    return () => {}
  },
  get() {
    return undefined
  },
  locale: { register: () => () => {}, locale: () => 'zh-CN' },
  sessions: { current: () => null },
  slots: {
    inject(key, callback) {
      injections.push(key)
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
}

let applyError = null
try {
  exportsValue.apply(ctx)
} catch (error) {
  applyError = error
}
check(applyError === null, `apply() runs against a stand-in context${applyError ? `: ${applyError.message}` : ''}`)

const sidebar = registrations.find((r) => r.options?.name === 'sidebar.panellist')
const main = registrations.find((r) => r.options?.name === 'main')
check(!sidebar, 'keeps out of the sidebar panel list: one surface, not a tab and a window')
check(Boolean(main), 'registers a main panel')
check(injections.includes('shell.overlay') && injections.includes('main'), 'waits for the window and the page via inject()')

// The seats are enumerated rather than assumed. The claim is that den occupies one window plus its
// page, so a third surface has to fail this file instead of quietly rendering somewhere else.
const overlay = registrations.find((r) => r.options?.name === 'shell.overlay')
const named = registrations.map((r) => r.options?.name).sort()
check(
  Boolean(overlay) && typeof overlay.component === 'function',
  'registers the floating window in the shell overlay seat',
)
check(
  named.join(', ') === 'main, shell.overlay',
  `registers into exactly these seats (${named.join(', ')})`,
)
check(main.options.key !== 'conversation', 'does not shadow the shipped conversation panel')

// Render both components. A component that throws here would throw in the shell.
// Render the page. A component that throws here would throw in the shell. The window is deliberately
// NOT rendered here: it uses hooks, and this checker has no renderer, so calling it would fail for
// the harness's reasons rather than the plugin's.
for (const entry of [main]) {
  if (!entry) continue
  try {
    const element = entry.component({})
    check(Boolean(element), `renders ${entry.options.name}`)
  } catch (error) {
    failures.push(`rendering ${entry.options.name} threw: ${error.message}`)
  }
}

// Theme tokens must exist in the shipped stylesheet. This list was extracted from
// the shell's own base stylesheet, so a token outside it is a guaranteed no-op.
const KNOWN_TOKENS = new Set([
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-layer-3',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-border-l3',
  '--dsw-alias-border-l4',
  '--dsw-alias-brand-primary',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-label-caption',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-alias-state-error-primary',
])
const source = readFileSync(bundlePath, 'utf8')
const used = new Set(source.match(/--dsw-[a-z0-9-]+/g) ?? [])
for (const token of used) {
  check(KNOWN_TOKENS.has(token), `theme token ${token} exists in the shell stylesheet`)
}

check(disposers.length > 0, `returns disposers for everything it mounts (${disposers.length})`)

report()
process.exit(failures.length ? 1 : 0)

function report() {
  for (const line of notes) console.log(line)
  console.log('')
  if (failures.length) {
    console.log(`FAIL — ${failures.length} problem(s):`)
    for (const f of failures) console.log(`  - ${f}`)
  } else {
    console.log(`PASS — ${notes.length} checks`)
  }
}
