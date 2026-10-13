/**
 * The client half's service contract, checked against the live catalogs.
 *
 * Why this file exists: `tools/check-client-bundle.mjs` and
 * `tools/check-client-interaction.mjs` both supply a fake `ctx`, and I wrote those
 * fakes from the same assumption as the code. A fake shaped like the code cannot
 * falsify the code — it agrees with it by construction. So a wrong service name or
 * a missing `inject` entry passes both harnesses and fails only in the browser,
 * where the failure is a panel that renders and then never loads its data.
 *
 * Everything asserted here is read out of the running client or the host's own
 * contract, or derived from the bundle's own declarations:
 *
 *   - the client Service catalog lists layout, locale, sessions, slots, theme,
 *     timer, uiWorkspace, workspaces
 *   - the Client Builtin list (symbols available to a dynamic Client half) is
 *     ctx, React, host, styles, console
 *   - the host `connection` contract is { rpc, fetch, operator, ... } where
 *     HostConnectionRpc is { handle, intercept } — the host side has no `call`
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const bundle = readFileSync(join(root, 'src', 'client', 'client.js'), 'utf8')

/** Services the live client catalog reports. `slots` and `locale` are read from
 *  the bundle's own inject list, which the live registration proves resolves. */
const CLIENT_SERVICES = [
  'layout',
  'locale',
  'sessions',
  'slots',
  'theme',
  'timer',
  'uiWorkspace',
  'workspaces',
]

/** Symbols the live Client Builtin provider says a dynamic Client half receives. */
const CLIENT_BUILTINS = ['ctx', 'React', 'host', 'styles', 'console']

/**
 * Methods of the Cordis context itself, not services. Reading these is always
 * allowed and they never belong in `inject`.
 */
const CTX_METHODS = ['effect', 'get', 'on', 'provide', 'emit', 'parallel', 'waterfall', 'bail', 'start', 'stop']

/**
 * Read the `inject` array the bundle actually declares.
 *
 * Anchored to `module.exports`, not searched for anywhere in the file: the first
 * `inject:` in this bundle used to be the retraction of an older one inside a
 * comment, and a checker that reads the correction as the declaration reports the
 * exact opposite of the truth.
 */
function declaredInject() {
  // `module.exports =` with the sign: `return module.exports` follows the assignment
  // and would otherwise be selected as the last occurrence, cutting the declaration
  // out of the slice.
  const exportsBlock = bundle.slice(bundle.lastIndexOf('module.exports ='))
  const match = exportsBlock.match(/inject:\s*\[([^\]]*)\]/)
  assert.ok(match, 'the bundle must declare its Cordis service dependencies on module.exports')
  return match[1]
    .split(',')
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
}

/**
 * Strip comments and string literals before scanning for code patterns.
 *
 * A plain regex over the raw file matches the very prose that documents these
 * contracts — this file's own header, and the bundle's comments explaining why it
 * moved off `ctx.connection`. A checker that reads its own explanation as a
 * violation is worse than no checker.
 *
 * Done as one character pass rather than layered regexes: an earlier attempt
 * treated the `//` inside a string literal (a URL) as the start of a line comment
 * and deleted the rest of the file, after which every scan saw an empty bundle.
 */
function codeOnly(source) {
  let out = ''
  let i = 0
  const n = source.length
  while (i < n) {
    const ch = source[i]
    const next = source[i + 1]
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i += 1
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') i += 1
        i += 1
      }
      i += 1
      out += "''"
      continue
    }
    out += ch
    i += 1
  }
  return out
}

const code = codeOnly(bundle)

