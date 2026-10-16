/**
 * The panel's action surface: the host end of the status panel, minus the transport.
 *
 * Extracted from status-route.js when the transport moved off `connection.fetch` and
 * onto the web server every other client plugin in this profile uses. The actions and
 * the snapshot did not change; only where they are reached from did. Keeping them in
 * one file with no transport in it is what lets the same action set be driven from a
 * test without standing up a route.
 */

import { randomBytes } from 'node:crypto'

import { denPath } from './atom.js'
import { ensureConversation, promptConversation, readStandingConversation, sayInConversation } from './conversation.js'
import { serviceOf } from './grant.js'
// `noticeOwner` is how the console learns which conversation a notice on screen is filed under; the
// record itself is the only authority on that, so the question is asked here rather than re-derived.
import { noticeOwner } from './notices.js'
// The same reader `pickTaskWork` uses for its own fallback: one implementation, so the heartbeat and
// the panel cannot come to different conclusions about which conversation is den's standing one.
import { standingSessionIdFor } from './tasks.js'
import { summarizeFromDisk, TASKS_FILE } from './tasks-store.js'

export const PANEL_ACTIONS = [
  'status',
  'autonomy/request',
  'autonomy/confirm',
  'schedules/list',
  'schedules/create',
  'schedules/delete',
  'notices/ack',
  'conversation/read',
  'conversation/say',
]

/** How long a minted autonomy token stays usable. */
export const AUTONOMY_TOKEN_TTL_MS = 10 * 60 * 1000

/**
 * The panel's task numbers, read from disk and never allowed to throw. A resident assistant must
 * not lose its whole status page because one of its own bookkeeping files is unreadable: an absent
 * or broken file already means "no tasks yet" to the store, and this keeps that same failure
 * direction rather than trading a small problem for a large one.
 */
function taskCounts() {
  try {
    return summarizeFromDisk(denPath(TASKS_FILE))
  } catch {
    return { active: 0, blocked: 0, waiting: 0, total: 0 }
  }
}

