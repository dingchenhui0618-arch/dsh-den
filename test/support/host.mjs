/**
 * A Host context that records everything a plugin mounts.
 *
 * Extracted from `mount.test.mjs` so the round-trip test can boot the *real* plugin
 * rather than describe it. Two harnesses building their own idea of the host is the
 * mistake this repository keeps making: the fake is written from the same assumption
 * as the code, so it agrees with it, and a wrong shape passes. One fixture, used by
 * both, cannot disagree with itself — and anything the fixture gets wrong is wrong
 * in one place, where it can be seen.
 *
 * `toolsApi` is always present: both `installGate` and `registerTools` take the
 * registry as a precondition, and testing their degradation belongs in `apply`, not
 * in a fixture that silently removes the registry they require.
 */
import { judgeSendMessage } from './subagent-delivery.mjs'

export function fakeHost({ withSubagents = true } = {}) {
  const state = {
    provided: new Map(),
    listeners: new Map(),
    tools: [],
    guards: [],
    effects: [],
    routes: [],
  }

  state.toolsApi = {
    register(definition) {
      state.tools.push(definition)
      return () => {
        const at = state.tools.indexOf(definition)
        if (at >= 0) state.tools.splice(at, 1)
      }
    },
    guard(handler) {
      state.guards.push(handler)
      return () => {
        const at = state.guards.indexOf(handler)
        if (at >= 0) state.guards.splice(at, 1)
      }
    },
  }

  const sent = []
  const liveSubagents = {
    async sendMessage(sender, targetId, content, options) {
      /**
       * This fake used to accept any delivery, and that is how a broken delivery path
       * stayed green: the plugin sends a wake with the *target conversation's own agent*
       * as the sender, which the real host rejects before it ever reaches the session.
       *
       * The real rule, read out of `SubagentRuntime`'s continuations manager:
       *
       *   if (act && act.handle.agent === sender && act.parentSession === targetId)
       *       return this.sendToParent(...)                       // the one crossing that works
       *   if (sender.session.header.parentSession === targetId) throw ...   // parent is not resident
       *   return this.deliverToChild(sender, targetId, ...)        // else treat target as a child
       *
       * and `deliverToChild` ends in `authorizeLineage(parent, childId, parentSession)`,
       * which requires `parentSession === parent.id` — i.e. it insists the target session is
       * a child of the sender. A sender that *is* the target therefore always fails.
       *
       * Only the rejection is modelled, not the acceptance: a fake that also granted
       * success would let a caller believe a delivery happened when the host would have
       * refused it. Deliveries that the real host accepts are the ones this file cannot
       * establish, and pretending otherwise is what got us here.
       */
      const verdict = judgeSendMessage(sender, targetId)
      if (!verdict.ok) {
        const error = new Error(verdict.message)
        error.code = verdict.code
        throw error
      }
      sent.push({ sender, targetId, content, options })
      return 'msg-1'
    },
  }
  /**
   * Whether a delivery path exists. The option only sets the *initial* value; tests
   * move it in both directions afterwards, which is the only honest way to exercise
   * a dependency that arrives late.
   */
  state.subagents = withSubagents ? liveSubagents : null
  state.agentsApi = {
    get: () => undefined,
    resume: async () => ({ agent: { id: 'resumed' }, dispose: async () => {} }),
  }
  // `webServer.register(route)` is the interface — the same one dsh-vision-diff,
  // dsh-warden and dsh-daily declare `inject = [..., 'webServer']` for. There is no
  // `fetch` wrapper on this service.
  state.webServer = {
    register(route) {
      state.routes.push(route)
      return () => {
        const at = state.routes.indexOf(route)
        if (at >= 0) state.routes.splice(at, 1)
      }
    },
  }

  const ctx = {
    // Injected properties, as the real Cordis context exposes services it has
    // declared via `inject`. The plugin reads these, not `ctx.get(...)`.
    tools: state.toolsApi,
    agents: state.agentsApi,
    webServer: state.webServer,
    effect(fn) {
      const dispose = fn()
      state.effects.push(dispose)
      return dispose
    },
    provide(key, value) {
      state.provided.set(key, value)
      return () => state.provided.delete(key)
    },
    get(key) {
      // Dispatches through `state` only, never through the captured option. Closing
      // over the option is silently wrong: the fixture then reports the service as
      // absent forever, and a late arrival cannot be simulated at all — which made
      // a harness bug look like a product bug.
      if (key === 'subagents') return state.subagents
      if (key === 'tools') return state.toolsApi
      if (key === 'agents') return state.agentsApi
      if (key === 'webServer') return state.webServer
      return undefined
    },
    on(event, handler) {
      state.listeners.set(event, handler)
      return () => state.listeners.delete(event)
    },
  }

  state.sentMessages = sent
  state.ctx = ctx
  /** Make the delivery path arrive late, as it does when load order differs. */
  state.arriveSubagents = () => {
    state.subagents = liveSubagents
    return liveSubagents
  }
  return { ctx, state }
}
