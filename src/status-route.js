/**
 * The status route that feeds the resident status panel.
 *
 * The panel lives in the browser, the den's state lives in the host process, so
 * the two need a channel. This module is the host end of it: one exact Fetch route
 * on the shared RPC channel, dispatching a small set of named actions.
 *
 * ## What the panel is allowed to do, and why the split is where it is
 *
 * A view you cannot act from is a diagnostic, not a control surface, so this route
 * does carry verbs. But authority is the one thing it must not be able to change
 * on a click, and the reason is not squeamishness — it is a correctness bug that
 * would otherwise be invisible:
 *
 *   Standing autonomy is only honoured when the four mechanical gates run, and the
 *   authority gate reads a grant bound to a **human message id**. A grant written
 *   without one makes `den_status` report "granted" while every self-initiated run
 *   is still refused for lack of authority. The panel would show a green light over
 *   a dead circuit.
 *
 * So `autonomy/request` never grants. It mints a short-lived single-use token and
 * reports it; the human then carries that token to the assistant in the
 * conversation, and the normal `den_set_autonomy` path does the write with real
 * human-message evidence behind it. `/autonomy/confirm` is deliberately the only
 * verb here that changes authority, and it can only do it with a token this module
 * issued and has not yet spent.
 *
 * Schedules are a different risk class and are handled directly, because a
 * schedule is explicitly not a permission grant: every run still re-checks
 * authority, budget, quiet hours and pacing, and outbound actions still stop at
 * the approval gate.
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

import { randomBytes } from 'node:crypto'

import { toLosslessJson } from './atom.js'

/** Actions the panel may invoke. Anything else is refused, not ignored. */
export const PANEL_ACTIONS = [
  'status',
  'autonomy/request',
  'autonomy/confirm',
  'schedules/list',
  'schedules/create',
  'schedules/delete',
]

/** How long a minted autonomy token stays usable. */
export const AUTONOMY_TOKEN_TTL_MS = 10 * 60 * 1000

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
    /** Non-null while the heartbeat is waiting for a delivery path. */
    kernelDeferred: status.kernelDeferred ?? null,
    gate: { mounted: status.gate === 'mounted', recent: service.gateAudit(8) },
    scenarios: service.listScenarios?.() ?? [],
    recentEvents: status.recentEvents,
    reapedTempFiles: status.reapedTempFiles ?? 0,
    /** Present so the panel can explain its own transport failure. */
    route: status.statusRoute ?? null,
  }
}

/* ------------------------------------------------------------------- actions */

/** A stable, non-guessable token. Never derived from time or state. */
function mintToken() {
  return randomBytes(16).toString('hex')
}

/**
 * Carry out one panel action.
 *
 * Every branch returns a plain object rather than throwing: a panel action that
 * fails is information for the human, and an exception here would reach the panel
 * as an opaque transport error instead of a reason.
 *
 * `deferred` accumulates changes the panel made that the model has not yet been
 * told about. Handing them back is the point — otherwise a schedule created in the
 * panel is invisible to the assistant that is supposed to act on it.
 */
