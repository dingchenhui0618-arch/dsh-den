/**
 * The model-facing side of the profile (DESIGN §7.8): one tool, four actions.
 *
 * It is deliberately **one** tool with an `action`, not four tools named after the existing
 * `den_remember` / `den_recall` / `den_forget` set. Those already exist and mean something else —
 * the den's own scenario memory — and adding near-identical names would leave a person (and a
 * model) unable to tell which store they are talking about. A profile is not another memory box:
 * it is the few things about the person, each of which must name where it came from.
 *
 * The one rule from §7.8 that shows up here as behaviour: `remember` **refuses without a source**,
 * and the refusal is a normal answer rather than an exception, because "I do not know where that
 * came from" is something the model should read and relay, not something that looks like a crash.
 * The list of permitted sources is returned in every answer, so the model never has to guess the
 * vocabulary and never has a reason to invent a plausible one.
 *
 * Storage follows the other two stores: the path is injected, nothing throws at start-up.
 */

import { addEntry, forgetEntry, listEntries, loadProfile, saveProfile, updateEntry, KINDS, SOURCES } from './profile.js'

function ok(value) {
  return { ok: true, ...value }
}

function refuse(error) {
  return { ok: false, error }
}

function shape(entry) {
  return { id: entry.id, text: entry.text, kind: entry.kind, source: entry.source, at: entry.at }
}

export function makeProfileTools({ path, text = (value) => JSON.stringify(value) } = {}) {
  if (!path) throw new TypeError('makeProfileTools needs the profile file path')

  const render = (_args, value) => text(value)

  return [
    {
      name: 'den_profile',
      description:
        'What the den knows about the person it works for: at most a few dozen lines, each one traceable to where it came from. Actions: list (read it, optionally one kind), remember (add one line — text and source are both required; a line that cannot name a source is an invention and is refused), edit (correct the wording of one line; its source does not change), forget (delete one line). Read the entries before acting on them, and prefer asking the person over inferring a line.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'remember', 'edit', 'forget'],
            description: 'list (read what is known) | remember (add one line) | edit (correct the wording) | forget (delete one line)',
          },
          text: { type: 'string', description: 'the line itself, for remember/edit' },
          id: { type: 'string', description: 'which line, for edit/forget' },
          kind: {
            type: 'string',
            enum: KINDS,
            description: 'work (what is in hand) | preference (how it should be done) | boundary (what not to do)',
          },
          source: {
            type: 'string',
            enum: SOURCES,
            description: 'where this line came from: session history | codex memories | repos | the person saying it',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render },
      async execute({ action = '', text: body = '', id = '', kind = 'work', source = '' } = {}) {
        const profile = loadProfile(path)
        try {
          if (action === 'list') {
            const entries = listEntries(profile, { kind: kind === 'work' ? '' : kind })
            return ok({ entries: entries.map(shape), count: entries.length, kinds: KINDS, sources: SOURCES })
          }
          if (action === 'remember') {
            if (!String(source).trim()) {
              return refuse(
                'remember needs a source (session, memories, repos or user): a line that cannot name one is an invention',
              )
            }
            const saved = saveProfile(path, addEntry(profile, { text: body, kind, source }))
            return ok({ entries: listEntries(saved).map(shape), count: saved.entries.length, sources: SOURCES })
          }
          if (action === 'edit') {
            const saved = saveProfile(path, updateEntry(profile, { id, text: body }))
            return ok({ entries: listEntries(saved).map(shape), count: saved.entries.length })
          }
          if (action === 'forget') {
            const saved = saveProfile(path, forgetEntry(profile, { id }))
            return ok({ entries: listEntries(saved).map(shape), count: saved.entries.length })
          }
          return refuse(`unknown action ${JSON.stringify(action)}; expected list, remember, edit or forget`)
        } catch (error) {
          return refuse(String(error?.message ?? error))
        }
      },
    },
  ]
}

export function registerProfileTools({ register, path, text }) {
  for (const tool of makeProfileTools({ path, text })) register(tool)
}
