/**
 * dsh-den — a 7x24 resident personal assistant for DeepSeek Harness.
 *
 * This module is the plugin entry point: it wires durable state, human-bound
 * authorization, expiry-aware notices, the outbound approval gate, and the
 * autonomy kernel onto the Host.
 *
 * Deliberate choices visible here:
 *
 * - **Zero external imports.** The Host supplies framework symbols at the plugin
 *   boundary rather than through Node resolution: `@deepseek-ai/cordis` is not
 *   resolvable from a profile's own `node_modules`, so a plugin that imports it
 *   fails to load. Only the Host-provided `ctx` is used.
 * - **Services are declared, not probed.** Cordis throws
 *   `cannot get property "<key>" without inject` when a plugin reads a service it
 *   never declared, and `apply` does not run at all as a result. So `inject` lists
 *   what this plugin genuinely requires, and the code reads the injected
 *   properties instead of reaching for `ctx.get`.
 * - **`agents`, `tools`, and `webServer` are hard dependencies; `subagents` is
 *   not — and is no longer read at all.** Without the agent registry there is nothing
 *   to authorize *and* nothing to deliver through, because a wake is queued with
 *   `Agent.followup`; without the tool registry the approval gate cannot be installed;
 *   without a web server the status panel has no data route. `webServer` is what the
 *   other client plugins in this profile declare for exactly this purpose —
 *   dsh-vision-diff as `['webServer', 'tools']`, dsh-warden as `['webServer']`,
 *   dsh-daily as `['timer', 'webServer']` — and the panel is mounted on a route there
 *   than on an exact path under `/api`, which no plugin here demonstrates a
 *   browser can reach. The delivery path is genuinely optional, so the kernel
 *   defers when it is absent.
 * - The approval gate is installed **before** anything the model controls, and it
 *   is installed through `ctx.tools.guard`, which the Host documents as
 *   monotonic: no later listener can turn its denial back into permission.
 * - The service reports the *filesystem truth* (what is actually on disk) rather
 *   than in-memory intentions, so a status query can never claim work that did
 *   not survive.
 */

import { join } from 'node:path'

import { denHome, listJsonFiles, reapStaleTempFiles, readJson, toLosslessJson, writeJsonAtomic } from './atom.js'
import { currentGrant, recordGrant, sessionEvents } from './grant.js'
import { allNotices, isExpired, pendingNotices, queueNotice } from './notices.js'
import { installGate, RISK, classifyCall, recordAudit, auditPath } from './gate.js'
import { DenKernel, evaluateGates, readLedger, ledgerPath } from './kernel.js'
import { deleteTrigger, dueTriggers, listTriggers, nextTriggerAt, normalizeTrigger, saveTrigger } from './triggers.js'
import { ENTRY_KINDS, forget, recall, remember, scenarios } from './memory.js'
import { mountPanelRoute } from './panel-route.js'

export const name = 'dsh-den'
export const inject = ['agents', 'tools', 'webServer']

const STATE_VERSION = 1

/**
 * How far back to read the audit file before appending one entry.
 *
 * `recordAudit` rewrites the file from the entries it is handed and trims to its own
 * `MAX_AUDIT`, so this only has to be larger than that cap — the point is to append to the
 * existing trail rather than replace it with a single line.
 */
const AUDIT_READ_LIMIT = 5000

/** Mutable assistant state that must survive a restart. */
function defaultState() {
  return {
    version: STATE_VERSION,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    /** Set by the human through the model tool; never inferred automatically. */
    displayName: 'Den',
    /** Quiet hours in local time, as minutes since midnight, or null to disable. */
    quietHours: null,
    /** Daily budget for self-initiated turns. Zero disables proactivity entirely. */
    dailyTurnBudget: 24,
    /** Seconds of silence required after the human speaks before the den may speak. */
    cooldownSeconds: 900,
    /** Heartbeat cadence in seconds. */
    tickSeconds: 60,
  }
}

function isValidState(value) {
  return (
    !!value &&
    value.version === STATE_VERSION &&
    typeof value.displayName === 'string' &&
    Number.isSafeInteger(value.dailyTurnBudget) &&
    value.dailyTurnBudget >= 0 &&
    Number.isSafeInteger(value.cooldownSeconds) &&
    value.cooldownSeconds >= 0
  )
}

/**
 * The resident assistant's host-side surface.
 *
 * A plain class, not a framework `Service` subclass: importing the framework is
 * impossible from a profile (see the zero-external-imports note above), and
 * nothing here needs framework behaviour beyond holding `ctx`. The Host still sees
 * a service because `apply` registers it with `ctx.provide`.
 */
