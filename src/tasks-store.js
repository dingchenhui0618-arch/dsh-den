/**
 * Tasks on disk. DESIGN §7.2 says the task object is a goal in plain words plus ordered steps with
 * one authorization level each; §7.3 says *it* decides when to advance. This module adds only the
 * part that needs a filesystem, and nothing else:
 *
 *  - it does not decide where the file lives — the caller passes the path, exactly like the pure
 *    store in `tasks.js` takes plain objects. That keeps `denPath(...)` and every other path
 *    decision in the one place that already owns them;
 *  - it does not schedule anything (see `tasks.js`);
 *  - it reuses `atom.js` for the write instead of hand-rolling a temp-file dance, because that
 *    helper already exists, already makes the parent directory, and already reaps stale temp files.
 *
 * The failure direction is the same one the rest of the plugin uses: **a task file that is missing
 * or unreadable is an empty list, not a start-up error.** A resident assistant that refuses to
 * start because one of its own bookkeeping files is corrupt would be trading a small problem for a
 * large one; the corrupt file is left untouched on disk instead of being silently overwritten.
 */

import { readJson, writeJsonAtomic } from './atom.js'
import {
  blockTask,
  completeStep,
  createTask,
  dueTasks,
  openTasks,
  resumeTask,
  summarize,
} from './tasks.js'

export const TASKS_FILE = 'tasks.json'
export const TASKS_VERSION = 1

/** Read the list. Anything unreadable, unparsable or of the wrong shape counts as "no tasks yet". */
export function loadTasks(path) {
  let raw = null
  try {
    raw = readJson(path)
  } catch {
    raw = null
  }
  const tasks = Array.isArray(raw?.tasks) ? raw.tasks : []
  return { version: TASKS_VERSION, tasks }
}

export function saveTasks(path, list) {
  const tasks = Array.isArray(list?.tasks) ? list.tasks : []
  writeJsonAtomic(path, { version: TASKS_VERSION, tasks })
  return { version: TASKS_VERSION, tasks }
}

/** Create one task from a plain request and persist it. Returns the new list. */
export function addTask(path, input, now = Date.now()) {
  const list = loadTasks(path)
  const task = createTask({ ...input, now })
  return saveTasks(path, { ...list, tasks: [...list.tasks, task] })
}

function replaceTask(list, next) {
  return { ...list, tasks: list.tasks.map((task) => (task.id === next.id ? next : task)) }
}

function requireTask(list, taskId) {
  const task = list.tasks.find((entry) => entry.id === taskId)
  if (!task) throw new TypeError(`no task ${taskId || '(missing id)'} in ${TASKS_FILE}`)
  return task
}

/** Finish one step of one task. */
export function advanceTask(path, { taskId, stepId, note = '', now = Date.now() } = {}) {
  const list = loadTasks(path)
  const task = requireTask(list, taskId)
  return saveTasks(path, replaceTask(list, completeStep(task, { stepId, note, now })))
}

/** Record that a task cannot move on. The reason is kept: a stuck step is never hidden (§7.4). */
export function blockTaskOn(path, { taskId, reason = '', now = Date.now() } = {}) {
  const list = loadTasks(path)
  const task = requireTask(list, taskId)
  return saveTasks(path, replaceTask(list, blockTask(task, { reason, now })))
}

export function resumeTaskOn(path, { taskId, now = Date.now() } = {}) {
  const list = loadTasks(path)
  const task = requireTask(list, taskId)
  return saveTasks(path, replaceTask(list, resumeTask(task, { now })))
}

/** What the heartbeat should pick up right now, read straight from disk. */
export function dueFromDisk(path, now = Date.now()) {
  const list = loadTasks(path)
  return dueTasks(list.tasks, now)
}

/** The three numbers the panel's single line needs (§7.4). */
export function summarizeFromDisk(path, now = Date.now()) {
  const list = loadTasks(path)
  return summarize(openTasks(list.tasks), now)
}
