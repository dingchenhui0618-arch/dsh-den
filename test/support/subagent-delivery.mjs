/**
 * The one place that models the part of the host which this plugin got wrong.
 *
 * Why a shared module rather than a copied snippet
 * ------------------------------------------------
 * The first attempt at this fix edited one fake and left the test suite green, because a
 * second fake existed in another file and the tests were using that one. A rule that has to
 * be remembered in several places is not a rule; the next person to add a fake will not know
 * it exists. So every fake that stands in for `subagents.sendMessage` calls this, and a new
 * fake that forgets to is a fake that will not fail.
 *
 * What the real host does
 * -----------------------
 * Read out of `SubagentRuntime`'s continuations manager:
 *
 *   async sendMessage(sender, targetId, content, options) {
 *     if (this.ctx.agents.get(sender.id) !== sender) throw UNAUTHORIZED
 *     const act = this.activations.get(sender.id)
 *     if (act && act.handle.agent === sender && act.parentSession === targetId)
 *         return this.sendToParent(act, sender, content)                    // the crossing that works
 *     if (sender.session.header.parentSession === targetId) throw ...       // parent not resident
 *     return this.deliverToChild(sender, targetId, { delivery: 'steer' })   // else target is a child
 *   }
 *
 * and `deliverToChild` ends in `authorizeLineage(parent, childId, parentSession)`, which
 * requires `parentSession === parent.id` — it insists the addressed session is a child of the
 * sender. A sender that *is* the target therefore always fails.
 *
 * What is modelled here, and what is not
 * --------------------------------------
 * Only the child-to-parent crossing is admitted. Everything else is rejected with the host's
 * error code. That is deliberately asymmetric: a fake that also granted success would let a
 * caller believe a delivery happened that the host would have refused, which is the failure
 * this module exists to prevent. Deliveries the host performs by other means are therefore
 * *not* representable here, and a test that needs one must say so rather than be quietly
 * helped by a permissive fake.
 */

export const UNAUTHORIZED = 'UNAUTHORIZED'

/**
 * Decide whether the host would accept one `sendMessage`.
 *
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
export function judgeSendMessage(sender, targetId) {
  const senderParent = sender?.session?.header?.parentSession
  if (senderParent === undefined) {
    return {
      ok: false,
      code: UNAUTHORIZED,
      message:
        `subagent "${targetId}" delivery requires the exact live parent agent: ` +
        'the sender has no recorded parent, so it is not a continuable child of the target',
    }
  }
  if (senderParent !== targetId) {
    return {
      ok: false,
      code: UNAUTHORIZED,
      message:
        `subagent "${targetId}" belongs to another parent session: ` +
        `the sender's parent is "${senderParent}", not the addressed session`,
    }
  }
  return { ok: true }
}

/**
 * Throw when the host would refuse. Fakes call this before recording a delivery so that an
 * impossible delivery cannot be recorded as one that happened.
 */
export function assertSendMessage(sender, targetId) {
  const verdict = judgeSendMessage(sender, targetId)
  if (!verdict.ok) {
    const error = new Error(verdict.message)
    error.code = verdict.code
    throw error
  }
}
