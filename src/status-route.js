/**
 * The read-only status route that feeds the resident status panel.
 *
 * The panel lives in the browser, the den's state lives in the host process, so
 * the two need a channel. This module is the host end of it: one exact Fetch
 * route on the shared RPC channel, answering with a snapshot of the den's real
 * state. It is deliberately **read-only** — there is no verb here that can change
 * authority, schedules, or memory, so exposing it cannot become a way to talk the
 * approval gate around.
 *
 * ## Why the request envelope is validated by hand
 *
 * The reference implementation imports `clientRequestSchema` from
 * `@deepseek-ai/dsh-client-connection`. This plugin cannot: it is installed as a
 * `link:` with no `node_modules` and no install step, so a bare specifier for a
 * host package fails with MODULE_NOT_FOUND and takes the whole plugin's
 * activation with it. The envelope is four fields, so it is validated here
 * instead of imported. This is the same "zero external imports" rule the rest of
 * the plugin follows, not a shortcut.
 */

import { toLosslessJson } from './atom.js'

/** The RPC envelope: `{ type: 'client-request', rpcId, method, payload }`. */
export function readEnvelope(body) {
  if (!body || typeof body !== 'object') return undefined
  if (body.type !== 'client-request') return undefined
  if (typeof body.rpcId !== 'string' || !body.rpcId) return undefined
  if (typeof body.method !== 'string' || !body.method) return undefined
  return { rpcId: body.rpcId, method: body.method, payload: body.payload }
}

/** Build the response envelope the client's `rpc.call` expects to unwrap. */
export function rpcOk(rpcId, value) {
  return { type: 'server-response', rpcId, result: { ok: true, value } }
}

export function rpcFail(rpcId, code, message) {
  return { type: 'server-response', rpcId, result: { ok: false, error: { code, message } } }
}

/** JSON response helper so a failure is still a well-formed RPC envelope. */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * The panel's data snapshot.
 *
 * Two fields are not simply read off `service.status()`:
 *
 * - `autonomy` needs a live agent, because standing authority is recorded per
 *   conversation. The panel has no agent, so the client may pass a `sessionId`
 *   and the host resolves it. Without one, this reports `null` rather than
 *   guessing — an invented "autonomy: on" would be the single most dangerous
 *   thing this panel could display.
 * - `nextCheckAt` does not exist on the status surface at all (that only carries
 *   counts), so the earliest scheduled instant is computed here.
 */
export function statusSnapshot(service, { sessionId, nextTriggerAt } = {}) {
  const status = service.status()
  const now = Date.now()

  let autonomy = null
  if (sessionId) {
    const agent = service.ctx?.agents?.get?.(sessionId)
    if (agent) autonomy = service.grantFor(agent) ?? null
  }

  let nextCheckAt = null
  for (const trigger of service.listTriggers().valid) {
    if (!trigger.enabled) continue
    const at = nextTriggerAt?.(trigger, trigger.lastFiredAt ?? 0)
    if (at === undefined || at === null) continue
    if (nextCheckAt === null || at < nextCheckAt) nextCheckAt = at
  }

  return {
    generatedAt: now,
    name: status.name,
    home: status.home,
    autonomy,
    autonomyKnown: autonomy !== null,
    nextCheckAt,
    ledger: status.ledger,
    notices: status.notices,
    triggers: status.triggers,
    kernel: status.kernel,
    gate: { mounted: status.gate === 'mounted', recent: service.gateAudit(8) },
    scenarios: service.listScenarios?.() ?? [],
    recentEvents: status.recentEvents,
    reapedTempFiles: status.reapedTempFiles ?? 0,
    /** Present so the panel can explain its own transport failure. */
    route: status.statusRoute ?? null,
  }
}

/**
 * Mount the status route.
 *
 * Returns the mount **outcome** alongside a disposer, rather than a bare no-op on
 * failure. The first version returned `() => {}` when the connection service was
 * unavailable, which made a broken panel indistinguishable from a working one: the
 * panel rendered, polled, and showed an opaque `HTTP 404`, and nothing anywhere
 * recorded that the route had never been registered. A capability is allowed to
 * degrade; its failure is not allowed to be invisible.
 *
 * `statusRoute` is surfaced through both `den_status` and the panel snapshot, so
 * the next time this cannot mount, the reason is readable instead of guessed at.
 *
 * @param {object} ctx injected plugin context
 * @param {object} options
 * @param {object} options.service the `den` service
 * @param {(trigger: object, anchor: number) => number|undefined} options.nextTriggerAt
 * @returns {{ mounted: boolean, reason: string|null, message: string|null, dispose: () => void }}
 */
export function mountStatusRoute(ctx, { service, nextTriggerAt } = {}) {
  const fail = (reason, message) => ({ mounted: false, reason, message: message ?? null, dispose: () => {} })

  let connection
  try {
    connection = ctx.get?.('connection')
  } catch (error) {
    return fail('connection-lookup-threw', String(error?.message ?? error))
  }
  if (!connection) return fail('no-connection-service')
  if (!connection.fetch) return fail('no-connection-fetch')
  const register = connection.fetch.register
  if (typeof register !== 'function') return fail('no-connection-register')

  const METHOD = 'dsh.den/status'
  let dispose
  try {
    dispose = register.call(connection.fetch, {
      path: `/api/${METHOD}`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        if (request.method !== 'POST') return new Response('not found', { status: 404 })
        const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
        if (contentType !== 'application/json') return new Response('content type must be application/json', { status: 415 })

        const message = readEnvelope(await request.json().catch(() => undefined))
        if (!message) return new Response('invalid request envelope', { status: 400 })
        if (message.method !== METHOD) return new Response('not found', { status: 404 })

        try {
          const value = statusSnapshot(service, {
            sessionId: typeof message.payload?.sessionId === 'string' ? message.payload.sessionId : undefined,
            nextTriggerAt,
          })
          return json(toLosslessJson(rpcOk(message.rpcId, value)))
        } catch (error) {
          // A failing panel must never take the host down; report it in-band.
          return json(toLosslessJson(rpcFail(message.rpcId, 'DEN_STATUS_FAILED', String(error?.message ?? error))))
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
    dispose: () => {
      try {
        dispose()
      } catch {
        /* disposal must not mask an earlier failure */
      }
    },
  }
}