export function statusSnapshot(service, { sessionId, nextTriggerAt } = {}) {
  const status = service.status()
  const now = Date.now()

  let autonomy = null
  if (sessionId) {
    const panelAgents = serviceOf(service.ctx, 'agents')
    const agent = typeof panelAgents?.get === 'function' ? panelAgents.get(sessionId) : undefined
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
    // What the heartbeat last saw in the other conversations. Named in the allow-list because a new
    // `status()` field is invisible until it is named — the same trap the fields above document.
    watch: service.watchSummary ? service.watchSummary() : null,
    nextCheckAt,
    ledger: status.ledger,
    /** How many self-initiated turns today, against the cap the host is enforcing. */
    dailyTurnBudget: status.dailyTurnBudget ?? null,
    notices: status.notices,
    triggers: status.triggers,
    /** How much is in progress, stuck, or waiting on the human (DESIGN 7.4). One line, not a view. */
    tasks: taskCounts(),
    kernel: status.kernel,
    /** Non-null while the heartbeat is waiting for a delivery path. */
    kernelDeferred: status.kernelDeferred ?? null,
    /** Who holds residency over this state tree; `held: false` is a standby host, not a broken one. */
    residency: status.residency ?? null,
    gate: { mounted: status.gate === 'mounted', recent: service.gateAudit(8) },
    scenarios: service.listScenarios?.() ?? [],
    recentEvents: status.recentEvents,
    reapedTempFiles: status.reapedTempFiles ?? 0,
    reapedNotices: status.reapedNotices ?? 0,
    /**
     * What the running Host actually offers for waking a conversation, measured.
     *
     * `statusSnapshot` builds this payload field by field on purpose — a panel payload is
     * an allow-list, so a new `status()` field is invisible until it is named here. That
     * is exactly what happened to this one: the field was added, the tests passed, and the
     * route kept reporting a payload without it, which read as "the running Host is a
     * stale build" when the build was current. An allow-list is the right shape; the trap
     * is that adding a field is a two-file change and only one of them fails loudly.
     */
    wakeApi: status.wakeApi ?? null,
    /**
     * The session controller's real contract, measured at runtime.
     *
     * A prompt is assembled with a session-local model — `SessionPromptRequest` is `{ requestId, sessionId,
     * mode, content, clientTimeZone? }` and carries none — so a fix that installs one through
     * `sessionController.selectModel` degrades to a silent no-op on a host whose local service object has no
     * such method. This field is what tells a working fix from a graceful nothing, in the running route
     * rather than in a test's imagination.
     */
    sessionApi: status.sessionApi ?? null,
    /** Which process is answering, so "has this Host loaded my change" is answerable. */
    pid: status.pid ?? null,
    startedAt: status.startedAt ?? null,
    /**
     * Whether this instance loaded the tree beside it.
     *
     * Added here in the same commit that added it to `status()`, because the comment three
     * fields up is the record of what happens otherwise: the field works, the unit tests
     * pass, and the route keeps answering without it. `test/panel-payload-coverage.test.mjs`
     * now fails on that mistake instead of leaving it to be noticed.
     */
    freshness: status.freshness ?? null,
    /**
     * Whether a previous life left state behind, and when that state was first written.
     * Carried through the same allow-list for the same reason as the fields above: the
     * value is only worth anything if the human-facing surface can actually see it.
     */
    stateSurvivesRestart: status.stateSurvivesRestart === true,
    stateCreatedAt: status.stateCreatedAt ?? null,
    /** Present so the panel can explain its own transport failure. */
    route: status.statusRoute ?? null,
    /**
     * The transport, with claimed and observed kept apart.
     *
     * `route.mounted` is the host describing itself: it means the plugin's
     * `webServer.register` call returned a disposer. That is a real fact and it is
     * not the same fact as "a browser reached it" — a previous transport in this
     * plugin reported `mounted: true` while sitting behind the `/api` auth prefix,
     * answering 401 to every poll. Reading those two as one cost two rounds.
     *
     * `browserReachable` therefore stays null until a request actually arrives, and
     * the field exists so nothing downstream has to infer reachability from a mount.
     */
    transport: {
      claimedMounted: Boolean(status.statusRoute?.mounted),
      path: status.statusRoute?.path ?? null,
      /**
       * Epoch ms of the first request that actually reached the route, or null.
       *
       * Set by the route handler on contact, never inferred from the mount. This is
       * the one field that turns "the host says it registered a route" into "a client
       * reached it", which is the distinction that cost two rounds here.
       */
      browserReachable: status.statusRoute?.firstReachedAt ?? null,
      /**
       * The most recent request in full, and how many have arrived.
       *
       * `browserReachable` cannot tell a probe from a panel: both are one timestamp.
       * The panel polls every fifteen seconds, so a count that keeps climbing plus a
       * browser user-agent is the difference between "reachable" and "in use". The
       * header is reported as sent rather than as a verdict, because the verdict is the
       * reader's to reach.
       */
      lastRequest: status.statusRoute?.lastRequest ?? null,
      requestCount: status.statusRoute?.requestCount ?? 0,
      note:
        status.statusRoute?.firstReachedAt != null
          ? 'a request has reached this route'
          : status.statusRoute?.mounted === true
            ? 'the host registered the route; no request has reached it yet'
            : 'the route is not mounted, so the panel has nowhere to send its requests',
    },
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

  // Where the standing conversation is kept. `denPath()` resolves den's home once at import
  // time, so a test that redirected the environment still read the real home; handing the path
  // in is the same point-to-point injection the grants directory already uses.
  const standingPath =
    typeof service.conversationPath === 'string' && service.conversationPath ? service.conversationPath : undefined
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
      const liveAgents = serviceOf(service.ctx, 'agents')
      const agent = liveSessionId && typeof liveAgents?.get === 'function' ? liveAgents.get(liveSessionId) : undefined
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


    case 'conversation/read': {
      // Read only. Opening the window must not create a conversation or charge a turn, so this
      // case never calls `ensureConversation`.
      const limit = Number(input.limit)
      const readOptions = Number.isFinite(limit) && limit > 0 ? { limit } : {}
      if (standingPath) readOptions.path = standingPath
      const read = readStandingConversation(service.ctx, readOptions)
      return { ok: true, value: read }
    }

    case 'conversation/say': {
      const text = String(input.text ?? '')
      if (!text.trim()) return { ok: false, error: 'there is nothing to say' }
      try {
        // A human turn, so it is not charged against the daily budget: that budget rations what
        // den starts on its own. The host picks the working directory, so none is invented here.
        const standing = await ensureConversation(
          service.ctx,
          standingPath ? { path: standingPath, sessionId: liveSessionId || '' } : { sessionId: liveSessionId || '' },
        )
        const admitted = await promptConversation(service.ctx, standing.sessionId, text)
        // Admitted by the host when it can be; queued on the agent when it cannot, and the answer
        // says which, so a window that shows nothing can be told apart from a window that failed.
        const messageId = admitted ? null : sayInConversation(standing.agent, text)
        return { ok: true, value: { messageId, delivery: admitted || 'followup', sessionId: standing.sessionId, state: standing.state } }
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

    case 'notices/ack': {
      // "Acknowledged" means the human says they read it — and it is den's own local bookkeeping: one
      // field written into den's own notices file, nothing sent anywhere, no host model called.
      // Demanding a conversation for that is what turned the panel's button red (measured by the user
      // on the main panel: `acknowledging a notice needs a conversation`, on a click whose entire
      // effect is local).
      //
      // A conversation is still needed to *address* the record, so when the surface asking has none —
      // the main panel and the floating window live outside every conversation — one is resolved,
      // never guessed:
      //
      //  1. den's standing conversation, read from the pointer beside den's task file by the shared
      //     reader `pickTaskWork` already uses (non-throwing; `''` when there is nothing to read);
      //  2. when that conversation does not own this notice, the conversation the notice itself is
      //     filed under, taken from the record.
      //
      // Step 2 is not a nicety. `status.notices.pending` is den's *whole* notice list rather than one
      // conversation's — that is what the console renders — so the card on screen can belong to the
      // conversation that scheduled the check. Measured in den's own home (2026-10-16): the one pending
      // notice was filed under a conversation that is *not* the standing one, so step 1 alone would
      // have answered `no such notice` to the very click this case exists to serve.
      //
      // A conversation that *names itself* is untouched by any of this: it goes through the store's
      // own ownership check and is refused when the notice is not its own. That check is the safety
      // property — one conversation must not silence another conversation's notice — and the fallback
      // below is only ever reached when no conversation claimed the click.
      const noticeId = String(input.id ?? '')
      if (liveSessionId) {
        const own = service.ackNotice(liveSessionId, noticeId)
        if (!own.ok) return { ok: false, error: own.error }
        service.noteEvent({ type: 'notice-acknowledged', noticeId, sessionId: liveSessionId })
        return { ok: true, value: own }
      }
      const standing = standingSessionIdFor(standingPath || denPath(TASKS_FILE))
      if (!standing) {
        // No standing conversation means there is no den for this receipt to be filed against yet. The
        // refusal says what to do about that instead of restating an internal precondition.
        return {
          ok: false,
          error: 'no standing conversation yet: say something to den first, and then this notice can be marked read',
        }
      }
      const candidates = [...new Set([standing, noticeOwner(noticeId)].filter(Boolean))]
      let acknowledged = { ok: false, error: 'no such notice' }
      let sessionIdForNotice = standing
      for (const candidate of candidates) {
        // A refusal here writes nothing (see `notices.js`), so trying the next candidate cannot leave
        // a half-applied receipt behind.
        const attempt = service.ackNotice(candidate, noticeId)
        acknowledged = attempt
        if (attempt.ok) {
          sessionIdForNotice = candidate
          break
        }
      }
      if (!acknowledged.ok) return { ok: false, error: acknowledged.error }
      service.noteEvent({ type: 'notice-acknowledged', noticeId, sessionId: sessionIdForNotice })
      return { ok: true, value: acknowledged }
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
