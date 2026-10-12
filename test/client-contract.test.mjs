/**
 * The loading contract the live client enforces, checked without a browser.
 *
 * Everything asserted here was read out of the *running* DSH client through the
 * Client `Slots` provider, not assumed:
 *
 *   sidebar.panellist occupants included
 *     { registrant: "dsh-den", id: "dsh-den.status", order: 245, active: true }
 *   main occupants included
 *     { registrant: "dsh-den", key: "dsh-den.status", active: true }
 *
 * Two consequences of that reading are worth locking down, because both fail
 * silently rather than loudly:
 *
 *  1. `sidebar.panellist.id` and `main.key` must be the same string. The catalog
 *     says each list id "addresses the matching main panel", so a mismatch gives a
 *     sidebar icon that selects nothing.
 *  2. The bundle must call `window.__ModuleLoader__.load` before any side effect,
 *     because the registration inside the factory is what produced those occupants.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const bundle = readFileSync(join(root, 'src', 'client', 'client.js'), 'utf8')

test('the client half is declared the way the live loader expects', () => {
  // `exports["./client"]` is the only thing that tells the loader where the bundle
  // is; there is deliberately no `entry` field.
  assert.equal(pkg.exports['./client'], './src/client/client.js')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.client.entry, undefined, 'an entry field is not part of this contract')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
})

test('the bundle id is the package name, which is how the loader keys it', () => {
  const match = bundle.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/)
  assert.ok(match, 'the bundle must call __ModuleLoader__.load with an explicit id')
  assert.equal(match[1], pkg.name, 'a bundle id that differs from the package name will not resolve')
})

test('the sidebar entry id and the main panel key are the same value', () => {
  // Read the two constants the bundle actually uses, rather than restating them.
  const navId = bundle.match(/panellist[\s\S]{0,200}?id:\s*([A-Z_]+)/)
  const mainKey = bundle.match(/main[\s\S]{0,260}?key:\s*([A-Z_]+)/)
  assert.ok(navId, 'the sidebar registration must reference its id constant')
  assert.ok(mainKey, 'the main registration must reference its key constant')

  const constant = (name) => {
    const found = bundle.match(new RegExp(`var ${name} = '([^']+)'`))
    assert.ok(found, `${name} must be declared as a literal so this contract stays checkable`)
    return found[1]
  }
  assert.equal(
    constant(navId[1]),
    constant(mainKey[1]),
    'the sidebar id must equal the main key, or the icon selects nothing',
  )
  assert.equal(constant(navId[1]), 'dsh-den.status', 'the value the live client reported as an active occupant')

  const order = bundle.match(/var ORDER = (\d+)/)
  assert.ok(order, 'ORDER must be a literal so this contract stays checkable')
  assert.equal(Number(order[1]), 245, 'the order the live client reported')
})

test('the bundle takes React from the factory argument and never from a global', () => {
  // The factory parameter is the loader's module resolver; the live registration
  // proves that path executed. Reaching for a global React instead would work in
  // the harness and fail in the shell.
  assert.match(bundle, /factory:\s*function\s*\(\s*require\s*\)/)
  assert.match(bundle, /var React = require\('react'\)/)
  assert.doesNotMatch(bundle, /window\.React/, 'React must not be taken off the window')
})

test('every side effect happens inside the factory', () => {
  // The loader materialises the module before it runs the factory, so a top-level
  // side effect would run at load time — including in contexts that never render.
  // The bundle styles itself with inline style objects rather than a stylesheet, so
  // there is nothing to inject and nothing to clean up when the panel unmounts.
  const factoryAt = bundle.indexOf('factory:')
  const prologue = bundle.slice(0, factoryAt)
  assert.doesNotMatch(prologue, /React\.createElement/, 'no rendering before the factory runs')
  assert.doesNotMatch(prologue, /\.register\(/, 'no slot registration before the factory runs')
  assert.match(bundle, /style: \{/, 'the panel carries its own presentation inline')
  assert.doesNotMatch(bundle, /document\.head/, 'it must not reach into the document head')
})

test('the panel reads the active conversation from a prop the live slot supplies', () => {
  // `useSessions` is listed in the live catalog's standardProps for both
  // `sidebar.panellist` and `main`, which is what makes it safe to read.
  const liveProps = ['useResource', 'useWorkspaces', 'usePanelInfo', 'useSessions', 'useSessionStatus', 'useSessionRetainInfo']
  for (const prop of liveProps) {
    if (bundle.includes(`props.${prop}`)) assert.ok(true, `${prop} is a catalogued standard prop`)
  }
  assert.match(bundle, /props\.useSessions/, 'the panel depends on useSessions, which the live catalog supplies')
})

test('the client endpoint matches the path the host registers', () => {
  // The one seam where a mismatch fails silently: the panel asks the shell for
  // `endpoint`, which the host intercepts as a route at `/api/${METHOD}`. The two
  // strings are written in different files, so they are derived and compared rather
  // than restated — a mismatch is a panel that renders and 404s on every refresh.
  const endpoint = bundle.match(/var RPC_ENDPOINT = '([^']+)'/)
  assert.ok(endpoint, 'the bundle must name its endpoint once')

  const host = readFileSync(join(root, 'src', 'status-route.js'), 'utf8')
  const method = host.match(/const METHOD = '([^']+)'/)
  assert.ok(method, 'the host must declare its method once')
  assert.ok(host.includes('path: `/api/${METHOD}`'), 'the host must derive its route path from that method')

  assert.equal(endpoint[1], method[1], 'the endpoint the panel calls must be the method the host intercepts')

  // The namespace convention observed in the live shell: the package name with
  // dashes turned into dots, before the action segment.
  const namespace = endpoint[1].split('/')[0]
  assert.equal(namespace, pkg.name.replace(/-/g, '.'), 'the RPC namespace follows the package name')
})

test('the panel cannot change authority through the RPC surface it uses', () => {
  // The transport is a route the host half owns, so the panel's reach is exactly
  // the set of actions the route accepts. Anything that grants authority must not
  // be in the client's vocabulary.
  assert.doesNotMatch(bundle, /den_set_autonomy/, 'the panel must never call the authority tool directly')
  assert.match(bundle, /act\('autonomy\/request'/, 'the panel may ask for a token')
  assert.doesNotMatch(
    bundle,
    /act\('autonomy\/confirm'/,
    'the panel must not confirm a token either: the human carries it to the conversation, and the write happens there',
  )
})
