/**
 * The model-facing side of DESIGN §7: the tools that turn "帮我办 X" into a task, let anyone read
 * what is in progress, and move one step forward.
 *
 * Two things are deliberate here:
 *
 *  - **The path is injected, not looked up.** The factory takes the task file's path, so production
 *    passes `denPath(TASKS_FILE)` and a test passes a temp file. Nothing in this file has to guess
 *    where the den keeps its data, and every behaviour below is testable without touching the real
 *    den directory.
 *  - **A refusal is a normal answer, not an exception.** `ask` steps return `{ ok: false }` with the
 *    reason instead of throwing, because "not without your word" is an ordinary outcome the model
 *    should be able to read and relay to the human. Only a caller error (a task id that does not
 *    exist) throws.
 *
 * On `ask` and the `approval` argument: this is a *fail-safe default*, not a security boundary. A
 * caller that lies about having asked will get through, exactly as DESIGN §6 says about the gate's
 * pattern matching — what this buys is that the honest path is the only one that works by accident.
 */

import { nextDueStep, summarize } from './tasks.js'
import {
  addTask,
  advanceTask,
  blockTaskOn,
  loadTasks,
  resumeTaskOn,
} from './tasks-store.js'

function ok(value) {
  return { ok: true, ...value }
}

function refuse(error) {
  return { ok: false, error }
}

/**
 * Build the tool list. `path` is required; `text` renders tool output and defaults to JSON so the
 * module can be exercised without the host.
 */
export function makeTaskTools({ path, text = (value) => JSON.stringify(value) } = {}) {
  if (!path) throw new TypeError('makeTaskTools needs the task file path')

  const render = (_args, value) => text(value)

  return [
    {
      name: 'den_task_create',
      description:
        'Turn a request into a task: one goal in plain words plus ordered steps. Each step may be marked auto (reversible, on this machine — do it and report) or ask (send, publish, spend, credentials — ask first). An unmarked step is ask. Do not schedule anything: say what has to happen, not when to wake up.',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'the goal, in the user\u2019s own words' },
          sessionId: { type: 'string', description: 'the conversation this task belongs to; the den speaks there when a step comes due. Optional: a task without one is still created, and the heartbeat will say so instead of guessing a conversation' },
          steps: {
            type: 'array',
            description: 'ordered steps; each is {title, mode?}',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                mode: { type: 'string', enum: ['auto', 'ask'] },
              },
              required: ['title'],
              additionalProperties: false,
            },
          },
        },
        required: ['goal', 'steps'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render },
      async execute({ goal, steps, sessionId } = {}) {
        try {
          const saved = addTask(path, { goal, steps, sessionId })
          const task = saved.tasks[saved.tasks.length - 1]
          return ok({
            taskId: task.id,
            goal: task.goal,
            steps: task.steps.map((step) => ({ id: step.id, title: step.title, mode: step.mode })),
            ...summarize(saved.tasks),
          })
        } catch (error) {
          return refuse(String(error?.message ?? error))
        }
      },
    },
    {
      name: 'den_task_list',
      description:
        'What is in progress. Returns the tasks and three numbers: active, blocked, and waiting (steps that are due and marked ask — the ones that need the human).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' }, render },
      async execute() {
        const list = loadTasks(path)
        return ok({
          tasks: list.tasks.map((task) => ({
            id: task.id,
            goal: task.goal,
            state: task.state,
            blockedReason: task.blockedReason,
            steps: task.steps.map((step) => ({
              id: step.id,
              title: step.title,
              mode: step.mode,
              state: step.state,
              note: step.note,
            })),
          })),
          ...summarize(list.tasks),
        })
      },
    },
    {
      name: 'den_task_advance',
      description:
        'Mark one step of a task finished. Steps are ordered; with no stepId it takes the first due step. A step marked ask refuses unless approval carries the words that authorised it — that refusal is the point, so relay it to the human instead of working around it.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'the task id returned by den_task_create' },
          stepId: { type: 'string', description: 'defaults to the first due step' },
          note: { type: 'string', description: 'what happened, in one line' },
          approval: {
            type: 'string',
            description: 'for an ask step: the words from the human that authorised it',
          },
        },
        required: ['taskId'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render },
      async execute({ taskId, stepId = '', note = '', approval = '' } = {}) {
        const list = loadTasks(path)
        const task = list.tasks.find((entry) => entry.id === taskId)
        if (!task) throw new TypeError(`no task ${taskId || '(missing id)'}`)
        const step = stepId ? task.steps.find((entry) => entry.id === stepId) : nextDueStep(task)
        if (!step) return refuse('no step of that task is due right now')
        if (step.state !== 'pending') return refuse(`step ${step.id} is already ${step.state}`)
        if (step.mode === 'ask' && !String(approval).trim()) {
          return refuse(`step ${step.id} is marked ask: pass approval with the human\u2019s words`)
        }
        const stamped = approval ? `${note}${note ? ' | ' : ''}approved: ${approval}` : note
        const saved = advanceTask(path, { taskId, stepId: step.id, note: stamped })
        const next = saved.tasks.find((entry) => entry.id === taskId)
        return ok({
          taskId,
          finished: step.id,
          state: next.state,
          nextStep: nextDueStep(next)?.title ?? '',
          ...summarize(saved.tasks),
        })
      },
    },
    {
      name: 'den_task_block',
      description:
        'Record that a task cannot move on, and why. A blocked task keeps its reason and offers no steps until it is resumed — a stuck step is never hidden.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'the task id returned by den_task_create' },
          reason: { type: 'string', description: 'what it is waiting for, in one line' },
          resume: { type: 'boolean', description: 'set true to resume instead of blocking' },
        },
        required: ['taskId', 'reason'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render },
      async execute({ taskId, reason = '', resume = false } = {}) {
        const list = loadTasks(path)
        const task = list.tasks.find((entry) => entry.id === taskId)
        if (!task) throw new TypeError(`no task ${taskId || '(missing id)'}`)
        const saved = resume
          ? resumeTaskOn(path, { taskId })
          : blockTaskOn(path, { taskId, reason })
        const next = saved.tasks.find((entry) => entry.id === taskId)
        return ok({ taskId, state: next.state, blockedReason: next.blockedReason, ...summarize(saved.tasks) })
      },
    },
  ]
}

/** Register them on a plugin context. Wiring stays a one-liner so it can be checked by reading. */
export function registerTaskTools({ register, path, text }) {
  for (const tool of makeTaskTools({ path, text })) register(tool)
}