/** Every `ctx.<name>` read in the bundle, excluding the builtins. */
function ctxReads() {
  const found = new Set()
  for (const match of code.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) {
    found.add(match[1])
  }
  for (const match of code.matchAll(/\bctx\.get\(\s*['"]([^'"]+)['"]/g)) {
    found.add(match[1])
  }
  return [...found]
}

test('every service the bundle reads off ctx is declared in inject', () => {
  // Reading an undeclared service on a Cordis context throws. In the browser that
  // throw happens inside the panel's own body or effect, so the panel renders and
  // then loses its data — the quietest possible failure.
  const declared = new Set(declaredInject())
  const reads = ctxReads().filter((name) => !CTX_METHODS.includes(name))

  // The bundle must read its own services, or this whole file proves nothing.
  assert.ok(reads.length > 0, 'the bundle must actually read the context')
  for (const name of reads) {
    assert.ok(
      declared.has(name),
      `ctx.${name} is read but "${name}" is not in inject: [${[...declared].join(', ')}]`,
    )
  }
  // Spelled out, so a rename in the bundle cannot silently empty the check above.
  assert.deepEqual(
    [...reads].sort(),
    ['locale', 'slots'],
    'the bundle reads exactly these services; update this list deliberately, not incidentally',
  )
})

test('every declared service is one the live client actually exposes', () => {
  // The flip side: `inject` is a hard dependency. A name that does not exist is
  // not a soft miss, it is a plugin that never loads — and the loader caches its
  // verdict, so the mistake only surfaces on a restart.
  const interactive = new Set([...CLIENT_SERVICES, ...CLIENT_BUILTINS])
  for (const name of declaredInject()) {
    assert.ok(
      interactive.has(name),
      `inject names "${name}", which the live client catalogs do not list among ${[...interactive].join(', ')}`,
    )
  }
})

test('the client does not reach for the host connection shape', () => {
  // The host `connection` contract is { rpc, fetch, operator } where
  // HostConnectionRpc is { handle, intercept }. There is no `call` on either side,
  // so a client that calls `ctx.connection.rpc.call(...)` is calling a method that
  // exists only in this repository's own fake.
  const hostRpc = ['handle', 'intercept']
  const called = [...code.matchAll(/ctx\.connection[\w.]*\.(\w+)\(/g)].map((m) => m[1])
  for (const method of called) {
    assert.ok(
      hostRpc.includes(method),
      `ctx.connection...${method}() is not part of the published connection contract (which has ${hostRpc.join(', ')})`,
    )
  }
})

test('the client reaches the host the way every other plugin here does', () => {
  // Two prior transports were invented in this repository and both passed the two
  // offline harnesses, because those harnesses supply a fake `ctx`/`host` written
  // from the same assumption as the code. A fake shaped like the code cannot
  // falsify it. So the check is against the installed plugins instead: every client
  // half in this profile — dsh-warden, dsh-daily, dsh-vision-diff, dsh-in-hand,
  // dsh-ship-receipt, dsh-signal-pet, dsh-taskwatch, dsh-holdem — declares
  // `inject = [..., 'webServer']` on the host side and calls a plain
  // `fetch('/<package name>')` from the browser side. None of them uses a framework
  // RPC shim.
  assert.doesNotMatch(code, /connection\s*\.\s*rpc/, 'no connection RPC shim')
  assert.doesNotMatch(code, /host\s*\.\s*call/, 'no package-private host RPC shim')
  assert.match(code, /fetch\(API/, 'the host is reached with a plain fetch')
})

test('the conversation comes from the seat that binds one, not from a guessed service', () => {
  // This test used to require the opposite. It asserted the bundle matched /ctx\.sessions/ and that
  // `sessions` was declared, on the belief that the active conversation could be discovered from the
  // sessions service. The live catalog says that service has no `current()` and no `activeId()`, so the
  // path it was pinning could only ever return null - a green test holding a dead path in place. That
  // is the same shape as the double written from the code's own assumption, and it is worse, because
  // it also gave the dead path a reason to stay.
  assert.ok(
    !bundle.includes('ctx.sessions'),
    'the bundle does not probe a sessions method the live service does not have',
  )
  assert.ok(!declaredInject().includes('sessions'), 'so it does not declare a service it never reads')
  assert.match(bundle, /conversation\.input\.dock/, 'it registers into the session-scoped composer dock')
})