export class DenService {
  constructor(ctx) {
    this.ctx = ctx
    this.root = denHome()
    this.statePath = `${this.root}/state.json`
    this.kernel = null
    this.gateDisposer = null
    /** Set by apply() to the panel route's mount result, so a failure is reportable. */
    this.statusRoute = null
    /** Non-null while the heartbeat could not start; cleared once it does. */
    this.kernelDeferred = null
    /**
     * Set by apply() to a closure that measures the live wake-delivery surface. Null
     * outside a running plugin, which `status()` reports as "not wired" rather than as a
     * failing check — a service object with no Host behind it has nothing to measure.
     */
    this.probeWakeApi = null
    this.recentEvents = []
    // A hard kill between open and rename leaves temp litter behind — measured at
    // 39 of 40 kills. A resident assistant restarts often enough that this would
    // accumulate, so sweep once at boot. Only the den's own tree is touched, and
    // the grace period keeps a concurrent writer's in-flight file safe.
    this.reapedTempFiles = reapStaleTempFiles(this.root) + reapStaleTempFiles(join(this.root, 'memory'))
    /**
     * When this instance was constructed, which is when this process last loaded the
     * plugin. Distinct from the Host's own start time and from any file's mtime, and the
     * only one of the three that answers "is the code I just edited actually running".
     */
    this.startedAt = new Date().toISOString()

    // Measured *before* the boot claims the tree, because that ordering is the whole
    // question. `stateSurvivesRestart` used to be computed inside `status()` as
    // `readJson(statePath) !== undefined`, which is evaluated after the write below and is
    // therefore `true` on the very first boot of a machine that has never been restarted.
    // A field named for a past event, answered by a present-tense read, is not a
    // measurement — it is a constant that happens to look like one, and it was cited as
    // evidence in `check-acceptance.mjs` with the name supplying the conclusion.
    //
    // Capturing it here answers the question the name asks: was there already state on
    // disk from a previous life?
    const priorState = readJson(this.statePath)
    this.priorStateExisted = priorState !== undefined
    this.priorStateCreatedAt = priorState?.createdAt ?? null

    /**
     * Claim the tree on disk at boot, so the assistant's existence is durable from
     * the first moment rather than from the first schedule.
     *
     * The earlier behaviour was to write nothing until something was configured, so
     * a freshly started den left no `state.json` at all: `den_status` reported
     * `stateSurvivesRestart: false`, `$DSH_HOME/den` did not exist, and the
     * configuration the user sees in the panel was indistinguishable from a
     * default that had never been stored. A resident assistant that cannot say
     * whether it has ever run is not reporting its state honestly.
     *
     * Idempotent by construction: `saveState({})` merges over whatever is already
     * there, so an existing configuration is preserved rather than reset. A failure
     * is recorded, not thrown — a read-only home must not stop the assistant from
     * loading, it must just be visible.
     */
    try {
      this.saveState({})
    } catch (error) {
      this.noteEvent({ type: 'state-init-failed', message: String(error?.message ?? error) })
    }
  }

  /** Read persisted state, falling back to defaults when absent or invalid. */
  state() {
    const stored = readJson(this.statePath)
    if (isValidState(stored)) return stored
    return defaultState()
  }

  /** Persist state through the atomic writer. */
  saveState(patch) {
    const next = { ...this.state(), ...patch, version: STATE_VERSION, updatedAt: Date.now() }
    writeJsonAtomic(this.statePath, next)
    return next
  }

  /** Storage location, so a human can pack the whole state and move it. */
  home() {
    return this.root
  }

  /** Append to a bounded in-memory event ring for the status surface. */
  noteEvent(event) {
    this.recentEvents = [...this.recentEvents, { ...event, at: Date.now() }].slice(-50)
  }

  // ------------------------------------------------------------- authority

  /** Authority for one live agent, verified against the immutable session log. */
  grantFor(agent) {
    return currentGrant(agent)
  }

  /** Record a grant/revocation from a direct human request. Throws otherwise. */
  setGrant(agent, autonomy, humanMessageId) {
    return recordGrant(this.ctx, agent, autonomy, humanMessageId)
  }

  // --------------------------------------------------------------- notices

  noticesFor(sessionId) {
    return pendingNotices(sessionId)
  }

  enqueueNotice(sessionId, text, kind = 'notice') {
    return queueNotice(sessionId, text, kind)
  }

  // -------------------------------------------------------------- triggers

  createTrigger(input) {
    const trigger = normalizeTrigger(input)
    return saveTrigger(trigger)
  }

  listTriggers() {
    return listTriggers()
  }

  removeTrigger(id) {
    return deleteTrigger(id)
  }

  dueTriggers(now = Date.now()) {
    return dueTriggers(now)
  }

  // ------------------------------------------------------------------ gate

  /**
   * Classify a hypothetical call. Exposed so a human (or a test) can ask "what
   * would you do with this?" without executing anything.
   */
  classify(name, args) {
    return classifyCall({ name, arguments: args })
  }

  gateAudit(limit = 50) {
    // `auditPath()` rather than a locally joined string: the reader and the writer must
    // resolve to the same file, and the bug this replaced was exactly a reader and a writer
    // that disagreed about storage while both looked correct in isolation.
    const stored = readJson(auditPath())
    const entries = Array.isArray(stored?.entries) ? stored.entries : []
    return entries.slice(-limit)
  }

  // ---------------------------------------------------------------- memory

  /**
   * Which memory scenarios exist, with entry counts.
   *
   * Read-only and surfaced through the status panel deliberately: the isolation
   * domain is a promise made to the human, so they should be able to see which
   * domains exist without asking the model to recall one.
   */
  listScenarios() {
    try {
      return scenarios()
    } catch {
      return []
    }
  }

  // ---------------------------------------------------------------- status

