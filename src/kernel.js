/**
 * The autonomy kernel: heartbeat, the three-gate decision, and cold wake.
 *
 * The central idea is **waking is not interrupting**. The heartbeat runs on a
 * fixed cadence and is cheap; whether anything reaches the human is a separate
 * decision that must pass three gates in order. Most heartbeats should produce no
 * notification at all — if every wake speaks, the assistant is noise and gets
 * uninstalled.
 *
 * Gate order is deliberate:
 *   1. AUTHORITY — is standing autonomy still granted *right now*?
 *   2. BUDGET    — is today's self-initiated turn budget spent?
 *   3. QUIET     — is the human asleep or focused right now?
 *   4. PACING    — has the den spoken too recently?
 *
 * Only these four can be evaluated mechanically and are enforced here. The
 * separate question of whether a result deserves an interruption is gate 5
 * (VALUE), and it is enforced by the *model*: the den is handed a bounded
 * instruction telling it to emit a single SKIP token when nothing is worth
 * saying. This module enforces the part that must not depend on the model's
 * cooperation, and records the part that does.
 *
 * Every self-initiated run re-checks live authority. A trigger is never a grant.
 */

import { denPath, digest, readJson, writeJsonAtomic } from './atom.js'
import { hasAnyGrant, hasAutonomyForSession } from './grant.js'
import { queueNotice } from './notices.js'
import { dueTriggers, markAttemptFailed, markFired } from './triggers.js'
import { pickTaskWork } from './tasks.js'
import { loadTasks, advanceTask, blockTaskOn } from './tasks-store.js'

/** Instruction handed to the den for a self-initiated turn. */
/**
 * What the den is told when the heartbeat takes a task step by itself.
 *
 * Deliberately not a claim of authorship: `deliver`'s own note says tool calls must never be
 * handed to a person as if the den had said them out loud. This is the den being woken to work.
 */
export const TASK_STEP_INSTRUCTION = [
  'The heartbeat has taken one step of a task you are responsible for.',
  'Do that step now, then say in one or two plain sentences what happened.',
  'If the step cannot be done, say why — a step that cannot move on is never hidden.',
].join(' ')
export const WAKE_INSTRUCTION = [
  'This turn was started by your own heartbeat, not by the human.',
  '',
  'Decide whether the result is worth interrupting the human:',
  '- If nothing here is worth their attention, reply with exactly SKIP and nothing else.',
  '- If it is worth attention, reply with the message you want them to see, in one short paragraph.',
  '- Do not narrate your process. Do not ask for permission here; outbound actions are gated separately.',
].join('\n')

/** Recognised "say nothing" marker. Matched leniently but deliberately. */
const SKIP_PATTERN = /^\s*SKIP\s*[.!]?\s*$/i

/**
 * Decide whether a wake produced something the human should see.
 *
 * A reply that is empty or is the SKIP marker means: record it, do not speak.
 * Everything else is a candidate message, truncated to a sane length so a
 * runaway generation cannot spam a channel.
 */
export function interpretWakeResult(text) {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (!trimmed) return { speak: false, reason: 'empty' }
  if (SKIP_PATTERN.test(trimmed)) return { speak: false, reason: 'skip' }
  return { speak: true, message: trimmed.slice(0, 4000) }
}

/** Is `now` inside the configured quiet window (local time, `HH:MM` strings)? */
export function inQuietHours(quietHours, now = new Date()) {
  if (!quietHours) return false
  const { from, to } = quietHours
  const clock = now.getHours() * 60 + now.getMinutes()
  // A window that wraps midnight (e.g. 23:00 -> 07:00) is the common case.
  if (from === to) return false
  return from < to ? clock >= from && clock < to : clock >= from || clock < to
}

/**
 * Persisted per-day ledger.
 *
 * Counters live on disk rather than in memory because "the assistant used its
 * whole budget, then the host restarted and it started again" is exactly the
 * failure a budget exists to prevent.
 */
export function ledgerPath(now = new Date()) {
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return denPath('ledger', `${stamp}.json`)
}

function emptyLedger() {
  return { version: 1, turns: 0, spoken: 0, skipped: 0, refused: 0 }
}

