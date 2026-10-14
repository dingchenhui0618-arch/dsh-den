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
