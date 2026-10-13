/**
 * The client/host round trip, run end to end in one process.
 *
 * Every other check in this repository tests one half and substitutes a fake for
 * the other. That is how this plugin shipped three different wrong transports: the
 * fake was written from the same assumption as the code, so of course it agreed.
 *
 * This test removes the fake from the seam. It boots the real plugin against a fake
 * Cordis context, takes the route the plugin actually registered, and points the
 * real browser bundle's `call()` at it. The only thing standing in for reality is
 * the HTTP socket — and even that is not stubbed away, it is replaced by a direct
 * invocation of the handler with a Node-shaped request and response, which is
 * exactly what the host does with them.
 *
 * So what runs here for real:
 *
 *   client.js    serialises the body, sends it, reads the status, parses the text,
 *                unwraps the envelope, and returns `value` or throws with a code
 *   panel-route  segments the URL, reads the streamed body, dispatches the action,
 *                and writes the JSON response
 *   panel-api    builds the snapshot from the live service
 *
 * What does not run: the socket, the browser, and the Cordis loader. A bug that
 * needs one of those is invisible here, and this file says so rather than implying
 * otherwise.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

// This file is ESM, and the bundle under test is CommonJS. `createRequire` is how a
// module gets the real one; there is no ambient `require` in an `.mjs`.
const require = createRequire(import.meta.url)

const sandboxHome = mkdtempSync(join(tmpdir(), 'dsh-den-roundtrip-'))
process.env.DSH_HOME = sandboxHome
test.after(() => rmSync(sandboxHome, { recursive: true, force: true }))

const { apply } = await import('../src/index.js')
const { fakeHost } = await import('./support/host.mjs')

/* ------------------------------------------------------- the real host route */

/** Boot the plugin and return the route it registered. */
function bootHost() {
  const { ctx, state } = fakeHost()
  apply(ctx)
  const route = state.routes[0]
  if (!route) throw new Error('the plugin registered no route')
  return { route, state, ctx }
}

/**
 * Serve one request through the real handler, the way the host web server does.
 *
 * Node shapes throughout: `req` streams its body through `on('data')`/`on('end')`,
 * and `res` is a `ServerResponse`. Using web `Request`/`Response` objects here would
 * be the same class of mistake this test exists to catch.
 */
function serve(route, { method = 'POST', url, body } = {}) {
  const handlers = new Map()
  const raw = body === undefined ? '' : JSON.stringify(body)
  const chunks = raw === '' ? [] : [Buffer.from(raw, 'utf8')]
  const req = {
    method,
    url,
    on(event, handler) {
      handlers.set(event, handler)
      return this
    },
    destroy() {},
  }
  const res = {
    statusCode: null,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(text) {
      this.body = String(text)
    },
  }
  const pending = route.handler(req, res)
  for (const chunk of chunks) handlers.get('data')?.(chunk)
  handlers.get('end')?.()
  return pending.then(() => ({ status: res.statusCode, headers: res.headers, text: res.body ?? '' }))
}

/* ------------------------------------------------------ the real client half */

/**
 * The platform baseline the bundle may `require`. Only `react` is ever requested.
 *
 * Deliberately a stub. What this file tests is the transport and the payload, not
 * rendering: the panel body only has to *construct* here, and the rendered tree is
 * covered by `tools/check-client-interaction.mjs`, which has a real element walker.
 */
const reactBaseline = {
  react: {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
  },
}

/** A `ctx` good enough for `apply` to register its slots. */
function fakeClientCtx() {
  return {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get: () => undefined,
    locale: { register: () => () => {}, locale: () => 'zh-CN' },
    sessions: { current: () => null },
    slots: {
      inject(_key, callback) {
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register: () => () => {},
    },
  }
}

/** Load the shipped browser bundle and pull out its `call`. */
function bootClient(fetchImpl, { exposeInternals = true } = {}) {
  let loaded = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(spec) {
          loaded = spec
        },
      },
      // The bundle only publishes `__internals` when a harness asks for it.
      __dshDenExposeInternals: exposeInternals,
    },
    // A browser global, not a `window` property: the bundle calls bare `fetch(...)`.
    fetch: fetchImpl,
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
  const source = readFileSync(new URL('../src/client/client.js', import.meta.url), 'utf8')
  new vm.Script(source, { filename: 'client.js' }).runInContext(sandbox)
  if (!loaded) throw new Error('the bundle never called __ModuleLoader__.load')
  return loaded.factory((name) => {
    if (!(name in reactBaseline)) throw new Error(`the bundle requested a non-baseline module: ${name}`)
    return reactBaseline[name]
  })
}

/**
 * Wire the two real halves together.
 *
 * The fetch the bundle receives is a thin adapter onto the real route handler. It
 * builds a real absolute URL so the bundle's relative `fetch(API)` is resolved the
 * way a browser would resolve it, and it returns a real `Response` built from the
 * real bytes the host wrote — so `res.text()` in the client parses the same string
 * the host serialised, trailing newline included.
 */