  /**
   * A filesystem-level summary. Counts come from disk, never from memory, so this
   * cannot overstate what survived a restart.
   */
  status(agent) {
    const state = this.state()
    const notices = allNotices()
    const now = Date.now()
    const triggers = listTriggers()
    const ledger = readLedger()
    return {
      name: state.displayName,
      home: this.root,
      stateFile: this.statePath,
      // True only when a previous life left state behind, captured before this boot wrote
      // anything. On a first-ever boot it is `false`, which is the honest answer: nothing
      // survived, because nothing preceded it.
      stateSurvivesRestart: this.priorStateExisted,
      // When the stored configuration was first written. Together with `startedAt` this is
      // what makes the line above checkable by a reader instead of trusted.
      stateCreatedAt: state.createdAt ?? null,
      quietHours: state.quietHours,
      dailyTurnBudget: state.dailyTurnBudget,
      cooldownSeconds: state.cooldownSeconds,
      tickSeconds: state.tickSeconds,
      grants: listJsonFiles(`${this.root}/grants`).length,
      // `null`, never `undefined`: a tool's return value has to survive a lossless
      // JSON round trip, and JSON.stringify DROPS a key whose value is undefined.
      // That silently changes the object's shape, which the Host rejects outright —
      // measured, `den_status` failed with "value is not lossless JSON" and the key
      // count went 18 -> 17. A key that is present-and-null is honest; a key that
      // vanishes is a shape change.
      autonomy: agent ? (this.grantFor(agent) ?? null) : null,
      sessionEvents: agent ? sessionEvents(agent.session).length : 0,
      triggers: { total: triggers.valid.length, invalid: triggers.invalid.length, due: dueTriggers(now).length },
      ledger: { path: ledgerPath(), ...ledger },
      notices: {
        total: notices.length,
        deliverable: notices.filter((notice) => !isExpired(notice, now)).length,
        expired: notices.filter((notice) => isExpired(notice, now)).length,
      },
      kernel: this.kernel ? { running: this.kernel.timer !== null, lastTickAt: this.kernel.lastTickAt, lastError: this.kernel.lastError } : null,
      gate: this.gateDisposer ? 'mounted' : 'not-mounted',
      /** Temp litter reclaimed at boot; non-zero means the process was hard-killed. */
      reapedTempFiles: this.reapedTempFiles,
      /**
       * Whether the browser panel's data route actually mounted.
       *
       * This exists because the first version of that mount failed *silently*: it
       * returned a no-op when the connection service was unavailable, so the panel
       * kept rendering and polling and reported only an opaque "HTTP 404", while
       * nothing anywhere recorded that the route was never registered. A capability
       * may degrade; its failure must not be invisible.
       */
      statusRoute: this.statusRoute ?? null,
      /**
       * Why the heartbeat has not started, and whether it is still trying.
       *
       * A deferred heartbeat used to leave one event and nothing else, so the
       * resident half of a resident assistant could be absent while the status
       * looked healthy. This field makes the waiting state itself observable.
       */
      kernelDeferred: this.kernelDeferred ?? null,
      /**
       * Which process is answering, so "has this host loaded my change yet" is answerable.
       *
       * A Host that has not reloaded a changed plugin file and a Host that is genuinely
       * broken look identical from a route response. Without this, the only way to tell was
       * to guess, and guessing produced the wrong report once already — the panel said
       * "absent, so this must be a stale build" while the build was current and the payload
       * allow-list was the real cause. `startedAt` is when this plugin instance was
       * applied, so a restart changes it and a reload of nothing does not.
       */
      pid: typeof process !== 'undefined' && Number.isFinite(process.pid) ? process.pid : null,
      startedAt: this.startedAt,
      /**
       * Whether the wake delivery surface actually exists on this Host, measured rather
       * than assumed.
       *
       * This field exists because the delivery path was broken by an assumption, and the
       * assumption was about an API: `subagents.sendMessage` was read as a general
       * "send a message to a conversation" and is in fact a restricted parent/child
       * channel, so every admitted wake failed. Anything this plugin needs from the Host
       * should be something the Host can be asked about at runtime.
       *
       * It matters here more than usual, because the surfaced service contract is
       * **narrower than the runtime object**: `agents.get`/`resume` are declared to return
       * `Agent`, and `Agent` is declared as `{ readonly id }`. `followup` is not in any
       * service signature — it is a method on the live agent the factory builds. So the
       * contract cannot be checked statically; the only honest check is at runtime.
       */
      wakeApi: this.probeWakeApi ? this.probeWakeApi() : { checked: false, reason: 'not wired' },
      recentEvents: this.recentEvents.slice(-10),
    }
  }
}

/**
 * Build the `deliver` function the kernel calls for one due trigger.
 *
 * Cold wake uses the Host's own documented resume path: a persisted session is
 * resumed so its full history is in context, then the wake instruction is
 * delivered as a message. Two facts drive this design:
 *
 *  - In-process jobs do not survive a restart, so the session log — not memory —
 *    is the source of truth for what was already done.
 *  - A wake must not impersonate a human. The instruction states plainly that the
 *    turn came from the den's own heartbeat, which is also what keeps the
 *    authority check in `grant.js` honest: a wake is never a human request.
 *
 * @returns {Promise<string>} the assistant's text for this wake
 */
/**
 * Find or cold-resume the driver for a conversation.
 *
 * The heartbeat runs on a timer with no caller, so it has no agent to hand the gates.
 * Authority in this plugin is attested against the immutable session log rather than
 * stored as a flag, so "no agent" does not mean "no authority" — it means the question
 * could not be asked. This resolver answers it, and returns the disposer alongside the
 * agent so the caller can release a resumed driver when the wake is over.
 *
 * Returning `null` is a normal outcome, not an error: a conversation whose session file
 * is gone has nothing left to attest the grant, and the authority gate will then refuse
 * for the right reason.
 */
export function createAgentResolver(ctx) {
  return async (sessionId) => {
    if (!sessionId) return null
    const agents = ctx.get?.('agents')
    // `subagents` used to be required here, because delivery went through
    // `subagents.sendMessage`. It does not any more — see `createDeliver` — and requiring a
    // service the delivery path no longer uses would refuse to resolve a driver for a host
    // that has no subagent manager at all, which is a limitation this plugin does not
    // actually have.
    if (typeof agents?.get !== 'function') return null

    // Prefer the driver that is already live for this conversation, so a wake lands in
    // the session the human is watching rather than a second copy of it.
    const live = agents.get(sessionId)
    if (live) return { agent: live, dispose: null }

    if (!agents?.resume) return null
    const handle = await agents.resume({ resumeSessionId: sessionId })
    return { agent: handle.agent, dispose: handle.dispose ? () => handle.dispose() : null }
  }
}

