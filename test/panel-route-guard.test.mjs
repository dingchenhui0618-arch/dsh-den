import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

const { ROUTE, foreignRequest, mountPanelRoute } = await import('../src/panel-route.js')

/** A request the way the host hands one over: a readable body with method, url and headers. */
function request({ method = 'POST', body = '{}', headers = {} } = {}) {
  const stream = Readable.from([Buffer.from(body, 'utf8')])
  return Object.assign(stream, { method, url: ROUTE, headers })
}

/** The smallest response object `writeJson` needs, recording what was written. */
function response() {
  const seen = { status: null, body: null, headers: null }
  return {
    seen,
    writeHead(status, headers) { seen.status = status; seen.headers = headers; return this },
    end(chunk) { seen.body = chunk === undefined ? null : String(chunk); return this },
    setHeader() { return this },
  }
}

test('a page that is not the panel cannot reach these actions', () => {
  assert.match(
    foreignRequest(request({ headers: { 'sec-fetch-site': 'cross-site', host: '127.0.0.1:19387' } })),
    /cross-site/,
  )
  assert.match(
    foreignRequest(request({ headers: { 'sec-fetch-site': 'same-site', host: '127.0.0.1:19387' } })),
    /same-site/,
  )
  assert.match(
    foreignRequest(request({ headers: { origin: 'http://evil.example', host: '127.0.0.1:19387' } })),
    /another origin/,
  )
  assert.match(foreignRequest(request({ headers: { origin: 'not a url' } })), /cannot be read/)
  assert.match(
    foreignRequest(request({ headers: { 'content-type': 'text/plain', host: '127.0.0.1:19387' } })),
    /has to be JSON/,
  )
})

test('a POST that declares no content type is a non-browser caller, and is not refused', () => {
  // The end-to-end route test and a curl probe send no content type; a browser always sends one, so
  // this stays closed to the web without locking out everything that is not a web page.
  assert.equal(foreignRequest(request({ headers: { host: '127.0.0.1:19387' } })), null)
})

test('the panel itself, and callers that are not browsers at all, still get through', () => {
  assert.equal(
    foreignRequest(
      request({
        headers: {
          host: '127.0.0.1:19387',
          origin: 'http://127.0.0.1:19387',
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
        },
      }),
    ),
    null,
  )
  // A curl probe sends neither header, and denying it would only make this route untestable.
  assert.equal(foreignRequest(request({ headers: { host: '127.0.0.1:19387', 'content-type': 'application/json' } })), null)
  assert.equal(foreignRequest(request({ method: 'GET', headers: {} })), null)
})

test('a refused request never reaches the service, so den cannot be made to act', async () => {
  let mounted = null
  let touched = 0
  const service = {
    // `invokeAction('status')` reads the snapshot's own fields, so the fake returns the snapshot
    // itself rather than an envelope — the first version wrapped it and failed on its own fake.
    status() { touched += 1; return { name: 'Den', notices: { total: 0 }, triggers: { total: 0 } } },
    listTriggers: () => ({ valid: [], invalid: [] }),
    dueTriggers: () => [],
    listScenarios: () => [],
    gateAudit: () => [],
    noteEvent: () => {},
    markRouteReached() {},
  }
  const mountedResult = mountPanelRoute(
    { webServer: { register(options) { mounted = options; return () => {} } } },
    { service },
  )
  assert.equal(mountedResult.mounted, true)
  assert.ok(mounted && typeof mounted.handler === 'function', 'the host got a handler')

  const refused = response()
  await mounted.handler(
    request({
      body: JSON.stringify({ action: 'conversation/say', text: 'do something' }),
      headers: { 'sec-fetch-site': 'cross-site', host: '127.0.0.1:19387', 'content-type': 'application/json' },
    }),
    refused,
  )
  assert.equal(refused.seen.status, 403)
  assert.match(String(refused.seen.body), /FOREIGN_REQUEST/)
  assert.equal(touched, 0, 'the action was never invoked')

  const allowed = response()
  await mounted.handler(
    request({
      body: JSON.stringify({ action: 'status' }),
      headers: {
        host: '127.0.0.1:19387',
        origin: 'http://127.0.0.1:19387',
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
    }),
    allowed,
  )
  assert.equal(touched, 1, 'and the panel still works')
  assert.match(String(allowed.seen.body), /Den/)
})