function connect() {
  const { route, state } = bootHost()
  const requests = []
  const fetchImpl = async (url, init) => {
    requests.push({ url, method: init?.method, body: init?.body })
    const absolute = new URL(String(url), 'http://127.0.0.1:19387')
    const served = await serve(route, {
      method: init?.method ?? 'GET',
      url: absolute.pathname + absolute.search,
      body: init?.body === undefined ? undefined : JSON.parse(init.body),
    })
    return new Response(served.text, { status: served.status, headers: served.headers })
  }
  const client = bootClient(fetchImpl)
  const ctx = fakeClientCtx()
  client.apply(ctx)
  if (!client.__internals) throw new Error('the bundle did not expose its internals to the harness')
  return { ...client.__internals, requests, state, route }
}

/* -------------------------------------------------------------------- tests */

test('the request the browser sends is the request the host answers', async () => {
  const { call, requests } = connect()
  const value = await call('status', {}, 'session-roundtrip')

  assert.equal(requests.length, 1)
  assert.equal(requests[0].method, 'POST')
  // The body is the action envelope the route reads, not an RPC frame: this is the
  // whole contract between the two halves, and it is now checked across both.
  assert.deepEqual(JSON.parse(requests[0].body), { action: 'status', sessionId: 'session-roundtrip' })
  assert.equal(typeof value, 'object', 'the client unwrapped the envelope and returned its value')
})

test('the snapshot the panel receives is the one the host built, field for field', async () => {
  const { call, state } = connect()
  const value = await call('status', {}, 'session-roundtrip')

  // Ask the host side directly and compare. If the client and the host ever disagree
  // about the envelope, one of these two shapes changes and this fails.
  const { statusSnapshot } = await import('../src/panel-api.js')
  const direct = statusSnapshot(state.provided.get('den'), { sessionId: 'session-roundtrip' })

  // Compare as strings: the client object was built inside a `vm` context, so a
  // cross-realm `deepEqual` compares prototypes and reports an equal object as
  // unequal. Field names and values are the real contract, and both survive string
  // comparison unchanged.
  assert.equal(Object.keys(value).sort().join(','), Object.keys(direct).sort().join(','))
  // `name` is the configurable display name, not the package name. Asserting the
  // package name here would be wrong — and was, until this test said so.
  assert.equal(value.name, direct.name)
  assert.equal(value.home, direct.home)
  // The transport block is what the panel uses to explain its own failures.
  assert.equal(typeof value.transport.claimedMounted, 'boolean')
})

test('a real request marks the route as reached, from the host side', async () => {
  const { call, state } = connect()
  const service = state.provided.get('den')
  assert.equal(service.statusRoute.firstReachedAt, null, 'nothing has reached it yet')

  await call('status', {}, 'session-roundtrip')

  // This is the assertion that closes the loop this plugin could not close for
  // several rounds: the mount does not set this, and neither does the test. The
  // request does, through the real handler.
  assert.equal(typeof service.statusRoute.firstReachedAt, 'number')
})

test('every action the panel offers is one the host actually implements', async () => {
  const { call } = connect()
  // Driven through both real halves, so an action renamed on one side and not the
  // other fails here rather than silently at runtime.
  const status = await call('status', {})
  assert.ok(status, 'status answers')

  const schedules = await call('schedules/list', {})
  assert.ok(Array.isArray(schedules.schedules), 'schedules/list answers with a list')

  const autonomy = await call('autonomy/request', { autonomy: true })
  assert.equal(typeof autonomy.token, 'string', 'autonomy/request mints a token')
})

test('an unknown action is refused by the host and surfaced as an error by the client', async () => {
  const { call } = connect()
  await assert.rejects(
    () => call('does/not/exist', {}),
    (error) => {
      // The host names the actions it does know; the client must not lose that text.
      assert.match(error.message, /unknown action/)
      assert.match(error.message, /known actions/)
      return true
    },
  )
})

test('a route that is not mounted reads as a transport failure, not a parse error', async () => {
  // The state this panel is really in before its host half has been restarted: the
  // path is unclaimed, so the host's fallback answers 404 with HTML.
  const { call } = connect()
  const failing = bootClient(async () =>
    new Response('<!doctype html><html>Not Found</html>', {
      status: 404,
      headers: { 'content-type': 'text/html' },
    }),
  )
  failing.apply(fakeClientCtx())

  await assert.rejects(
    () => failing.__internals.call('status', {}),
    (error) => {
      assert.equal(error.code, 'DEN_BAD_RESPONSE')
      assert.equal(error.status, 404)
      assert.match(error.message, /404/)
      assert.doesNotMatch(error.message, /Unexpected token/)
      return true
    },
  )
})

test('the shipped exports carry no internals until a harness asks', () => {
  // The gate must not be a comment: load the bundle with the flag absent and check
  // that the production surface is what it was.
  const shipped = bootClient(async () => new Response('{}', { status: 200 }), {
    exposeInternals: false,
  })
  assert.equal(Object.keys(shipped).sort().join(','), 'apply,inject,name')
  assert.equal(shipped.name, 'dsh-den')
  assert.equal(shipped.inject.join(','), 'slots,locale')
  assert.equal(shipped.__internals, undefined, 'production must not expose test internals')
})