/**
 * How long a wake's reply is waited for before giving up on reading it.
 *
 * The default matches the delivery timeout, so a wake that never answers is reported as
 * unreadable rather than mistaken for a deliberate silence. A test may shorten it via
 * `DSH_DEN_WAKE_REPLY_TIMEOUT_MS` so the unreadable path is exercised in seconds rather
 * than minutes — the behaviour under test is what happens on timeout, and waiting the
 * real two minutes to observe it proves nothing extra.
 */
function wakeReplyTimeoutMs() {
  const override = Number(process.env.DSH_DEN_WAKE_REPLY_TIMEOUT_MS)
  return Number.isFinite(override) && override > 0 ? override : 120_000
}

/** Gap between polls for the wake's reply. */
const WAKE_REPLY_POLL_MS = 250

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * Extract the visible text of an `assistant/message` event.
 *
 * The message body is a content-block array, most of which is not speech: reasoning
 * and tool calls must not be delivered to a human as if the den had said them out
 * loud. Only `text` blocks are joined, and the shape is checked field by field because
 * this reads a structure the plugin does not own.
 */
function textOfAssistantEvent(event) {
  const content = event?.data?.message?.content
  if (!Array.isArray(content)) return null
  const parts = content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
  if (parts.length === 0) return null
  return parts.join('\n').trim()
}

/**
 * Wait for the reply the wake turn produces, and return it.
 *
 * Polling is not the shape anyone wants here. It is used because the honest
 * alternative does not exist in this devkit: `Agent.followup` is synchronous and returns
 * `void` — it splices into the inbox and wakes the driver — and there is no completion
 * handle for a turn queued on an *existing* session. `startContinuable` does return a
 * result promise, but that establishes a new child rather than waking the human's own
 * conversation.
 *
 * The read is cheap and safe: `snapshotEvents()` on a live session, filtered to events
 * after `baselineSeq`. The timeout is the turn timeout, so a wake that never answers
 * is reported as unreadable rather than mistaken for a deliberate silence.
 *
 * @returns the reply text, or `null` when none could be read in time.
 */
async function awaitWakeReply(sessions, sessionId, baselineSeq, timeoutMs = wakeReplyTimeoutMs()) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    // Prefer the live session; fall back to the agent's own transcript when the store
    // has already released it.
    const session = sessions?.get?.(sessionId)
    const events = session ? sessionEvents(session) : []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (Number(event?.seq) <= baselineSeq) break
      if (event?.type !== 'assistant/message') continue
      const text = textOfAssistantEvent(event)
      if (text) return text
    }
    if (Date.now() >= deadline) return null
    await delay(WAKE_REPLY_POLL_MS)
  }
}

export function createDeliver(ctx, service) {
  return async ({ trigger, instruction, agent }) => {
    // The kernel resolves (and releases) the driver, because it needs one *before* the
    // authority gate can be evaluated. Delivering to that same driver keeps one
    // resolution per wake instead of two that could disagree.
    if (!agent || typeof agent.followup !== 'function') {
      service.noteEvent({ type: 'wake-unavailable', triggerId: trigger.id })
      // Throwing, not returning empty.
      //
      // The kernel reads an empty reply as "nothing worth saying" — a *successful* wake
      // that chose silence. That is the wrong report for a wake that never reached
      // anyone: it would charge the turn, advance the cadence, and quietly consume a
      // check-in the human asked for. Throwing routes it to the kernel's failure path,
      // which charges only the retry throttle and leaves the schedule due, so it runs
      // when a delivery path exists again. Never claim work that did not happen.
      throw new Error('dsh-den: no delivery path for this wake')
    }

    const text = `${instruction}\n\n## Scheduled check\n${trigger.title}\n${trigger.prompt}`

    /**
     * Read the wake turn's own reply, which is what the "is this worth saying?"
     * decision is made on.
     *
     * `subagents.sendMessage` returns the accepted message's **inbox id**, never the
     * assistant's reply — its signature is `Promise<MessageId>`. So a delivery path
     * that only sends can never answer the kernel's question, and this one did not:
     * it returned a constant empty string, every wake was classified
     * `{speak:false, reason:'empty'}`, and **no notice was ever queued**. The gates,
     * the ledger, the triggers and the panel all looked healthy throughout, because
     * "nothing worth saying" is a normal, expected verdict.
     *
     * The reply is therefore read back from the session log, where it durably lands as
     * an `assistant/message` event. The sequence is captured first so the wake's own
     * reply is distinguishable from everything the human said earlier.
     */
    const sessions = ctx.get?.('sessions')
    const before = sessionEvents(agent.session)
    const baselineSeq = before.length ? Number(before[before.length - 1].seq) || 0 : 0

    /**
     * Deliver into the conversation through the agent's own inbox.
     *
     * This used to be `subagents.sendMessage(agent, trigger.sessionId, …)`, and that could
     * never work. The host admits a send only when the sender is the target's **direct
     * parent or direct continuable child** — `authorizeLineage` ends in
     * `if (parentSession !== parent.id) throw UNAUTHORIZED`, which insists the addressed
     * session is a child of the sender. Here the sender *is* the target conversation's
     * driver, so the call asked a session to be its own parent and every admitted wake died
     * with "delivery requires the exact live parent agent". Five tests covered this path and
     * were green purely because the fake accepted any delivery at all.
     *
     * `Agent.followup(message)` is the mechanism the host documents for exactly this:
     *
     *   "`followup()` queues an ordinary next-turn prompt and wakes the driver"
     *
     * It is `send(message, 'next-turn', true)`: splice the message into the inbox, then open
     * a turn boundary if the agent is idle, or latch the wake if a turn is already running.
     * No lineage is involved, the message is visibly a queued turn in the human's chat, and
     * it durably becomes a `user/message` in the transcript — which is what the reply
     * read-back below then pairs with the assistant's answer.
     *
     * The id is derived from the trigger and the moment so that a redelivery after a crash
     * is a distinct message rather than a duplicate the inbox projection would reject.
     */
    if (typeof agent.followup !== 'function') {
      throw new Error('dsh-den: the resolved agent cannot accept a followup message')
    }
    agent.followup({
      id: `den-wake-${trigger.id}-${baselineSeq}`,
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text }],
    })

    const reply = await awaitWakeReply(sessions, trigger.sessionId, baselineSeq)
    if (reply === null) {
      // The wake ran but its reply could not be read. Recording it as "nothing to
      // say" would be a lie in the direction that hides breakage, so say what
      // happened: the check-in is spent, and the reason is visible in the events.
      service.noteEvent({
        type: 'wake-reply-unreadable',
        triggerId: trigger.id,
        sessionId: trigger.sessionId,
      })
      return ''
    }
    return reply
  }
}

