/**
 * The panel's data route, mounted on the Host's web server.
 *
 * Shape and path are copied from the plugins that are provably running in this
 * profile, not invented here:
 *
 *   dsh-vision-diff  inject = ['webServer', 'tools']   route path '/dsh-vision-diff'
 *   dsh-warden       inject = ['webServer']            route path '/dsh-warden'
 *   dsh-daily        inject = ['timer', 'webServer']   route path '/dsh-daily'
 *
 * and on the browser side all three do a plain `fetch(API)` / `fetch(API + '/x')`
 * from the panel, where `API` is that same `'/<package name>'` path.
 *
 * What this replaced: the route used to live on `connection.fetch.register` at an
 * exact `/api/dsh.den/status` path, and the panel reached it through an RPC-shaped
 * shim. The host half of that was observable — `den_status` reported
 * `statusRoute.mounted: true` — but no code in this profile has ever demonstrated
 * that a browser plugin page can reach an exact route under `/api`, and the client
 * half of the channel had already been found to be invented rather than published.
 * Being the only one of nine client plugins to do it a different way is not a
 * neutral choice when the cost is a panel that silently never loads.
 */
import { toLosslessJson } from './atom.js'
import { invokeAction } from './panel-api.js'

/** The route prefix, exposed so the client and the tests cannot drift from it. */
export const ROUTE = '/dsh-den'

/** The single POST action name the panel uses for a status read. */
const DEFAULT_ACTION = 'status'

function json(body, status = 200) {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Split a request path into the segments after the route prefix. */
function segmentsOf(url, route) {
  const path = String(url || '').split('?')[0]
  const rest = path.startsWith(route) ? path.slice(route.length) : path
  return rest.split('/').filter(Boolean)
}

/** Read a JSON body, tolerating an empty one. */
async function readJsonBody(request) {
  try {
    const text = await request.text()
    if (!text.trim()) return {}
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Run one action, turning a thrown error into an in-band refusal. */
async function runAction(service, action, payload, options) {
  // `invokeAction` guards most branches, but `status` is a straight pass-through to
  // `service.status()`. A throwing service must still read as a refusal the panel can
  // render, not as an HTTP 500 the panel cannot distinguish from a dead route.
  try {
    return await invokeAction(service, action, payload, options)
  } catch (error) {
    return { ok: false, error: { code: 'DEN_ACTION_FAILED', message: String(error?.message ?? error) } }
  }
}

/**
 * Mount the panel route.
 *
 * @returns {{mounted: boolean, reason: string|null, message: string|null,
 *   path: string, dispose: () => void}}
 */
export function mountPanelRoute(ctx, { service, nextTriggerAt, route = ROUTE } = {}) {
  const fail = (reason, message) => ({
    mounted: false,
    reason,
    message: message ?? null,
    path: route,
    dispose: () => {},
  })

  if (!ctx || typeof ctx !== 'object') return fail('no-context')

  // `webServer` is declared in `inject`, so it is read as a property. The guard is
  // still here because a profile without a web server must cost the user the panel
  // and not the assistant — `dsh-vision-diff` wraps its registration the same way.
  let webServer
  try {
    webServer = ctx.webServer
  } catch (error) {
    return fail('webserver-lookup-threw', String(error?.message ?? error))
  }
  if (!webServer) return fail('no-webserver-service')
  if (typeof webServer.register !== 'function') return fail('webserver-has-no-register')

  let dispose
  try {
    dispose = webServer.register({
      kind: 'prefix',
      path: route,
      handler: async function (req, res) {
        try {
          const segments = segmentsOf(req?.url, route)
          const method = String(req?.method || '').toUpperCase()

          if (method === 'GET') {
            const outcome = await runAction(service, DEFAULT_ACTION, {}, { sessionId: undefined, nextTriggerAt })
            return send(res, outcome)
          }

          if (method !== 'POST') {
            return sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: `use GET or POST, not ${method}` } })
          }

          const body = await readJsonBody(req)
          if (body === undefined) {
            return sendJson(res, 400, { ok: false, error: { code: 'BAD_JSON', message: 'the request body is not JSON' } })
          }

          const action = typeof body.action === 'string' && body.action ? body.action : segments[0] || DEFAULT_ACTION
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined
          const outcome = await runAction(service, action, body, { sessionId, nextTriggerAt })
          return send(res, outcome)
        } catch (error) {
          // A failing panel must never take the host down; report it in-band.
          return sendJson(res, 500, {
            ok: false,
            error: { code: 'DEN_PANEL_FAILED', message: String(error?.message ?? error) },
          })
        }
      },
    })
  } catch (error) {
    // Registering can throw — a duplicate path, or a route shape the service
    // rejects. The message is the whole point: it is the only way to say why.
    return fail('register-threw', String(error?.message ?? error))
  }

  if (typeof dispose !== 'function') return fail('register-returned-no-disposer')

  return {
    mounted: true,
    reason: null,
    message: null,
    path: route,
    dispose: () => {
      try {
        dispose()
      } catch {
        /* disposal must not throw into apply() */
      }
    },
  }
}

function sendJson(res, status, body) {
  if (res && typeof res.writeHead === 'function') {
    res.writeHead(status, { 'content-type': 'application/json' })
  }
  const text = `${JSON.stringify(toLosslessJson(body))}\n`
  if (res && typeof res.end === 'function') res.end(text)
  return text
}

/**
 * Report one action outcome in the panel's response shape.
 *
 * `invokeAction` returns `error` as a plain string, because that is what the model
 * and the human read. The panel needs a code as well as the words, so it is
 * normalised here rather than in the action layer — one place to keep the two
 * shapes honest.
 */
function send(res, outcome) {
  if (outcome && outcome.ok) return sendJson(res, 200, { ok: true, value: outcome.value })
  const raw = outcome?.error
  const message = typeof raw === 'string' ? raw : String(raw?.message ?? raw ?? 'the action failed')
  const code = typeof raw?.code === 'string' ? raw.code : 'DEN_ACTION_FAILED'
  return sendJson(res, 200, { ok: false, error: { code, message } })
}
