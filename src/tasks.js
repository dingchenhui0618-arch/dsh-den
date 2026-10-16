/**
 * The task shape behind DESIGN §7: a goal in plain words, ordered steps, and one authorization
 * level per step.
 *
 * Three decisions are worth naming, because they are what keep this from turning into a second
 * scheduler:
 *
 *  - **Nothing here schedules anything.** A task records *what still has to happen* and *when it
 *    becomes allowed*, never "wake me at 09:00". Time already has an owner (`kernel.js`); this
 *    module only answers "which step is due right now". That is the difference between "no
 *    automation to configure" and "a second place to configure automation".
 *  - **An unlabelled step asks.** A step's level defaults to `ask`, and an unrecognised level also
 *    falls back to `ask`. The failure direction must be "the human was asked", never "it went
 *    ahead": the levels exist so that payment, publishing and outbound sending cannot be reached
 *    through an absent-minded default.
 *  - **Storage is not this module's business.** Every function takes and returns plain objects, so
 *    the caller decides where they live. The whole file is testable without a filesystem, and path
 *    resolution stays in the one place that already owns it.
 */

export const STEP_MODES = ['auto', 'ask']
export const TASK_STATES = ['active', 'blocked', 'done']

/** Fail-safe default: a step nobody labelled must be asked about. */
export const DEFAULT_STEP_MODE = 'ask'

function clampMode(mode) {
  return STEP_MODES.includes(mode) ? mode : DEFAULT_STEP_MODE
}

function makeId(prefix, now, index) {
  return `${prefix}-${now.toString(36)}-${index}`
}

function pendingSteps(task) {
  return task.steps.filter((step) => step.state === 'pending')
}

/**
 * Build a task. Throws on input that would produce a task nobody could act on — a task with no
 * goal or no steps is not a small task, it is an empty object that would look like progress.
 */
export function createTask({ goal, steps, sessionId = '', now = Date.now(), id } = {}) {
  const text = String(goal ?? '').trim()
  if (!text) throw new TypeError('a task needs a goal in plain words')
  if (!Array.isArray(steps) || steps.length === 0) throw new TypeError('a task needs at least one step')

  const shaped = steps.map((step, index) => {
    const title = String(step?.title ?? '').trim()
    if (!title) throw new TypeError(`step ${index + 1} has no title`)
    return {
      id: step.id || makeId('step', now, index),
      title,
      mode: clampMode(step.mode),
      state: 'pending',
      notBefore: Number.isFinite(step.notBefore) ? step.notBefore : now,
      note: String(step.note ?? ''),
    }
  })

  return {
    id: id || makeId('task', now, 0),
    sessionId: String(sessionId ?? ''),
    goal: text,
    state: 'active',
    createdAt: now,
    updatedAt: now,
    blockedReason: '',
    steps: shaped,
  }
}

/** Tasks that still have work in them, in creation order. */
export function openTasks(tasks = []) {
  return tasks.filter((task) => task && task.state !== 'done')
}

/** The first step that is allowed to happen now, or `null` when the task has to wait. */
export function nextDueStep(task, now = Date.now()) {
  if (!task || task.state === 'done' || task.state === 'blocked') return null
  // Steps are ordered (DESIGN §7.2): only the *first* pending one is ever a candidate, so a later
  // step can never overtake a step that is still waiting. Skipping ahead here would have looked
  // like "it is being productive" while quietly reordering the user's plan.
  const step = pendingSteps(task)[0]
  if (!step || step.notBefore > now) return null
  return step
}

/** Every (task, step) pair the heartbeat could pick up right now. */
export function dueTasks(tasks = [], now = Date.now()) {
  return openTasks(tasks)
    .map((task) => ({ task, step: nextDueStep(task, now) }))
    .filter((entry) => entry.step)
}

/**
 * Mark one step finished. Returns a new task; the input is never mutated, so a caller can keep the
 * previous state and compare (which is how the tests read it without reaching into internals).
 */
export function completeStep(task, { stepId = '', note = '', now = Date.now() } = {}) {
  if (!task) throw new TypeError('completeStep needs a task')
  const target = task.steps.find((step) => step.id === stepId)
  if (!target) throw new TypeError(`no step ${stepId || '(missing id)'} in task ${task.id}`)
  const steps = task.steps.map((step) =>
    step.id === stepId
      ? { ...step, state: 'done', note: note ? String(note) : step.note }
      : step,
  )
  const remaining = steps.filter((step) => step.state === 'pending')
  return {
    ...task,
    steps,
    state: remaining.length === 0 ? 'done' : task.state === 'blocked' ? 'blocked' : 'active',
    updatedAt: now,
  }
}

/**
 * Record that the task cannot move on. A blocked task keeps its reason, because §7 says a stuck
 * step is never hidden — the reason is the part a human actually needs.
 */
export function blockTask(task, { reason = '', now = Date.now() } = {}) {
  if (!task) throw new TypeError('blockTask needs a task')
  return {
    ...task,
    state: 'blocked',
    blockedReason: String(reason ?? ''),
    updatedAt: now,
  }
}