/**
 * Register the model-facing tools.
 *
 * Every tool is registered through the Host registry with an explicit JSON
 * Schema, so the model sees exactly these capabilities and nothing implicit.
 * Each handler returns plain JSON and never throws for an expected condition;
 * a thrown error becomes an opaque tool failure, while a returned `{ok:false}`
 * tells the model what actually went wrong.
 *
 * @param {object} tools the tool registry (`ctx.get('tools')`), passed explicitly
 *   for the same reason as in `installGate`: Cordis's injected `ctx.tools`
 *   property and a lazily resolved `ctx.get('tools')` must not be assumed equal.
 * @param {DenService} service
 */
export function registerTools(tools, service) {
  const disposers = []
  const register = (definition) => {
    // Every tool's return value crosses this boundary normalised to lossless JSON.
    //
    // One forgotten `undefined` field made an entire tool unreachable:
    // `den_status` failed with "value is not lossless JSON" on every call because
    // JSON.stringify silently drops keys whose value is undefined. This is the
    // boundary that guarantees a return value cannot be rejected for its shape,
    // whatever any individual handler does.
    const execute = definition.execute
    disposers.push(
      tools.register({
        ...definition,
        async execute(...callArgs) {
          return toLosslessJson(await execute.apply(definition, callArgs))
        },
      }),
    )
  }

  const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

  register({
    name: 'den_status',
    description:
      'Report the resident assistant\'s real state: storage location, standing autonomy, schedules, the daily ledger, pending notices, heartbeat health, and the approval gate. Counts come from disk, so this reflects what survived a restart.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => text(value) },
    async execute() {
      return service.status()
    },
  })

  register({
    name: 'den_schedule_check',
    description:
      'Create a recurring or one-off check that the den performs on its own, without the human present. The check is a prompt the den will run when due. Creating a schedule is NOT a permission grant: every self-initiated run still re-checks standing autonomy, quiet hours, and the daily budget, and outbound actions still stop at the approval gate.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['once', 'interval', 'daily', 'weekly'], description: 'Schedule shape.' },
        title: { type: 'string', description: 'Short human-readable name.' },
        prompt: { type: 'string', description: 'What to check when this fires.' },
        sessionId: { type: 'string', description: 'The conversation this check belongs to.' },
        everySeconds: { type: 'integer', description: 'For interval: seconds between runs, minimum 300.' },
        at: { type: 'integer', description: 'For once: epoch milliseconds when it should fire.' },
        atTime: { type: 'string', description: 'For daily/weekly: local HH:MM.' },
        weekday: { type: 'integer', description: 'For weekly: 1..7, Monday = 1.' },
        maxRuns: { type: 'integer', description: 'Optional cap, 1..1000.' },
      },
      required: ['kind', 'title', 'prompt', 'sessionId'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const trigger = service.createTrigger(args)
        return { ok: true, id: trigger.id, kind: trigger.kind, title: trigger.title, enabled: trigger.enabled }
      } catch (error) {
        // An invalid schedule is a user error, not a tool crash: return the reason.
        return { ok: false, error: String(error?.message ?? error) }
      }
    },
  })

  register({
    name: 'den_schedule_list',
    description: 'List the den\'s schedules and which are currently due, including any stored schedule that failed validation.',
    parameters: {
      type: 'object',
      properties: { sessionId: { type: 'string', description: 'Optional: only this conversation\'s schedules.' } },
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => text(value) },
    async execute(args) {
      const { valid, invalid } = service.listTriggers()
      const dueIds = new Set(service.dueTriggers().map((item) => item.trigger.id))
      const filtered = args?.sessionId ? valid.filter((item) => item.sessionId === args.sessionId) : valid
      return {
        schedules: filtered.map((item) => ({
          id: item.id,
          kind: item.kind,
          title: item.title,
          enabled: item.enabled,
          fireCount: item.fireCount,
          maxRuns: item.maxRuns ?? null,
          dueNow: dueIds.has(item.id),
        })),
        invalidCount: invalid.length,
      }
    },
  })

  register({
    name: 'den_schedule_delete',
    description: 'Delete one of the den\'s schedules by id.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Schedule id from den_schedule_list.' } },
      required: ['id'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => text(value) },
    async execute(args) {
      return { ok: service.removeTrigger(String(args.id)) }
    },
  })

  register({
    name: 'den_set_autonomy',
    description:
      'Grant or revoke the den\'s standing autonomy for this conversation. A grant REQUIRES the id of the human message that requested it; the den can never grant this to itself, and a timer or subagent can never grant it. Revocation always wins over any automated re-arming.',
    parameters: {
      type: 'object',
      properties: {
        autonomy: { type: 'boolean', description: 'true to grant standing autonomy, false to revoke.' },
        humanMessageId: {
          type: 'string',
          description: 'The id of the human message that carried this request. Required as proof.',
        },
      },
      required: ['autonomy', 'humanMessageId'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const agent = exec?.agent
      if (!agent) return { ok: false, error: 'no agent in scope: autonomy is per conversation' }
      try {
        const record = service.setGrant(agent, args.autonomy === true, String(args.humanMessageId))
        return { ok: true, autonomy: record.autonomy, boundToMessage: record.humanMessageId }
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) }
      }
    },
  })

  register({
    name: 'den_configure',
    description:
      'Adjust the den\'s pacing and budget: quiet hours, the daily cap on self-initiated turns, the silence cooldown after speaking, and the heartbeat cadence. A zero daily budget switches proactivity off entirely.',
    parameters: {
      type: 'object',
      properties: {
        quietHours: {
          type: 'object',
          description: 'Local-time window during which the den never speaks. Omit to leave unchanged.',
          properties: { from: { type: 'string', description: 'HH:MM' }, to: { type: 'string', description: 'HH:MM' } },
          required: ['from', 'to'],
          additionalProperties: false,
        },
        clearQuietHours: { type: 'boolean', description: 'true to remove quiet hours.' },
        dailyTurnBudget: { type: 'integer', description: '0..500 self-initiated turns per day.' },
        cooldownSeconds: { type: 'integer', description: 'Minimum silence after speaking, in seconds.' },
        tickSeconds: { type: 'integer', description: 'Heartbeat cadence in seconds, 5..3600.' },
        displayName: { type: 'string', description: 'What the human calls this assistant.' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => text(value) },
    async execute(args) {
      const patch = {}
      const toMinutes = (value) => {
        const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
        if (!match) return undefined
        const hours = Number(match[1])
        const minutes = Number(match[2])
        if (hours > 23 || minutes > 59) return undefined
        return hours * 60 + minutes
      }

      if (args?.clearQuietHours === true) patch.quietHours = null
      if (args?.quietHours) {
        const from = toMinutes(args.quietHours.from)
        const to = toMinutes(args.quietHours.to)
        if (from === undefined || to === undefined) return { ok: false, error: 'quietHours must be HH:MM (e.g. 23:00 to 07:00)' }
        patch.quietHours = { from, to }
      }
      if (args?.dailyTurnBudget !== undefined) {
        if (!Number.isSafeInteger(args.dailyTurnBudget) || args.dailyTurnBudget < 0 || args.dailyTurnBudget > 500) {
          return { ok: false, error: 'dailyTurnBudget must be an integer 0..500' }
        }
        patch.dailyTurnBudget = args.dailyTurnBudget
      }
      if (args?.cooldownSeconds !== undefined) {
        if (!Number.isSafeInteger(args.cooldownSeconds) || args.cooldownSeconds < 0) {
          return { ok: false, error: 'cooldownSeconds must be a non-negative integer' }
        }
        patch.cooldownSeconds = args.cooldownSeconds
      }
      if (args?.tickSeconds !== undefined) {
        if (!Number.isSafeInteger(args.tickSeconds) || args.tickSeconds < 5 || args.tickSeconds > 3600) {
          return { ok: false, error: 'tickSeconds must be an integer 5..3600' }
        }
        patch.tickSeconds = args.tickSeconds
      }
      if (typeof args?.displayName === 'string' && args.displayName.trim()) patch.displayName = args.displayName.trim()

      if (Object.keys(patch).length === 0) return { ok: false, error: 'nothing to change' }
      const state = service.saveState(patch)
      // A cadence the heartbeat is not actually using is a setting that lies, so a
      // running kernel is re-armed here rather than at the next restart.
      if (patch.tickSeconds !== undefined) service.kernel?.retime(state.tickSeconds)
      return { ok: true, applied: patch, effective: { quietHours: state.quietHours, dailyTurnBudget: state.dailyTurnBudget, cooldownSeconds: state.cooldownSeconds, tickSeconds: state.tickSeconds, displayName: state.displayName } }
    },
  })

  register({
    name: 'den_explain_gate',
    description:
      'Ask what the outbound approval gate would do with a hypothetical tool call, without executing anything. Use this to explain to the human why an action would be allowed, questioned, or refused.',
    parameters: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Tool name.' },
        args: { type: 'object', description: 'The arguments that would be passed.', additionalProperties: true },
      },
      required: ['tool'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => text(value) },
    async execute(args) {
      const classification = service.classify(String(args.tool), args.args)
      const verdict = classification.risk >= RISK.deny ? 'deny' : classification.risk >= RISK.ask ? 'ask' : 'allow'
      return { verdict, rule: classification.rule, reason: classification.reason, what: classification.what ?? null }
    },
  })

  register({
    name: 'den_remember',
    description:
      'Store a durable fact, preference, decision, or open thread in one scenario\'s long-term memory. Scenarios are isolated: what is stored here is never visible from any other scenario. Re-storing the same text refreshes it instead of duplicating it. Use this for things worth knowing months from now, not for conversation state.',
    parameters: {
      type: 'object',
      properties: {
        scenario: { type: 'string', description: 'Isolation domain, e.g. "personal", "work", or a project name.' },
        text: { type: 'string', description: 'The memory itself, in one self-contained sentence.' },
        kind: {
          type: 'string',
          enum: ENTRY_KINDS,
          description: 'fact = durable truth; preference = how the human likes things; decision = a choice already made; open-thread = something unresolved.',
        },
      },
      required: ['scenario', 'text'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => text(value) },
    async execute(args) {
      try {
        const result = remember(String(args.scenario), String(args.text), String(args.kind ?? 'fact'))
        return { ok: true, id: result.id, created: result.created, evicted: result.evicted, scenario: String(args.scenario) }
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) }
      }
    },
  })

  register({
    name: 'den_recall',
    description:
      'Search ONE scenario\'s long-term memory and return the most relevant entries. This is scoped by design: personal context cannot surface while working in another scenario, and vice versa. Retrieval is deterministic keyword overlap plus recency, so it can miss paraphrases — if a search returns nothing, try the words actually used when the memory was stored.',
    parameters: {
      type: 'object',
      properties: {
        scenario: { type: 'string', description: 'The scenario to search. Only this scenario is read.' },
        query: { type: 'string', description: 'What to look for.' },
        limit: { type: 'integer', description: 'Maximum entries, 1..50. Default 8.' },
      },
      required: ['scenario'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => text(value) },
    async execute(args) {
      const limit = Number.isSafeInteger(args?.limit) ? Math.min(Math.max(args.limit, 1), 50) : 8
      const result = recall(String(args.scenario), String(args.query ?? ''), { limit })
      return {
        scenario: String(args.scenario),
        count: result.entries.length,
        considered: result.considered,
        truncated: result.truncated,
        entries: result.entries.map((entry) => ({ id: entry.id, kind: entry.kind, text: entry.text, score: entry.score })),
      }
    },
  })

  register({
    name: 'den_forget',
    description: 'Delete one long-term memory by its id. Ids come from den_recall or den_remember.',
    parameters: {
      type: 'object',
      properties: {
        scenario: { type: 'string', description: 'The scenario holding the memory.' },
        id: { type: 'string', description: 'Memory id.' },
      },
      required: ['scenario', 'id'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => text(value) },
    async execute(args) {
      return forget(String(args.scenario), String(args.id))
    },
  })

  register({
    name: 'den_scenarios',
    description:
      'List the memory scenarios that currently hold anything, with entry counts. Use this before recalling to find the right scenario name rather than guessing one.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object' }, render: (_args, value) => text(value) },
    async execute() {
      return { scenarios: scenarios() }
    },
  })

  return () => {
    for (const dispose of disposers) {
      try {
        dispose?.()
      } catch {
        /* disposal must not mask an earlier failure */
      }
    }
  }
}