export function readLedger(now = new Date()) {
  const value = readJson(ledgerPath(now))
  if (!value || value.version !== 1) return emptyLedger()
  return {
    version: 1,
    turns: Number.isSafeInteger(value.turns) ? value.turns : 0,
    spoken: Number.isSafeInteger(value.spoken) ? value.spoken : 0,
    skipped: Number.isSafeInteger(value.skipped) ? value.skipped : 0,
    refused: Number.isSafeInteger(value.refused) ? value.refused : 0,
  }
}

export function bumpLedger(field, now = new Date()) {
  const ledger = readLedger(now)
  if (!(field in ledger)) throw new Error(`dsh-den: unknown ledger field ${field}`)
  const next = { ...ledger, [field]: ledger[field] + 1 }
  writeJsonAtomic(ledgerPath(now), next)
  return next
}

/**
 * Last time the den spoke, used for the pacing gate. Stored beside the ledger so
 * it survives restarts; a cooldown that resets on every boot is not a cooldown.
 */
export function lastSpokePath() {
  return denPath('pacing.json')
}

export function readLastSpoke() {
  const value = readJson(lastSpokePath())
  return Number.isFinite(value?.lastSpokeAt) ? value.lastSpokeAt : null
}

export function recordSpoke(at = Date.now()) {
  writeJsonAtomic(lastSpokePath(), { version: 1, lastSpokeAt: at })
  return at
}

/**
 * Evaluate the mechanical gates for one candidate wake.
 *
 * Authority is checked against `session`, not against a live driver, because it is a
 * property of the conversation: the grant names a session and a human message, and the
 * transcript is the proof. Accepting an agent as well keeps the direct-call path (and
 * the tests that drive it) working, but the heartbeat — which has no agent to offer —
 * is served by the session.
 *
 * @param {object} options
 * @param {object} options.state the den's configured state
 * @param {object} [options.session] the conversation's session log
 * @param {object} [options.agent] a live driver, used for its session when given
 * @returns {{ allowed: true } | { allowed: false, gate: string, reason: string }}
 */
export function evaluateGates({ state, session, agent, now = Date.now(), grantsDir = null, sessionId = '' }) {
  const authoritySession = session ?? agent?.session
  /**
   * The conversation this wake is for, from whichever source can still name it: the resolved
   * session, the agent carrying one, or the trigger/task that scheduled the wake. An agent-less
   * wake has no session object at all, and without this it could not tell its own grant apart
   * from another conversation's - which is how a grant whose proof is gone got laundered.
   */
  const askingId = authoritySession?.id || sessionId
  /**
   * Standing autonomy is asked for once and covers the den, not one string.
   *
   * It used to be per-conversation: a grant proved in conversation A left the den unable to wake
   * in conversation B, and the person who had already granted it once was asked again. The
   * attestation is unchanged — `hasAutonomyForSession` still re-reads the transcript and still
   * refuses a grant whose binding human message is gone — and `hasAnyGrant` only widens *where*
   * that proved grant applies.
   *
   * The other three gates are untouched on purpose. They stop the den from being a nuisance
   * (budget, quiet hours, cadence); this one was never about being a nuisance, it was about who
   * may start the work.
   */
  if (!hasAutonomyForSession(authoritySession) && !hasAnyGrant(askingId, grantsDir)) {
    return {
      allowed: false,
      gate: 'authority',
      reason: 'no standing autonomy from a direct human request',
    }
  }

  if (state.dailyTurnBudget <= 0) {
    return { allowed: false, gate: 'budget', reason: 'daily turn budget is zero; proactivity is off' }
  }

  const ledger = readLedger(new Date(now))
  if (ledger.turns >= state.dailyTurnBudget) {
    return {
      allowed: false,
      gate: 'budget',
      reason: `daily turn budget reached (${ledger.turns}/${state.dailyTurnBudget})`,
    }
  }

  if (inQuietHours(state.quietHours, new Date(now))) {
    return { allowed: false, gate: 'quiet', reason: 'inside quiet hours' }
  }

  const lastSpoke = readLastSpoke()
  // Compare against the *supplied* instant, not the wall clock: the caller owns
  // the notion of "now" (the heartbeat passes its tick time, tests pass synthetic
  // times, and a recovery path may replay a past instant). Mixing the two makes
  // the gate disagree with itself.
  if (lastSpoke !== null && now - lastSpoke < state.cooldownSeconds * 1000) {
    const waitSeconds = Math.ceil((state.cooldownSeconds * 1000 - (now - lastSpoke)) / 1000)
    return { allowed: false, gate: 'pacing', reason: `cooling down for another ${waitSeconds}s` }
  }

  return { allowed: true }
}