export async function invokeAction(service, action, payload = {}, { sessionId, nextTriggerAt } = {}) {
  const input = payload && typeof payload === 'object' ? payload : {}
  const liveSessionId = typeof input.sessionId === 'string' && input.sessionId ? input.sessionId : sessionId

  switch (action) {
    case 'status':
      return { ok: true, value: statusSnapshot(service, { sessionId: liveSessionId, nextTriggerAt }) }

    case 'autonomy/request': {
      // Mint, never grant. See the module comment: a grant without a human message
      // id behind it reads as "granted" and behaves as "not granted".
      const token = mintToken()
      service.panelAutonomyRequest = {
        token,
        requested: input.autonomy === true,
        sessionId: liveSessionId ?? null,
        at: Date.now(),
        expiresAt: Date.now() + AUTONOMY_TOKEN_TTL_MS,
      }
      service.noteEvent({ type: 'panel-autonomy-requested', autonomy: input.autonomy === true, sessionId: liveSessionId })
      return {
        ok: true,
        value: {
          token,
          autonomy: input.autonomy === true,
          expiresAt: service.panelAutonomyRequest.expiresAt,
          ttlMs: AUTONOMY_TOKEN_TTL_MS,
          // The exact instruction the human can paste. Written here, not in the
          // panel, so the wording that carries authority is reviewable in one place.
          instruction:
            `请调用 den_set_autonomy，autonomy=${input.autonomy === true}，` +
            `humanMessageId 用这条消息的 id，并在请求里引用令牌 ${token}。`,
        },
      }
    }

    case 'autonomy/confirm': {
      const request = service.panelAutonomyRequest
      const token = String(input.token ?? '')
      if (!request || request.token !== token) {
        return { ok: false, error: 'no matching autonomy request: the token is wrong or was already spent' }
      }
      if (Date.now() > request.expiresAt) {
        service.panelAutonomyRequest = null
        service.noteEvent({ type: 'panel-autonomy-expired' })
        return { ok: false, error: 'the autonomy token expired; request a new one' }
      }
      const agent = liveSessionId ? service.ctx?.agents?.get?.(liveSessionId) : undefined
      if (!agent) {
        return { ok: false, error: 'no live conversation for this token: autonomy is granted per conversation' }
      }
      try {
        const record = service.setGrant(agent, request.requested, String(input.humanMessageId ?? ''))
        service.panelAutonomyRequest = null
        service.noteEvent({ type: 'panel-autonomy-confirmed', autonomy: record.autonomy })
        return { ok: true, value: { autonomy: record.autonomy, boundToMessage: record.humanMessageId } }
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) }
      }
    }

    case 'schedules/list': {
      const { valid, invalid } = service.listTriggers()
      const dueIds = new Set(service.dueTriggers().map((item) => item.trigger.id))
      const filtered = liveSessionId ? valid.filter((item) => item.sessionId === liveSessionId) : valid
      return {
        ok: true,
        value: {
          schedules: filtered.map((item) => ({
            id: item.id,
            kind: item.kind,
            title: item.title,
            enabled: item.enabled,
            fireCount: item.fireCount,
            dueNow: dueIds.has(item.id),
          })),
          invalidCount: invalid.length,
        },
      }
    }

    case 'schedules/create': {
      if (!liveSessionId) return { ok: false, error: 'a schedule must belong to a conversation' }
      try {
        const trigger = service.createTrigger({
          kind: input.kind,
          title: input.title,
          prompt: input.prompt,
          sessionId: liveSessionId,
          everySeconds: input.everySeconds,
          at: input.at,
          atTime: input.atTime,
          weekday: input.weekday,
          maxRuns: input.maxRuns,
        })
        service.noteEvent({ type: 'panel-schedule-created', id: trigger.id, title: trigger.title })
        // A schedule is not a permission grant. Say so where the human will read it.
        return {
          ok: true,
          value: { id: trigger.id, kind: trigger.kind, title: trigger.title },
          note: 'Created. This is not a permission grant: each run still re-checks autonomy, quiet hours and budget.',
        }
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) }
      }
    }

    case 'schedules/delete': {
      try {
        const removed = service.removeTrigger(String(input.id ?? ''))
        if (removed) service.noteEvent({ type: 'panel-schedule-deleted', id: String(input.id) })
        return { ok: true, value: { removed } }
      } catch (error) {
        // Every other branch reports failure in-band; this one must too, or a
        // service that cannot delete reaches the panel as an opaque transport
        // error instead of a reason.
        return { ok: false, error: String(error?.message ?? error) }
      }
    }

    default:
      // Refuse an unknown action loudly. Silently ignoring it would make a broken
      // panel look like a panel whose buttons do nothing for no reason.
      return { ok: false, error: `unknown action ${JSON.stringify(action)}; known actions: ${PANEL_ACTIONS.join(', ')}` }
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

        const action = typeof message.payload?.action === 'string' ? message.payload.action : 'status'
        const sessionId = typeof message.payload?.sessionId === 'string' ? message.payload.sessionId : undefined

        try {
          const outcome = await invokeAction(service, action, message.payload, { sessionId, nextTriggerAt })
          if (outcome.ok) return json(toLosslessJson(rpcOk(message.rpcId, outcome.value)))
          return json(toLosslessJson(rpcFail(message.rpcId, 'DEN_ACTION_FAILED', outcome.error)))
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