/**
 * Mount den as a profile-level plugin.
 *
 * Registered inside `ctx.effect` and returning the disposer keeps activation
 * reversible: disabling the plugin must leave no service, listener, tool, or timer
 * behind. Each install is ordered so that the approval gate exists before the
 * kernel can trigger anything that would use a tool.
 */
export function apply(ctx) {
  return ctx.effect(() => {
    const service = new DenService(ctx)
    const disposers = []

    const unprovide = ctx.provide('den', service)
    if (unprovide) disposers.push(unprovide)

    // The gate goes in first. Nothing the den does should ever run before the
    // thing that decides whether it is allowed to.
    //
    // `tools` is an injected property, not a `ctx.get(...)` probe. Cordis throws
    // `cannot get property "tools" without inject` for an undeclared service, so
    // declaring it in `inject` is what makes this line legal. It is deliberately a
    // hard dependency: a resident assistant holding real authority with no
    // registered approval gate is not a degraded build, it is an unsafe one, and
    // it should fail activation rather than load quietly.
    const tools = ctx.tools
    service.gateDisposer = installGate(ctx, {
      tools,
      onDecision: ({ classification, decision, tool, sessionId }) => {
        const entry = {
          tool,
          rule: classification.rule,
          risk: classification.risk,
          decision: decision.kind,
          sessionId,
        }
        service.noteEvent({ type: 'gate', ...entry })
        // Persisted as well as announced, because these are two different surfaces and
        // only one of them survives the process. `recentEvents` is a bounded in-memory
        // ring the panel shows; the audit file is what an operator can read after the
        // fact, and capability 4 is a security claim about what the gate *refused*.
        //
        // This call was missing, and the way it failed is worth recording: `gateAudit()`
        // reads `gate-audit.json`, so the panel's gate surface was permanently empty and
        // cheerfully reported "no decisions" while three real ones had just been made.
        // Nothing failed loudly, because a read of a file that is never written looks
        // exactly like a gate that has never fired.
        recordAudit(entry, service.gateAudit(AUDIT_READ_LIMIT))
      },
    })
    disposers.push(service.gateDisposer)
    disposers.push(registerTools(tools, service))

    // The heartbeat only starts when there is something it could actually do.
    // A kernel with no way to deliver a wake would count turns against the
    // budget and produce nothing, which is worse than not running.
    //
    // But "not yet" is not "never": a service's presence at activation time
    // depends on profile load order, and an earlier version treated an absent
    // service as a permanent verdict. Measured live, that produced exactly the
    // wrong outcome for a 7x24 assistant — `kernel: null` forever, with one
    // `kernel-deferred` event as the only trace, so the thing that makes it
    // resident was silently absent while everything else looked healthy. A
    // deferred heartbeat must now keep trying, and must say what it is waiting
    // for while it does.
    //
    // What it waits for changed with the delivery mechanism. It used to require
    // `subagents.sendMessage`; delivery now goes through the resolved agent's own inbox
    // (`Agent.followup`), so `agents` is the service that has to be present. Requiring
    // `subagents` here would defer the heartbeat forever on a host that has none — the same
    // failure this block exists to prevent, moved one service over.
    const KERNEL_RETRY_MS = 5000
    const KERNEL_RETRY_LIMIT = 24
    let kernelRetry = null
    let kernelRetryCount = 0

    const deliveryServiceReason = () =>
      typeof ctx.get?.('agents')?.get === 'function' ? null : 'the agents service is not available yet'

    /**
     * Measure, do not assert, the wake-delivery surface.
     *
     * Returns a plain JSON report so the status payload can carry it: whether a service is
     * wired at all is a different question from whether a live agent has the method the
     * delivery path calls, and the second one cannot be read off the service contract —
     * `Agent` is declared as `{ readonly id }` while the runtime object carries
     * `followup`. Reporting `undefined` for a method that is genuinely absent is the point;
     * a report that guessed would repeat the mistake the delivery path was fixed for.
     */
    const probeWakeApi = () => {
      const agents = ctx.get?.('agents')
      if (!agents) return { checked: false, reason: 'the agents service is not wired in this profile' }
      let live = null
      try {
        const listed = typeof agents.list === 'function' ? agents.list() : []
        live = Array.isArray(listed) && listed.length ? listed[0] : null
      } catch (error) {
        return { checked: false, reason: `listing live agents threw: ${error?.message ?? error}` }
      }
      return {
        checked: true,
        // What the Host's own service signatures offer. `followup` is expected NOT to
        // appear here — see the note on this field.
        contract: {
          get: typeof agents.get === 'function',
          resume: typeof agents.resume === 'function',
          list: typeof agents.list === 'function',
        },
        // The capability the delivery path actually calls, on a real agent object.
        sawLiveAgent: live !== null,
        liveAgent: live === null ? null : {
          id: typeof live.id === 'string' ? live.id : null,
          followup: typeof live.followup === 'function',
          inbox: live.inbox ? { nextTurn: live.inbox.nextTurn?.length ?? null, nextStep: live.inbox.nextStep?.length ?? null } : null,
        },
      }
    }
    service.probeWakeApi = probeWakeApi

    const kernelCanDeliver = () => deliveryServiceReason() === null

    const startKernel = () => {
      if (service.kernel) return true
      if (deliveryServiceReason() !== null) return false
      if (kernelRetry) {
        clearInterval(kernelRetry)
        kernelRetry = null
      }
      service.kernelDeferred = null
      service.kernel = new DenKernel({
        service,
        deliver: createDeliver(ctx, service),
        // Without these the heartbeat's own wakes are refused at the authority gate:
        // `start()` arms `setInterval(() => this.tick())`, so no agent is ever passed,
        // and authority is attested against a session rather than stored.
        //
        // The two are deliberately separate. `resolveSession` reads a transcript and
        // starts nothing, which is all the authority check needs; `resolveAgent`
        // cold-resumes a driver, which is expensive and only worth doing once a wake has
        // been admitted. Collapsing them would resume every unauthorized conversation
        // on every heartbeat, forever.
        resolveSession: (sessionId) => ctx.get?.('sessions')?.get?.(sessionId),
        resolveAgent: createAgentResolver(ctx),
        tickSeconds: service.state().tickSeconds,
        onEvent: (event) => service.noteEvent(event),
      })
      service.kernel.start()
      if (kernelRetryCount > 0) {
        service.noteEvent({ type: 'kernel-recovered', afterAttempts: kernelRetryCount })
      }
      disposers.push(() => service.kernel?.stop())
      return true
    }

    if (!startKernel() && !kernelCanDeliver()) {
      // Name the service that is actually missing rather than a generic verdict, so a
      // profile that never starts its heartbeat says why in one line.
      const reason = deliveryServiceReason() ?? 'no delivery path available in this profile'
      service.kernelDeferred = { reason, attempts: 0, retrying: true }
      service.noteEvent({ type: 'kernel-deferred', reason, retryInMs: KERNEL_RETRY_MS })
      kernelRetry = setInterval(() => {
        // Count the attempt *before* making it. Incrementing after a successful
        // start would leave the counter at zero, and the recovery event — the only
        // record that the heartbeat was ever missing — would be skipped.
        kernelRetryCount += 1
        if (service.kernelDeferred) service.kernelDeferred.attempts = kernelRetryCount
        if (startKernel()) return
        if (kernelRetryCount >= KERNEL_RETRY_LIMIT) {
          clearInterval(kernelRetry)
          kernelRetry = null
          if (service.kernelDeferred) service.kernelDeferred.retrying = false
          service.noteEvent({ type: 'kernel-unavailable', reason, attempts: kernelRetryCount })
        }
      }, KERNEL_RETRY_MS)
      kernelRetry.unref?.()
      disposers.push(() => {
        if (kernelRetry) clearInterval(kernelRetry)
        kernelRetry = null
      })
    }

    // The status panel's data route, mounted on the host web server because that is
    // what every other client plugin in this profile does. `webServer` is declared
    // in this plugin's inject list; the mount helper still reports a structured
    // failure for a test or host that supplies an incomplete web server object, so
    // a profile without one costs the user the panel and not the assistant.
    const route = mountPanelRoute(ctx, { service, nextTriggerAt })
    service.statusRoute = {
      mounted: route.mounted,
      reason: route.reason,
      message: route.message,
      path: route.path,
      /**
       * Null until a request actually arrives.
       *
       * Deliberately not set at mount time. `mounted` is this plugin reporting on
       * itself, and an earlier transport here was mounted, reported as mounted, and
       * unreachable — so the panel's snapshot must be able to say "registered, not
       * yet reached" without borrowing credit from the mount.
       */
      firstReachedAt: null,
    }
    /**
     * Called by the route handler on the first request it serves.
     *
     * This is the only place browser reachability is recorded, and it is recorded by
     * the request rather than inferred by the plugin.
     */
    service.markRouteReached = () => {
      if (service.statusRoute && service.statusRoute.firstReachedAt == null) {
        service.statusRoute.firstReachedAt = Date.now()
      }
    }
    disposers.push(route.dispose)
    if (!route.mounted) {
      service.noteEvent({ type: 'status-route-unmounted', reason: route.reason, message: route.message })
    }

    return () => {
      // Reverse order so the kernel stops before the gate it depends on is removed.
      for (const dispose of disposers.reverse()) {
        try {
          dispose?.()
        } catch {
          /* keep tearing the rest down */
        }
      }
    }
  })
}