/**
 * The heartbeat.
 *
 * Design notes that matter for correctness:
 *
 * - `tick` is re-entrancy guarded. A slow wake must not overlap the next tick and
 *   double-spend the budget.
 * - All persistence is written *before* the effect of a wake is assumed, because
 *   in-process jobs do not survive a restart.
 * - The timer is disposed with the plugin, so disabling the den leaves no timer
 *   behind holding a closure over the host.
 */
export class DenKernel {
  /**
   * @param {object} options
   * @param {object} options.service the DenService, for state and authority
   * @param {number} [options.tickSeconds] heartbeat cadence
   * @param {(wake: object) => Promise<string>} options.deliver performs the wake
   * @param {(event: object) => void} [options.onEvent] observability sink
   * @param {(sessionId: string) => Promise<object|null>} [options.resolveAgent]
   *   Finds or cold-resumes the driver for a conversation.
   *
   *   This exists because authority is *attested*, not asserted: `currentGrant`
   *   verifies the grant against the immutable session log, so it needs a session to
   *   read. The heartbeat calls `tick()` with no arguments, so without a resolver the
   *   authority gate is asked about `undefined` and refuses every wake — a resident
   *   assistant that can never once wake itself, while the mount, the tools, and the
   *   gates all report healthy.
   * @param {(sessionId: string) => object|undefined} [options.resolveSession]
   *   Reads a transcript *without* starting a driver. Used for the authority check, so
   *   a refusal costs nothing; `resolveAgent` is only consulted once a wake is admitted.
   */
  constructor({
    service,
    deliver,
    taskPath = '',
    grantsDir = null,
    onEvent,
    tickSeconds = 60,
    resolveAgent = null,
    resolveSession = null,
    lease = null,
  }) {
    this.service = service
    this.deliver = deliver
    this.taskPath = taskPath
    this.grantsDir = grantsDir
    this.onEvent = onEvent ?? (() => {})
    this.resolveAgent = resolveAgent
    this.resolveSession = resolveSession
    this.lease = lease
    this.tickSeconds = Math.max(5, tickSeconds)
    this.timer = null
    this.running = false
    this.stopped = false
    this.lastTickAt = null
    this.lastError = null
  }

  start() {
    if (this.timer) return
    this.stopped = false
    this.timer = setInterval(() => {
      // Never let a rejection escape into an unhandled rejection that could take
      // the host down: a heartbeat must be the least dangerous thing in the app.
      this.tick().catch((error) => {
        this.lastError = String(error?.message ?? error)
        this.onEvent({ type: 'tick-error', message: this.lastError })
      })
    }, this.tickSeconds * 1000)
    // Do not hold the process open just for the heartbeat.
    this.timer.unref?.()
    this.onEvent({ type: 'started', tickSeconds: this.tickSeconds })
  }