export function resumeTask(task, { now = Date.now() } = {}) {
  if (!task) throw new TypeError('resumeTask needs a task')
  if (task.state !== 'blocked') return task
  return { ...task, state: pendingSteps(task).length === 0 ? 'done' : 'active', blockedReason: '', updatedAt: now }
}

/**
 * The three numbers the panel's single line needs (DESIGN §7.4): how much is in progress, how much
 * is stuck, and how much is waiting on the human.
 *
 * `waiting` counts only steps that are *due* and marked `ask`. An `auto` step that is due is not
 * waiting for anybody — counting it would inflate the one number whose whole job is to mean "有事
 * 在等你", and a number that cries wolf stops being read.
 */
export function summarize(tasks = [], now = Date.now()) {
  const open = openTasks(tasks)
  let waiting = 0
  for (const task of open) {
    if (task.state === 'blocked') continue
    const step = nextDueStep(task, now)
    if (step && step.mode === 'ask') waiting += 1
  }
  return {
    active: open.filter((task) => task.state === 'active').length,
    blocked: open.filter((task) => task.state === 'blocked').length,
    waiting,
    total: open.length,
  }
}
/**
 * Which piece of task work may the heartbeat take on by itself — and when must it stop.
 *
 * DESIGN §7.3 asks the heartbeat to pick out "the due next step". Three different things get
 * confused by a single boolean, so this returns four:
 *
 *   'step'    — an `auto` step is due in a task that knows which conversation it belongs to.
 *               The heartbeat may advance it and report back.
 *   'waiting' — the next step is `ask`. Nothing is wrong: this is the case the panel counts as
 *               「等你 N」, and the only mover is the person. It must NOT be reported as a fault,
 *               or every task with a human checkpoint would look broken.
 *   'blocked' — the task cannot move on for a reason only a person can fix: there is nowhere to
 *               speak (no conversation recorded). Silent skipping is what this exists to prevent —
 *               a step that cannot move on is the one thing a person must not have to go looking for.
 *   'idle'    — nothing to do.
 *
 * Only the *first* pending step of a task is ever considered, which is `nextDueStep`'s existing
 * rule: a later step must never overtake an earlier one.
 */
export function pickTaskWork(tasks = [], now = Date.now(), options = {}) {
  // A task can outlive the conversation it was created in — den's standing conversation is what makes
  // that survivable. Without a fallback the step is blocked on a fact only a person can fix, which is
  // exactly what happened to the one task on den's own board (blockedReason: "this task has no
  // conversation to speak in"). The fallback is resolved lazily: nothing is read unless some task
  // actually lacks a conversation of its own.
  for (const task of openTasks(tasks)) {
    const step = nextDueStep(task, now)
    if (!step) continue
    const own = String(task.sessionId ?? '').trim()
    const sessionId =
      own || String(options.fallbackSessionId ?? standingSessionIdFor(options.tasksPath) ?? '').trim()
    if (!sessionId) {
      return {
        kind: 'blocked',
        task,
        step,
        reason: 'this task has no conversation to speak in, so its next step cannot be started',
      }
    }
    // Only the fallback case needs a copy; a task that knows its own conversation is returned as it was.
    const owner = own ? task : { ...task, sessionId }
    if (step.mode !== 'auto') {
      return { kind: 'waiting', task: owner, step }
    }
    return { kind: 'step', task: owner, step }
  }
  return { kind: 'idle' }
}
/**
 * The standing conversation den reports into, read from the pointer file that sits beside whichever
 * state file the caller names. Non-throwing on purpose: a missing or half-written pointer must not
 * take the heartbeat down with it, and "no conversation recorded" has to stay a reportable state
 * rather than a crash.
 *
 * Exported because a second caller needs the same answer, and two copies of a read are two places
 * that get to disagree: the panel's "read it" button is den's own local bookkeeping (see
 * `panel-api.js`'s `notices/ack`), so it must not fail merely because the surface that drew the
 * button sits outside every conversation and has none to name. There is one implementation.
 *
 * The path is *derived*, not assumed: pass den's task file and the pointer beside it is read; pass
 * the pointer itself and the derivation is a no-op, which is what lets a caller that already holds a
 * conversation path hand it straight in.
 *
 * The import sits here rather than at the top because this module had none at all — and that is
 * exactly how the first version of this helper shipped broken: `readFileSync` was undefined, the
 * `catch` below swallowed the ReferenceError, and the fallback silently stayed empty while its unit
 * test passed (that test passed `fallbackSessionId` in by hand, so the file path was never covered).
 */
import { readFileSync } from 'node:fs'

export function standingSessionIdFor(statePath) {
  if (!statePath) return ''
  try {
    const pointerPath = String(statePath).replace(/[^\\/]+$/, '') + 'conversation.json'
    return String(JSON.parse(readFileSync(pointerPath, 'utf8'))?.sessionId ?? '').trim()
  } catch {
    return ''
  }
}