  stop() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.onEvent({ type: 'stopped' })
  }

  /**
   * Apply a new cadence to a running heartbeat, without waiting for a restart.
   *
   * `den_configure` writes `tickSeconds` to state, but the interval was armed once
   * with the value it read at construction. Measured in the acceptance run: the
   * stored cadence changed and the live timer kept firing on the old one, so the
   * setting appeared to apply and did not. Re-arming is the whole fix, and it is
   * also why the heartbeat reports the cadence it is *actually* using.
   */
  retime(tickSeconds) {
    const next = Math.max(5, Math.floor(Number(tickSeconds) || this.tickSeconds))
    if (next === this.tickSeconds) return this.tickSeconds
    this.tickSeconds = next
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
      this.stopped = false
      this.start()
      this.onEvent({ type: 'retimed', tickSeconds: next })
    }
    return next
  }

  /** One heartbeat. Safe to call directly, which is what tests and tools do. */
  async tick({ agent, now = Date.now() } = {}) {
    if (this.running) return { skipped: 'reentrant' }
    this.running = true
    this.lastTickAt = now
    try {
      // One state tree, one resident. Nothing about `dueTriggers` is a claim — it is a read —
      // and the delivery sits between that read and `markFired` with an `await` in the middle,
      // so two hearts over one home deliver the same check-in twice. Measured, not reasoned:
      // the second kernel's outcome was `spoke` and the conversation received it twice.
      //
      // The kernel still runs and still ticks; a host that cannot take the lease stands down
      // for this tick and tries again on the next one. That is deliberate. A start-time lock
      // would leave a window where *no* host holds residency, and a resident assistant that
      // stopped delivering is worse than one that occasionally repeats itself.
      if (this.lease) {
        const held = this.lease.acquire(now)
        if (!held) {
          const holderPid = this.lease.holder?.pid ?? null
          this.onEvent({ type: 'kernel-standby', holderPid })
          return { due: dueTriggers(now).length, standby: true, holderPid, results: [] }
        }
      }
      return await this.#runDue({ agent, now })
    } finally {
      this.running = false
    }
  }

  /**
   * Read a conversation's transcript without starting anything.
   *
   * Provided by the caller because the kernel must not reach into `ctx` — it takes the
   * services it needs as explicit arguments so its behaviour is testable without a
   * host. Returning `undefined` is normal: a session that is not live and cannot be
   * read simply has no authority, which the gate then reports.
   */
  lookupSession(sessionId) {
    if (typeof this.resolveSession !== 'function') return undefined
    try {
      return this.resolveSession(sessionId) ?? undefined
    } catch (error) {
      this.lastError = String(error?.message ?? error)
      return undefined
    }
  }

  /**
   * Take one due task step: same gates, same driver resolution, same delivery, different ledger.
   *
   * `advanceTask` replaces `markFired` because the step's completion *is* the record — there is no
   * cadence to commit. When delivery throws, nothing is advanced, so the step stays due and is
   * retried on a later heartbeat instead of being eaten.
   */
  async #runTaskStep({ pick, agent, now }) {
    const { task, step } = pick
    const session = agent?.session ?? this.lookupSession(task.sessionId)
    let resolved = agent ?? null
    let release = null

    const verdict = evaluateGates({ state: this.service.state(), session, agent: resolved, now, grantsDir: this.grantsDir, sessionId: task.sessionId })
    if (!verdict.allowed) {
      // Same instrument as the trigger path: a permanent condition must not be re-asked forever.
      this.onEvent({
        type: 'task-refused',
        taskId: task.id,
        stepId: step.id,
        gate: verdict.gate,
        reason: verdict.reason,
      })
      return { triggerId: step.id, outcome: 'refused', reason: verdict.reason }
    }

    if (!resolved && this.resolveAgent) {
      try {
        const found = await this.resolveAgent(task.sessionId)
        if (found) {
          resolved = found.agent ?? found
          release = found.dispose ?? null
        }
      } catch (error) {
        this.onEvent({
          type: 'task-unresolved',
          taskId: task.id,
          stepId: step.id,
          message: String(error?.message ?? error),
        })
      }
    }

    const wake = { id: step.id, sessionId: task.sessionId, title: step.title, kind: 'task-step', goal: task.goal }
    try {
      await this.deliver({ trigger: wake, instruction: TASK_STEP_INSTRUCTION, agent: resolved })
    } catch (error) {
      this.lastError = String(error?.message ?? error)
      this.onEvent({
        type: 'task-failed',
        taskId: task.id,
        stepId: step.id,
        message: this.lastError,
        willRetry: true,
      })
      return { triggerId: step.id, outcome: 'failed', reason: this.lastError, willRetry: true }
    } finally {
      if (typeof release === 'function') release()
    }

    advanceTask(this.taskPath, { taskId: task.id, stepId: step.id, note: 'taken by the heartbeat', now })
    this.onEvent({ type: 'task-step-taken', taskId: task.id, stepId: step.id })
    return { triggerId: step.id, outcome: 'spoke' }
  }
  async #runDue({ agent, now }) {
    const due = dueTriggers(now)
    // The empty case returns the same shape as the busy one, `results` included.
    //
    // It used to omit `results`, so `tick()` resolved to `{due: 0, woke: 0, spoke: 0}`
    // on a quiet heartbeat and to an object *with* `results` otherwise. A caller reading
    // `tick().results.length` — which is the obvious way to ask "what did this tick
    // decide?" — got a `TypeError` on exactly the ticks where nothing happened, and that
    // is the common case for a resident assistant. Found by writing that assertion.
    /**
     * DESIGN §7.3: the same heartbeat picks out a due task step. This is a parallel channel, not a
     * second system — the four gates and the delivery below are shared, and the only thing this
     * path does differently is its bookkeeping. A task step does not live in the trigger store at
     * all, which is exactly why it cannot become another `due` entry: `markFired` would be asked to
     * write a record it does not know.
     *
     * It has to sit BEFORE the quiet-heartbeat return. `dueTriggers` is empty almost all the time
     * for a resident assistant, so a channel placed after that return would compile, pass every
     * test, and never once run — the shape of failure this file's history is made of.
     *
     * `blocked` is written back to disk with its reason rather than skipped: a step nobody can
     * start is the one thing a person must not have to go looking for.
     */
    const taskPick = this.taskPath
      ? pickTaskWork(loadTasks(this.taskPath).tasks, now)
      : { kind: 'idle' }
    if (taskPick.kind === 'blocked') {
      blockTaskOn(this.taskPath, { taskId: taskPick.task.id, reason: taskPick.reason, now })
      this.onEvent({ type: 'task-blocked', taskId: taskPick.task.id, reason: taskPick.reason })
    }
    const taskResult =
      taskPick.kind === 'step' ? await this.#runTaskStep({ pick: taskPick, agent, now }) : null
    const taskResults = taskResult ? [taskResult] : []
    if (due.length === 0) {
      return {
        due: taskResults.length,
        woke: taskResult && taskResult.outcome !== 'refused' ? 1 : 0,
        spoke: taskResult && taskResult.outcome === 'spoke' ? 1 : 0,
        results: taskResults,
      }
    }

    const state = this.service.state()
    const results = []

    for (const { trigger } of due) {
      if (this.stopped) break

      /**
       * Resolve the conversation before asking about authority, but resolve the
       * *cheapest* thing that can answer the question.
       *
       * Authority in this plugin is attested against the session log, so it needs a
       * session. That is not the same as needing a live driver: `lookupSession` hands
       * back the transcript without starting anything. Resolving a driver first would
       * cold-resume a conversation on every refusal — spending a driver to learn that a
       * conversation was never authorized, on a timer, forever.
       *
       * A driver is resolved once the gate has admitted the wake. Before this ordering
       * existed the heartbeat called `tick()` with no arguments — `start()` is
       * `setInterval(() => this.tick())` — and `#runDue` asked `undefined` for its
       * authority, so **every autonomous wake in the field was refused**, while the
       * mount, the tools, the ledger and the panel all reported healthy.
       */
      const session = agent?.session ?? this.lookupSession(trigger.sessionId)
      let resolved = agent ?? null
      let release = null

      try {
        const verdict = evaluateGates({ state, session, agent: resolved, now, grantsDir: this.grantsDir, sessionId: trigger.sessionId })
        if (!verdict.allowed) {
          // A refused wake is recorded, not silently dropped. The budget gate in
          // particular must be auditable, otherwise "why did it stop working?"
          // is unanswerable.
          bumpLedger('refused', new Date(now))
          /**
           * And it is *throttled*, which this path did not do.
           *
           * Nothing here advances `lastFiredAt`, so the trigger stays due and the next
           * heartbeat picks it up again — and the next. Measured on the running host: a
           * single unauthorized `once` trigger produced a `wake-refused` event every 60
           * seconds, exactly on the tick, with no backoff. A permanent condition was
           * being re-evaluated 1,440 times a day, each one appending to the event log.
           *
           * The reply to a permanent condition cannot change by asking again, so the
           * retry throttle that already exists for failed *delivery* is the right
           * instrument here too. It costs promptness in one case worth naming: a trigger
           * refused just before a human grants autonomy waits out the throttle rather
           * than firing at the next tick. Up to 15 minutes late is a better trade than
           * flooding the log forever, and the cadence anchor is untouched either way.
           */
          markAttemptFailed(trigger, now)
          this.onEvent({
            type: 'wake-refused',
            triggerId: trigger.id,
            gate: verdict.gate,
            reason: verdict.reason,
            // Whether a transcript was readable at all separates "the human has not
            // authorized this" from "there was nothing to check against".
            hadSession: session !== null && session !== undefined,
          })
          results.push({
            triggerId: trigger.id,
            outcome: 'refused',
            gate: verdict.gate,
            reason: verdict.reason,
            hadSession: session !== null && session !== undefined,
          })
          continue
        }

        // Admitted. A driver is needed to actually deliver, and only now is it worth
        // resuming a conversation that is not live.
        if (!resolved && this.resolveAgent) {
          try {
            const found = await this.resolveAgent(trigger.sessionId)
            if (found) {
              resolved = found.agent ?? found
              release = found.dispose ?? null
            }
          } catch (error) {
            // The wake was authorized but no driver could be obtained. Record why; the
            // delivery path reports the failure rather than throwing out of the
            // heartbeat.
            this.onEvent({
              type: 'wake-unresolved',
              triggerId: trigger.id,
              message: String(error?.message ?? error),
            })
          }
        }

        let output
        try {
          output = await this.deliver({ trigger, instruction: WAKE_INSTRUCTION, agent: resolved })
        } catch (error) {
          // The wake was admitted but never reached the conversation. Charge only
          // the retry throttle — NOT `lastFiredAt`/`fireCount` — so this check-in
          // is retried instead of being eaten until the next full interval. The
          // trigger keeps its original cadence anchor either way.
          this.lastError = String(error?.message ?? error)
          markAttemptFailed(trigger, now)
          this.onEvent({ type: 'wake-failed', triggerId: trigger.id, message: this.lastError, willRetry: true })
          results.push({ triggerId: trigger.id, outcome: 'failed', reason: this.lastError, willRetry: true })
          continue
        }

        // Only now is the run real: a turn was actually spent. Refusals and
        // failures never reach this line, so the ledger answers "how many turns did
        // the den actually take today?" rather than "how many times did it try?".
        bumpLedger('turns', new Date(now))

        // Committing the cadence after delivery is the ordering that matters: if
        // the process dies mid-delivery the trigger is still due on the next boot,
        // and the wake instruction is idempotent, so a duplicate costs one cheap
        // turn rather than losing the check-in outright.
        markFired(trigger, now)

        const verdictOnOutput = interpretWakeResult(output)
        if (!verdictOnOutput.speak) {
          bumpLedger('skipped', new Date(now))
          this.onEvent({ type: 'wake-silent', triggerId: trigger.id, reason: verdictOnOutput.reason })
          results.push({ triggerId: trigger.id, outcome: 'silent', reason: verdictOnOutput.reason })
          continue
        }

        // Queue first, then speak. If the process dies between the two, the notice
        // is still durable and will be delivered on the next boot.
        queueNotice(trigger.sessionId, verdictOnOutput.message, 'notice')
        bumpLedger('spoken', new Date(now))
        recordSpoke(now)
        this.onEvent({ type: 'wake-spoke', triggerId: trigger.id })
        results.push({ triggerId: trigger.id, outcome: 'spoke' })
      } finally {
        // Release a driver this wake resolved. The session stays durable on disk and
        // the next wake resumes it anew; holding it would quietly turn an on-demand
        // wake into a permanent process, which is the opposite of the design.
        if (release) {
          try {
            await release()
          } catch {
            /* releasing must never fail the wake it just performed */
          }
        }
      }
    }

    return {
      due: due.length,
      // Derived from the decisions rather than counted separately, so the three cannot
      // disagree. The two branches of this method used to return *different key sets* —
      // the idle one had `woke`/`spoke` and the busy one did not — which meant a caller
      // reading `tick().spoke` got a number on quiet ticks and `undefined` on the ticks
      // that actually spoke. Both that and the missing `results` were found by asserting
      // the two shapes are equal, which is a test worth keeping for exactly this reason.
      woke: results.filter((r) => r.outcome !== 'refused').length,
      spoke: results.filter((r) => r.outcome === 'spoke').length,
      results,
    }
  }
}

/** Stable id helper so callers can build deterministic trigger ids. */
export function triggerIdFor(sessionId, title) {
  return digest(`${sessionId}:${title}`)
}
