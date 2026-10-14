# dsh-den

> A **7×24 resident personal assistant** for [DeepSeek Harness](https://github.com/deepseek-ai/dsh).
> Not another chat window — an assistant that stays on, keeps its own memory, works while you are away, and stops to ask before it acts outside your trust boundary.

Status: **the core is implemented, tested, and active in a real profile.** This line deliberately carries no test count: a hard-coded one rotted repeatedly (307, 309, 316, 319, 320, 322, 323, 326, 327 — each time while the suite was in fact green), and the last rot happened one round after a "fix". So the line states what is stable and `npm test` prints what moves. The plugin is loaded inside a real DSH 0.2.0-rc.2 desktop profile — it is in that profile's `dsh.profile.bundles`, and the running host reports it as `fiberPhase: active` — registering 16 model-facing tools, the approval guard, the heartbeat, and an interactive status panel. Verified against the *running* system rather than only in tests: the heartbeat ticks on its 60-second cadence, and the panel is an **active occupant** of both `sidebar.panellist` (`id: dsh-den.status`, order 245) and the `main` panel (`key: dsh-den.status`) — read from the live browser page through the host's read-only Slot inspector, not from the plugin's own registration call.

**Those live sentences were re-established on 2026-10-14 against the instance reporting `startedAt: 2026-10-14T02:10:43.000Z`**, whose own freshness verdict is `known: true, stale: false` and which loaded this tree 1000 seconds after its last source edit. `npm run verify:live` exits 0 against it and **all seven live probes pass**: the heartbeat ticks on its 60-second cadence, the route answers, an agent **cannot** obtain standing autonomy from the live host, the approval gate is the only path to authority, the expiry rule works in the host's own directory, scenario isolation holds against the same store the host reads, and disk evidence shows the `den_*` tools really were invoked. The earlier instance, `08:43:05.676Z`, is why this paragraph exists: after the panel fix landed at `09:24:00` it was still serving the previous panel while six live probes went on printing passes — each one run on its own, and each one describing code that was no longer on disk. Two things now make that state impossible to report as a pass. The plugin reports `status.freshness`: the newest source edit beside it against its own start, computed per request rather than cached at boot, with "cannot tell" as its own answer instead of a healthy default. And every live probe script is chained behind `tools/require-fresh-host.mjs`, which refuses to run it when the instance is stale or cannot say.

**The panel change is verified by what the page asked for, not by pixels.** At `09:52:28` — 141 seconds after that boot — a `panel-autonomy-requested` event reached the route carrying a **real conversation id**, `session-95cc8a8d-…`. The previous panel had no conversation to pass (resolving the active session *was* the defect, and it passed `null`), and the host is confirmed to be running the new code, so only the dock can have sent it; the probe's own requests are identifiable by their literal session ids (`live-autonomy-probe`, `grant-bypass-probe`). Two independent facts — the host loaded this tree, and a request only the dock can make arrived — are firmer evidence than a screenshot, and a screenshot is still not claimed.

**The panel was taking most of the screen, and that was a design error rather than a layout one.** The dock above the message box rendered the entire self-check creation form — title, prompt, interval, submit — permanently. It was there for a reason: the dock is the one seat the shell hands a real conversation to, and `schedules/create` refuses without one, so the form had to live somewhere a conversation exists. But the *capability* needs a conversation; it does not need to be on screen. The dock is now one line of state — autonomy, its two controls, and a one-line `New` disclosure — and the empty state names the cheaper path: say «check CI every 30 minutes» in the conversation and the den adds it. That this is small is machine-checked rather than asserted: `tools/check-client-interaction.mjs` requires the dock to render **zero** inputs and no submit button until the disclosure is pressed (it rendered three inputs and a submit button before), then checks that the form still sends the same payload once opened. The logic is the one the reference assistants this project is measured against are built on — state at a glance, one thing at a time, and the human talks instead of filling in forms — stated as a reading rather than a quotation, because this plugin's own gate keeps `web_fetch` fail-closed in a profile with `approval: never`, so those pages were not readable from inside this session.

**The admitted wake happened — at the first heartbeat after the self-check came due.** On 2026-10-14 the panel minted a request, that token came back as a **human message**, and `den_set_autonomy` recorded `{ok: true, autonomy: true, boundToMessage: "b7b68b9f-…"}` for `session-95cc8a8d-…`. A self-check was then created with the 300-second floor; it came due at `02:34:26`, and the next tick — `02:34:43`, one cadence later — spent a turn and spoke: the ledger went `turns 0 → 1`, `spoken 0 → 1`, `notices 1`, and the trigger was consumed. The host recorded the event itself, `{"type":"wake-spoke","triggerId":"76e58cc0c47ef5…"}`, and `npm run drill:after` returned `RESULT: PASS` (exit 0) behind a guard that had just confirmed the instance loaded this tree. Three details make it more than one successful run. **The same call used to be auto-refused**: the gate audit still lists historical `den_set_autonomy → unknown-tool → ask` entries from the instance before the fix, and the successful call is absent from that list — it was classified as the den's own tool. That classification is the fix described in [`DESIGN.md`](DESIGN.md) §2.28–§2.30: the approval policy in this profile is not its own switch but a side effect of the permission preset (`danger-full-access` implies `approval: never`, where a gate `ask` means *never*, not *later*), so for a while every den tool that was not read-only was unreachable — memory, self-checks and authority alike. The answer was to classify den's own tools as its own, each with a stated bound, rather than to weaken the credential, shell and outbound rules above that table; those rules still refuse this session's own calls when they should. **The counters are read separately on purpose**: `turns` is charged after delivery and `spoken` only when the wake actually says something, so a wake that was admitted and judged not worth saying would have shown `turns 1, spoken 0` and failed the drill; both moved, so this was a wake that *spoke*. And **the grant is bound to a message**, not to a click: `boundToMessage` names the human message that carried the token. What is still only verified offline: a wake *after a restart*. Triggers, grants and the ledger all live on disk and survived the restart that moved this host to `02:10:43`; `test/cold-start.test.mjs` grants through the real token, stores a trigger, moves the clock past a restart and watches the wake fire — but the joined event (restart, then a wake) has not been observed live, and neither has its negative (a due trigger with no authority staying silent). Both need a human act, and `npm run drill:before` / `npm run drill:after` is how either would be measured. [`DESIGN.md`](DESIGN.md) §2.35 has the event chain and both gaps; §2.34 is the defect this drill found in itself the first time it ran for real.


**The wake spoke and nobody was told — the defect a reader of this panel found.** The page reported `Pending notices 1 / 1` and `Today's self-initiated turns 1` while the human had received nothing, and the strip above the message box still offered a **spent** token with the instruction to paste it. Both had the same shape of cause: a surface reporting state it had no way to update. `pendingNotices` knew only "deliverable" and "expired", so a notice that had been shown could not stop being pending — the count could never reach zero — and the wake's own implementation queues its text (`queueNotice`) with no human-facing surface rendering it: the count said *something happened* and nothing said *what*. The fix is at both ends. A notice carries `deliveredAt`, only an explicit acknowledgement sets it — inferring "delivered" from a render would make the count lie in the opposite direction — the status snapshot carries the pending **text**, the dock renders it where the human already looks, with a `read it` control, and the minted token is shown only while it is still an unspent invitation. [`DESIGN.md`](DESIGN.md) §2.37 has the measurement and the two-sided fix; both halves are pinned by tests that fail if either is missing.

**And it reproduces from this repository alone.** A fresh `git clone` of the published repo — no `node_modules`, because the package declares **no dependencies at all** — runs the whole suite green:

```
node_modules present in clone: False
dependencies declared: (none)
ℹ tests 326   ℹ pass 326   ℹ fail 0
test exit: 0
```

The four files the residency work added were looked for in that clone by name — `src/resident.js`, `test/resident.test.mjs`, `test/two-process.test.mjs`, `test/support/resident-child.mjs` — because the failure this proof exists for is a source file that is on disk, is imported by the code, and never made it into the repository. A bare `lib/` in `.gitignore` did exactly that once, and every local test passed while the pushed repo was broken.

That is the claim worth making precisely: not "it works on my machine", but *a third party with a Node binary and nothing else can check this*. `npm run check:source-tracked` asserts it on every run: every source file on disk is tracked by git, and the ignore rule that hid one is named.

**A transcript is not bookkeeping.** The number above was once edited from 240 to 241 to 252 across three commits while the last actual clone run had printed 237 — a public claim with no command under it, which is the defect this repository keeps finding in its own work. The number now comes from a run at the pushed commit, and the way to keep it that way is to re-run the proof rather than update the count.


**The wake delivery path was broken and is now fixed — that history is worth reading, because the test suite was green throughout.** The plugin delivered wakes with `subagents.sendMessage(agent, trigger.sessionId, …)`, where `agent` is the *target conversation's own driver*. The host admits a send only when the sender is the target's direct parent or direct continuable child — `authorizeLineage` requires `parentSession === parent.id` — so the call asked a session to be its own parent and **every admitted wake in production died** with `delivery requires the exact live parent agent`. Five tests covered that path and passed, because the fakes granted any delivery at all: the double was lying about the *calling convention*, not the service.

Delivery now goes through `Agent.followup`, which the host documents as *"queues an ordinary next-turn prompt and wakes the driver"* — `send(message, 'next-turn', true)`, splicing into the inbox and opening a turn boundary. No lineage is involved, the wake is visibly a queued turn in the conversation, and it durably becomes a `user/message` that the reply read-back pairs with the assistant's answer. `subagents` is no longer read anywhere.

**The delivery surface is now verified on the running host, not just in the harness.** `npm run check:wake-api` asks the live Host what it actually offers and reports:

```
PASS — the agents service exposes get()
PASS — the agents service exposes resume()
PASS — `followup` is absent from the service contract, as expected
PASS — a live agent was found and identified
       id: session-95cc8a8d-a3e9-4e2a-a67d-12292d17ba24
PASS — the live agent carries a callable followup()
       this is the capability the delivery path needs, measured on the running Host
RESULT: PASS — 8 checks, and the delivery surface is the one this Host actually offers.
```

That check exists because the defect it guards against was an *assumption about an API*, and it is placed where the assumption can be measured: `agents.get`/`agents.resume` are declared to return `Agent`, and `Agent` is declared as `{ readonly id }`. `followup` appears in no service signature — it is a method on the live agent object the factory builds — so the surfaced contract is narrower than the runtime object and no amount of reading signatures answers "will delivery work on this Host". The probe reports `sawLiveAgent: false` rather than a pass when no agent is live: *I could not look* is not *it is not there*.

**What is still outstanding is one human step, not a defect.** No admitted wake has ever been delivered, because admitting one requires standing autonomy and no human has granted it. That single drill is the last unverified path in the project; everything on either side of it is measured. See `DESIGN.md` §2.7 for the code evidence and §2.8 for how the fakes were made to stop hiding it.

**Capability 4 is verified end to end, and the way it was verified is the point.** The gate's secret rule matches on *path*, and it is installed as `ctx.tools.guard`, so it intercepts every tool call in the profile — including the assistant's own. That makes a zero-risk live test possible: read a credential-shaped path **that does not exist**. If the gate works the call is refused before the filesystem is touched; if it does not, the result is `ENOENT` and nothing leaks.

```
Error: refused: this would pull a stored credential into the conversation (credentials-yaml)
```

That sentence is `src/gate.js` verbatim, and the host's own service event stream recorded the decision alongside it:

```json
{"type":"gate","tool":"read","rule":"secret:credentials-yaml","risk":2,"decision":"deny",
 "sessionId":"session-95cc8a8d-a3e9-4e2a-a67d-12292d17ba24"}
```

Two more entries in that stream corrected a misattribution of my own: `outbound:curl-upload` and `outbound:recursive-delete`, both `ask`. Two tool calls I had reported to the user as *"the user rejected it"* were in fact denied by **this plugin's own gate** — classified `ask`, and a host without an approval facility turns `ask` into a denial. The gate had been shaping the session the whole time.

**Later, on 2026-10-14, the loopback half of that first rule was allowed through — and only that half.** Asked about the boundary, the human answered "只放行本机", so `decide()` now returns `allow` for an `outbound:` rule whose destination is a *named* loopback host (`127.0.0.1`, `localhost`, `[::1]`, with or without a port). Three bounds keep that permission as narrow as the sentence that granted it: the rule must be an `outbound:` one, the destination must actually be written out — a missing or unparsable destination still asks, which is what stops text that merely *mentions* an upload from travelling as permission — and the exception sits **after** the deny branch, so an allowed destination can never rescue a denied action. The argument that made the rule fire on both halves (a loopback service can relay) has not been disproved; it is now recorded as the human's call rather than the plugin's. [`test/gate-loopback.test.mjs`](test/gate-loopback.test.mjs) pins every one of those bounds by calibrating against the gate's own thresholds instead of copying them.

The same evidence exposed a defect worth naming, because it is a whole class rather than a slip: `onDecision` announced decisions through `noteEvent` (the in-memory ring the panel shows) and **never called `recordAudit`**, while `gateAudit()` read `gate-audit.json` — a file no code wrote. So the panel's gate surface reported *"no decisions"* permanently, including while three real ones had just been made. `recordAudit` was dead code and the durable-audit design had never run once. **Reading a file that is never written looks exactly like a gate that has never fired.** The seam is now fixed and pinned from both ends — the service reader *and* the file on disk — because asserting only through `gateAudit()` would pass if reader and writer were the same piece of memory.

**And the fix is now observable in the live profile, from a later process than the one that wrote it.** After the restart the file exists and holds exactly the refusals this session provoked:

```json
{"at":1791868057296,"tool":"den_set_autonomy","rule":"unknown-tool","risk":1,"decision":"ask","sessionId":"session-95cc8a8d-…"}
{"at":1791868277929,"tool":"plugin_manager","rule":"unknown-tool","risk":1,"decision":"ask","sessionId":"session-95cc8a8d-…"}
```

Three things are true of that file and all three were only design intentions before: the reader has a writer, the record **outlives the process that made it** — so *"why did it refuse?"* is answerable after the fact and not only while the ring happens to still hold it — and the entry carries the tool, rule, risk, decision and session but **not the arguments**, so the audit does not become a second copy of whatever the gate was protecting. `plugin_manager` is in there as well as the den tool: the gate intercepts every tool call in the profile, not only the ones belonging to the plugin that installed it.


**And the state really did cross a restart, measured on the running host rather than argued.** The plugin's own status payload carries when *this* instance last loaded the plugin; the state file carries when it was first written. On the live host those two disagree by roughly an hour, in the direction that proves the point:

```
state.createdAt   : 2026-10-13T01:49:11.717Z    ← written by an earlier boot
plugin startedAt  : 2026-10-13T02:56:33.794Z    ← this instance (pid 36704)
```

So a previous life wrote that file and this one read it back: the assistant came back up **on its own**, with its configuration intact and no human involved. That is the persistence half of capability 2, and it is the half that does not need anybody's permission.

Getting there required fixing the field that was supposed to say so. `stateSurvivesRestart` was computed *inside* `status()` as `readJson(statePath) !== undefined` — evaluated long after the boot had written that very file — so it was `true` on a first-ever boot of a machine that had never been restarted, while the comment above it claimed it *"cannot overstate what survived a restart"*. It had already been cited as proof: `tools/check-acceptance.mjs` asserted `true` on a first boot into an empty home, under a check named *"boot persists state"*. It is now sampled **before** the boot claims the tree, where the answer could still be no, and `stateCreatedAt` ships alongside it so a reader can confirm the claim instead of trusting it. The acceptance block already boots twice, so the fix made that check strictly stronger: it now observes a real `false → true` transition. The reusable rule, at three instances of this class: **a field named for a past event — survived, recovered, delivered, refused — must be sampled at a moment when the event could still not have happened. Sampled later it degrades from measurement to constant, silently, and reports `false` with a straight face.**

**The live profile now shows the difference between the two versions in one payload.** On the instance that started at `05:06:55.290Z`, `stateCreatedAt` is `1791856151717` — about 3.3 hours *earlier*. So `stateSurvivesRestart: true` is a comparison against this instance's own boot rather than a constant that happened to be right, and the field that used to be absent is the one that makes the claim checkable. That absence is also how the previous build was identified as stale while the host was still serving it.



**The running host was serving an older build; it has since been restarted, and the same check that said so now says otherwise.** Before the restart, the `Tool` inspect provider reported a different tool count from this tree's source and `GET /dsh-den` answered 404. Afterwards, `npm run verify:live` reports:

- `GET /dsh-den` → **200** with a well-formed envelope
- `state.json` **written by this boot**, containing `cooldownSeconds`, `createdAt`, `dailyTurnBudget`, `displayName`, `quietHours`, `tickSeconds`, `updatedAt`, `version`
- **11 tools** through the `Tool` inspect provider, byte-for-byte the same names this tree registers
- `transport.browserReachable` **set** — a real browser reached the panel route, which is the one seam that had never been observed

The live status payload then reports the assistant actually running: `kernel.running: true`, `kernel.lastError: null`, a fresh `lastTickAt`, `gate.mounted: true`, and a ledger file on disk with `turns/spoken/skipped/refused` at zero. A scripted drill over the same real socket confirmed the write path end to end — `autonomy/request` minted a 32-character token, `schedules/create` → `schedules/list` → `schedules/delete` round-tripped, and a 10-second interval was correctly refused with `everySeconds must be at least 300`. Everything the drill created was deleted; `~/.dsh/den/triggers/` is empty again.

**A later restart brought this round's fixes live, and the check that had been failing for three rounds turned green.** The deployment check had been reporting `the running instance loaded this tree ... the host is running code older than this tree` since the lease work landed; the host reloaded at `2026-10-13T08:43:05.676Z`, later than the newest source edit (`triggers.js`, `08:39:32.676Z`), and it now passes. What the payload shows that the previous build could not:

- **`residency` exists** — `{held: true, instance: "7969f300…", pid: 34336, staleMs: 180000, holderSince: …}`. On the build before this restart the key was **absent**, so this is the lease code actually running, not a claim about it.
- **`reapedNotices: 0`** — the field added with the notice sweep, present and answering.
- **11 `den_*` tools** through the `Tool` inspect provider, matching the source one for one. The deployment check names this as the thing it *cannot* see from where it stands, so it was queried directly.
- **A browser reached the route** at `08:52:58.246Z`, predating the verification run — the panel polling from the real page.

`npm run verify:live` → **exit 0**, and **all thirteen `check:*` scripts** → exit 0 against the running host, including the six live ones: `deployment`, `autonomy`, `notices`, `memory`, `tools`, `wake-api` (8 checks), plus `grant-bypass`, `bundle`, `ui`, `acceptance`, `package`, `install`, `source-tracked`.

**The assistant speaking on its own has not happened, but the reason is measured rather than assumed — and the boundary turns out to be structural.** `autonomy` is `null` with `autonomyKnown: false`, because no human has granted it.


The refusal is deliberate and traceable to one line each in three files:

- `src/gate.js` keeps every durable effect on the default tier and says why in a comment: *"`den_set_autonomy` is a privilege change."* `den_status`, `den_recall` and the other read-only tools are `allow`; this one is not.
- `den_explain_gate` on the running host reports `verdict: "ask"`, rule `unknown-tool`.
- `src/gate.js` also states the consequence of a host without approval support: *"a missing approval facility turns `ask` into a denial, which is the correct fail-closed direction."*

This session has approval prompts disabled, so `ask` resolves to a denial. **The agent side of this path is therefore closed by construction, not by operator error**, and calling `den_set_autonomy` from an agent turn cannot succeed here at all. The panel is not an alternative: its grant control mints a *request* and says so in its own copy — *paste this token to the assistant in the conversation* — and `autonomy/confirm` resolves a live conversation before it looks at anything else.

**That is no longer an argument from the rule table — it has been attempted, on the live host, from the conversation itself.** The assistant called `den_set_autonomy` with `autonomy: true` on the running system, and the plugin's own gate stopped it and wrote down what it did:

```json
{"type":"gate","tool":"den_set_autonomy","rule":"unknown-tool","risk":1,"decision":"ask",
 "sessionId":"session-95cc8a8d-a3e9-4e2a-a67d-12292d17ba24"}
```

That `sessionId` is the session the attempt was made *in* — not a probe standing in for one. After the refusal the same status payload reports `autonomy: null` and `grants: 0`: **the privilege change did not happen, and the agent could not make it happen.** Earlier rounds could only cite `den_explain_gate`, which reports what the gate *would* do; this is the gate doing it to a real call.

It also settles a question the docs had been vague about: **the `den_*` tools are callable by the assistant's own turns** — `den_status` works from the conversation — so this was not a hypothetical attempt from outside the trust boundary but the assistant reaching for its own authority with every capability it actually has.

### Granting authority to a running instance, step by step

The negative half of capability 1 is demonstrated above. The positive half needs a person, and there is no way around that: the agent can mint a token, can cite any message id, and can write to the whole tree, but **it cannot author a `user/message`**, and that is what the grant is bound to. To reproduce it:

1. Set the session's approval policy to `ask`. It is per-agent — `approval.setPolicy(agent, 'ask')`, the counterpart of the `'never'` this session starts with (see the contracts below) — and the Host reports the change in the model's own runtime context, so the assistant can tell the switch happened rather than inferring it. With the policy at `never`, `ask` resolves to a denial and `den_set_autonomy` is refused automatically, which is the correct fail-closed behaviour and also why an approval-disabled session can never complete this flow.
2. Open the den panel and use its grant control. It mints a single-use, 10-minute token and shows the instruction: *paste this token to the assistant in the conversation*.
3. Paste that token into a message. The token is the whole point of the step — anything the agent could produce on its own would prove nothing.
4. In **the same turn**, the assistant calls `den_set_autonomy` with `autonomy: true`. It does not need the message id: the den finds the human message in the current turn that quotes the token, and that lookup is stricter than the id path because it requires the token.
5. Approve the tool call rather than letting it be denied. The grant is written and bound to that message.

**Telling a person apart from a probe in the event log.** A panel grant carries the conversation id, because the panel scopes its request to the active conversation; a route probe carries a synthetic id, or none at all if it did not bother. That distinction had to be made explicit rather than left to the reader: `check-live-grant-bypass.mjs` used to mint with no session, leaving `{"type":"panel-autonomy-requested","sessionId":null}` — an entry a person clicking Grant could equally have left. It now signs its own requests with a synthetic id and asserts that it did, because **a probe whose footprint a human could have left makes the log lie about who acted.**

So authority needs a human in the loop twice: the token must be cited in a real human message, and the resulting tool call must be approved rather than auto-denied. That is capability 1 in its strongest form — the agent cannot manufacture its own standing autonomy even with write access to the whole tree.

**What the refusal looks like on the running host.** A `once` trigger was created due immediately, with no grant anywhere. The real kernel picked it up on its next heartbeat and recorded, in its own event log:

```json
{"type":"wake-refused",
 "triggerId":"bc83e334…",
 "gate":"authority",
 "reason":"no standing autonomy from a direct human request",
 "hadSession":false}
```

with `ledger.refused` incremented and the trigger's `fireCount` left at `0` — so the intent survived rather than being consumed. That is capabilities 1 and 2 together, end to end, on a real host: **the autonomous wake ran, and the authority gate stopped it for the stated reason.** The drill's trigger was deleted afterwards and `~/.dsh/den/triggers/` is empty.

**Two production defects came out of that drill, and are fixed.** The refusal record appeared twice, exactly sixty seconds apart, which is what exposed the first: the refusal path never throttled, so a permanently unauthorized trigger was re-evaluated on *every* heartbeat — 1,440 log entries a day for one `once` trigger. The second came from writing an assertion that `tick()` has one return shape: the idle branch omitted `results` and the busy branch omitted `woke`/`spoke`, so `tick().results.length` threw on exactly the quiet ticks that are the common case. Both fixes are in `src/kernel.js` with regression tests in `test/cold-start.test.mjs`, each verified by reverting it.

The remaining unverified step is the *admitted* wake and the long unattended run. Both need a human to grant autonomy.

**The authorization flow has a dry run on the running host, and it refuses correctly.** Every step below was exercised over the real route:

1. `autonomy/request` → `ok: true`, a 32-character token, and an instruction that states the design in one line: *call `den_set_autonomy`, `autonomy=true`, `humanMessageId` with this message's id, and cite token …*. It creates **no** grant.
2. `autonomy/confirm` with that token but no human evidence → `ok: false`, `DEN_ACTION_FAILED`, *"no live conversation for this token: autonomy is granted per conversation"*.
3. Repeating the failed confirm → the **same** refusal, so the failure did not spend the token.
4. `status` afterwards → `autonomy: null`, `autonomyKnown: false`. Nothing was created.

Step 2's message is specific rather than generic because `autonomy/confirm` resolves the conversation itself and refuses before it looks at the message id — so a synthetic session stops one layer earlier than a real one would. That is why this dry run proves the transport and the refusal, and *not* what a valid confirmation does. The valid case is the one awaiting a human.

**That the plugin is live is proven from disk, not asserted.** `npm run check:tools` reads the persisted session logs and pairs every `tool/call` record with its result — a call *attempt* is not evidence, because a model can name a tool that was never registered and the attempt is still logged; only a result that is not an `unknown tool` error proves the tool existed in that session's set. Verdict on the live profile: **proven for `den_remember`, `den_schedule_check` and `den_status`**.

**What is observed, and what is not.** For several rounds this section said the panel had *never* been verified in a real browser, and that was wrong — not the verification, the claim. The host exposes a read-only Inspect provider that queries the **page the user actually has open**, and it answers:

```
sidebar.panellist occupants  ->  { registrant: "dsh-den", id: "dsh-den.status", order: 245, active: true }
main occupants (keyed)       ->  { registrant: "dsh-den", key: "dsh-den.status", active: true }
```

That is the panel mounted in a real browser, on both slots this README claims, read from the live page rather than from the plugin's own registration call. The remaining unknown is narrower than "does it work": it is the rendered text and the click path — `Slots` reports topology, not pixels, and no browser automation is reachable from inside this profile (the GUI's shell requires the token `dsh web` printed, and the WebBridge route needs a body upload that this plugin's own outbound rule escalates). `test/roundtrip.test.mjs` still carries the request bytes, the response bytes, and the payload the panel receives, in one process.

**Reachability is now attributable, not just stamped.** `transport.browserReachable` is one timestamp, and a deployment probe and a panel that polls every fifteen seconds produce the same one. The route therefore records every request and keeps what the newest caller *said about itself* — `transport.lastRequest` carries the user-agent, origin, and referer verbatim, plus `requestCount`. Verbatim rather than classified, because a label would be the plugin's opinion about who called, and the point of keeping it is to let the reader decide. First contact still never moves: `firstReachedAt` is stamped once and stays.

---

## Why this exists

The difference between an assistant and an agent is not model quality — it is **duty cycle**.

A normal agent is *"you ask → it works → it stops."* A resident assistant is *"it is still there, it has its own memory and its own limits, it finds work when you are not looking, and it comes back to you before it sends, spends, or deletes anything."*

Four things have to be true at once, or the thing is unsafe or unbearable:

| | Capability | Without it |
|---|---|---|
| 1 | **Standing autonomy bound to a real human request** | 7×24 means "an unattended script with your credentials" |
| 2 | **Self-wake across restarts** | "Always on" ends at the first process restart |
| 3 | **A speak-only-when-it-matters gate, with expiring notices** | It pings you every 30 minutes and you uninstall it |
| 4 | **An outbound approval gate it cannot talk its way past** | "It can send email and spend money" is not a sentence you can say |

## Design rules this project inherited from real incidents

These are hard constraints, not aspirations. The reference implementations below each paid for one of them.

1. **Autonomy is granted only by a direct human request**, and the grant is bound to the *host-attested* session event that carried it. Timers, automatic continuation rounds, subagents, and scripts can never grant or revoke it.
2. **A timer is not a permission.** Every self-initiated run re-checks current authority, because the grant may already have been revoked. Revocation always beats automated re-arming.
3. **A notice has a shelf life.** Observation and reminder notices expire after 12 hours and are then *deliberately not delivered*. One recorded incident had calendar reminders queueing for 37–80 hours while their session was offline, then firing long after they mattered — **a reminder delivered too late is worse than one never delivered.** Ideas are exempt. *And the other direction had to be measured too:* because deduplication was decided by whether a file with that name existed, an expired record — which is still a file — silenced the same observation made again **permanently**, while `queueNotice` reported success. The guard is now "is an identical notice still *deliverable*", a dead record (expired or unreadable) is replaced rather than treated as a duplicate, and nothing had ever deleted a notice file, so an expired one is now reclaimed at boot and reported as `reapedNotices`.
4. **Failure degrades, it does not throw.** A missing, stale, foreign, or corrupt authorization record resolves to "not authorized". Throwing would turn one bad file into a denial of service; trusting it would turn one bad file into a privilege escalation.

## Implemented so far

| Module | What it does |
|---|---|
| `src/atom.js` | Crash-safe JSON persistence: atomic publish, fsync barriers, content-addressed "publish once", validation-gated reads. Directory fsync degrades gracefully where the platform forbids it (Windows). |
| `src/grant.js` | Human-bound standing autonomy. Verifies the grant against the immutable session log; refuses to record authority for a caller that is not a live direct human driver. |
| `src/notices.js` | Durable notices with a 12-hour expiry for observations, no expiry for ideas, and content-hash deduplication. |
| `src/triggers.js` | Schedule definitions (`once` / `interval` / `daily` / `weekly`) with a 300-second interval floor, a bounded prompt, and a schedule-shape validator: a stored trigger missing the fields `nextTriggerAt` reads is reported **invalid** rather than listed as healthy and never firing. Downtime does not replay a backlog, but it does not preserve the grid either — the cadence re-anchors to the wake that actually ran (measured at 170 minutes of phase shift after a three-hour outage on a five-minute interval). A wake that was admitted but never reached the conversation is **retried** (15-minute throttle) instead of being charged and lost. |
| `src/kernel.js` | The heartbeat and the four gates: **authority → budget → quiet → pacing**. Re-entrancy guarded, every refusal recorded in a durable daily ledger, and the cadence advance committed only *after* a wake is delivered. |
| `src/memory.js` | Scenario-isolated long-term memory: one file per scenario, so personal context is structurally unable to surface while working in another domain. Deterministic keyword-plus-recency recall, no embeddings, corruption degrades to an empty store. Only the 200 **newest** entries are scored — ordered by `createdAt`, not by file position, because `remember` refreshes a re-learned fact in place; the window is not hidden, so `den_recall` returns `stored` / `considered` / `scored` and `stored - considered` is what it left out. |
| `src/gate.js` | The outbound approval gate: credentials refused, outbound actions questioned, unknown tools fail closed. Installed as *both* a pre-execute listener and a monotonic guard, and every tool this profile exposes is classified explicitly — an unlisted tool that falls to the fail-closed default becomes an automatic rejection wherever prompts are disabled. |
| `src/panel-api.js` | The panel's action surface: the status snapshot and the nine named actions, with no transport in them. Read-only actions and authority-changing ones are deliberately separated — see below. |
| `src/panel-route.js` | One prefix route on the host web server at `/dsh-den`, exposing that surface as JSON. The same shape every other client plugin in this profile uses. |
| `src/client/client.js` | The browser half: a hand-written lazy-CJS bundle with no build step, registering the sidebar entry and the panel, and reaching the host with the browser's own `fetch('/dsh-den')`. Grants nothing on its own. |
| `src/freshness.js` | Whether the running instance loaded the tree beside it: the newest source edit against `startedAt`, with "cannot tell" reported as its own answer rather than as fresh. |
| `src/index.js` | Plugin entry point, sixteen model-facing tools, and the wiring. Zero external imports. |

All state lives in a **self-contained** `$DSH_HOME/den/` tree, so it can be packed and moved to another machine or a server without hunting through unrelated DSH storage.

```bash
npm test          # unit + integration tests (the run prints the count)
npm run check:bundle   # 31 offline bundle-contract checks
npm run check:ui       # 54 panel interaction checks
npm run check:acceptance   # the two reliability goals, as one observable lifecycle
npm run check:package      # what a tarball install actually ships (static, offline)
npm run check:install      # packs a real tarball, installs it, loads what was installed
npm run verify         # all six, hermetic, no host required

# these three need the running host instead of a fixture, so they are not in `verify`
npm run verify:live    # after a restart: is the host serving this tree? (fails if it loaded older code)
npm run check:deployment   # just the deployment half of the above
npm run check:tools        # disk evidence that den_* tools were really invoked
npm run drill:before       # the admitted-wake drill, frame one: after a restart, before granting
npm run drill:after        # frame two: after the grant and once a self-check has come due
# every live probe is chained behind `require-fresh-host.mjs`, which refuses to run it against an
# instance that loaded older code — or that cannot say — so no pass can describe a tree the host
# never loaded. `check-deployment` is exempt: it is the measurement itself. The two drill frames
# are chained for the same reason: they read the running host's ledger and draw the last
# conclusion of this project from it.
```

**`check:package` and `check:install` answer different questions, and both are needed.** The first reimplements npm's `files` rules so it can run offline — it answers *would these files ship?* The second runs `npm pack`, extracts the tarball into a directory with no access to this repository, and brings the plugin up from there — it answers *does what ships actually work?* Since the objective is a plugin that is **installed** on a real host, installability is a claim worth testing rather than assuming. It deletes its temp directory in a `finally`, including on failure.

**After restarting DSH, run `npm run verify:live`.** It is the scripted form of the acceptance this project is judged on, and it refuses to report success while the host is still running an older build. It first runs the deployment check as a falsification step — if `GET /dsh-den` is not 200, nothing after it would be evidence about this tree, so it stops.

**The one claim that cannot be scripted is scripted in two halves instead: `npm run drill:before`, then `npm run drill:after`.** The admitted wake needs a human act — a message carrying a panel-minted token — so the drill cannot be a single command, but it can refuse to be a story. `--before` records the running host's own numbers (authority, heartbeat, residency, triggers, and the ledger's `turns`/`spoken`/`skipped`/`refused`) to `~/.dsh/den/drill-frame.json`; `--after` re-reads them and draws a verdict that fails unless **both** counters moved, because `turns` is charged after delivery while `spoken` is charged only when the wake actually speaks. It also fails, by name, on the trap in the middle: **a grant alone wakes nothing** — authority is permission, not a schedule, so a drill with no self-check due can wait forever and would otherwise be reported as "no wake was delivered", which is true and useless. That verdict is a pure function with seven offline cases (`test/drill-live-wake.test.mjs`), tested before it is ever read from a live host.

**The browser seam needed a timestamp, not a better intention.** The script used to claim "a browser request has already reached the route" by reading `transport.browserReachable` — but step 1's deployment probe is itself a `GET` to that very route, so the field it read had been set by the script's own traffic, and it reported that as a browser having arrived. It now records when the run started and only counts a reach that *predates* it; anything newer is reported as unattributed. `check-deployment.mjs`, which cannot know when its caller started, no longer says "browser" at all — it says some HTTP request has reached the route, which is all the field can support.

**"The running host is serving this tree" is a claim that has to be earned twice, and the second half was missing.** Comparing the Host's tool names against the names in `src/index.js` catches a *different build* but not a changed *behaviour* — editing a handler does not rename a tool, so a host running last week's delivery path or last week's grant path still lists this week's tool names and passes. The check now also asks whether the running instance loaded after the last source edit, using the `startedAt` the plugin already reports as the moment the Host loaded these modules:

```
FAIL the running instance loaded this tree
  the instance loaded at 2026-10-13T02:56:33.794Z but index.js changed at 2026-10-13T04:02:16.393Z
  — the host is running code older than this tree, so restart DSH before believing anything below
```

That is the honest verdict while an edit is pending, and it means `verify:live` now stops instead of proceeding to describe a tree the host is not running.

`npm test` includes one test that is unlike the rest: `test/roundtrip.test.mjs`
drives the **real** browser bundle's `call()` against the **real** route handler the
plugin registered, in a single process. It exists because a test double is written
from the same assumption as the code it stands in for, so it cannot falsify it — the
way this plugin shipped three different wrong transports while every checker passed.
The only pieces not running in that test are the socket and the browser, and the file
says so.

### The panel is a control surface, not a read-only view

A view you cannot act from is a diagnostic. So the panel carries verbs — but the
authority-changing one is deliberately routed around itself, for a correctness
reason rather than caution:

> Standing autonomy is only honoured when the four gates run, and the authority
> gate reads a grant **bound to a human message id**. A grant written without one
> makes `den_status` report "granted" while every self-initiated run is still
> refused. The panel would show a green light over a dead circuit.

So `autonomy/request` mints a **single-use, 10-minute token** and reports it. The
human carries that token into the conversation, and the grant is then enforced by
**two independent factors**: the token must appear **in the text of a human message
in the current turn**, and the tool call itself must be approved rather than
auto-denied. The token also *identifies* the message — `humanMessageId` is optional,
because a model driving a tool call has no reliable way to know message ids, and
that lookup is *stricter* than the id path since it requires the token. An agent can
mint a token on demand and can cite any id it likes, but it cannot author a
`user/message`, so it cannot manufacture the evidence. A refusal does not spend the
token. Schedules are a different risk class and are written directly, because a
schedule is explicitly *not* a permission grant: every run still re-checks
authority, budget, quiet hours and pacing.

The panel also reports a **deferred heartbeat** as a problem rather than as
silence. That matters more than it sounds: an earlier version treated a missing
delivery path as a permanent verdict, so the heartbeat never started and the only
trace was one event — the assistant was not resident while its status looked
healthy. It now retries, reports its progress, and records when it recovers or
gives up.

### Verified Host contracts

These were read out of the running Host rather than assumed, and two of them changed the implementation:

- **Approval is a per-agent session policy, and the model is told when it changes.** `export type ApprovalPolicy = 'ask' | 'never'`, applied with `approval.setPolicy(agent, policy)` — *"switch one live agent's policy and queue the transition for its next model step"* — and read back without applying the default via `approval.overrideOf(session)`. The service description says it *"exposes deterministic policy changes to the model through the runtime-context snapshot and switch notices"*, which is why an approval-disabled session announces itself in the model's own context rather than only in a log. `approval.request` returns `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`, where **`'allowed-once'` is the only grant** and a missing or throwing answerer normalises to `'unavailable'` — fail-closed at the Host level, not only in this plugin. This is the contract that decides whether the human-grant flow can complete at all, so it is recorded as a measured fact rather than inferred from behaviour.
- `@deepseek-ai/cordis` is **not resolvable** from a profile's `node_modules`. A plugin that imports it fails to load, so `dsh-den` uses only the injected `ctx`.
- Reading `ctx.<service>` for a service that is **not** named in `export const inject` throws `cannot get property "<key>" without inject`, and `apply` never runs. The convention, confirmed against two released plugins: injected services are read as **properties** (`ctx.tools`), while `ctx.get(...)` is reserved for deliberately optional, undeclared services.
- `PreToolDecision.displayReason` is a **localised object** (`{ en: string, [locale]: string }`), not a string. `info` exists only on the `deny` branch.
- `ToolExecution.agent` is **optional**; `signal` is required.
- `agent/status` carries exactly `'idle' | 'running'`, and `.status` is the state *just entered*.
- `ctx.tools.guard(...)` is documented as **monotonic**: no guard can force-allow what another guard denied. That is why the hard rules are installed there and not only on the waterfall.
- ASAR note for anyone reading the shipped packages: the archive contains **no `.d.ts` files at all**. The only verbatim TypeScript declarations live in the generated `dsh-tool-cordis/lib/types/api-catalog.js`.

## Roadmap

**Live verification is tied to an instance, not to a date.** The results below were produced against one running Host — `pid 46900`, plugin instance started `2026-10-13T05:06:55.290Z` — and they are only claims about that instance. A later edit makes them stale by construction, which `tools/check-deployment.mjs` now detects by comparing the instance's `startedAt` against the newest source mtime, so "the tests pass" and "the host is running this tree" stay separate statements.

| probe | result on that instance |
|---|---|
| `check-live-autonomy` | PASS — an agent cannot obtain standing autonomy from the live host |
| `check-live-grant-bypass` | PASS — attacked twice with a real token and the live session id; refused both times, `autonomy=null`, `grantFiles=0` |
| `check-live-notices` | PASS — 8 checks; the expiry rule holds in the host's own directory, and a dead record no longer silences the same observation |
| `check-live-memory` | PASS — scenario isolation holds and the host reads the same store |
| `check-wake-api` | PASS — 8 checks; the live agent carries a callable `followup()` |
| `check-tools-live` | PASS — the `den_*` tools are callable from the assistant's own turn |

`gate-audit.json` is the seventh artefact and the only one that is not a probe result: it holds the durable record of what the gate refused during that instance's life, with the tool, rule, risk, decision and session but not the arguments.

- **D1 skeleton** — installable plugin, durable state, status surface *(done: bundle registered in a real profile; `fiberPhase: active` through the Host loader)*
- **D2 authority + notices** — grant binding, expiry, dedup *(done, tested)*
- **D3 autonomy kernel** — heartbeat, the four-gate decision, cold wake *(done, tested; the heartbeat resolves its own driver and reads the wake's reply back from the session log — see the three production-breaking defects in [DESIGN.md](DESIGN.md) §2.5)*
- **D4 outbound approval gate** — pre-execute listener plus a monotonic guard, outside the assistant's own prompt *(done, tested; §2.6 records a fourth defect found in the D6 panel half, where the stand-in was a fake runtime rather than a fake service)*
- **D5 memory + status UI** — scenario-isolated memory domains *(done, tested)*; interactive resident panel *(done: registers in the live sidebar, verified through 41 interaction checks and 22 route tests)*
- **D6 7×24** — supervised survival: killed process recovers with no human intervention, verified over a long run
  - *Progress:* the watchdog distinguishes a wedged Host from a healthy one (`StrictHttp`; a TCP-listening-but-HTTP-dead Host was previously logged as healthy), and the plugin's own heartbeat now self-heals instead of deferring permanently. The kernel also runs on its own clock with nobody present: after the instance booted at `05:06:55.290Z` it began ticking on the 60-second cadence and its `lastTickAt` kept advancing across separate checks, none of which the kernel was answering. What is still open is a **long unattended run** — the acceptance criterion is a kill-and-recover observed without a human, not a configuration.
  - *Residency:* "resident" assumes **one Host per state tree**, and `~/.dsh/den` is keyed on `DSH_HOME` rather than on the profile, so two profiles can share one tree. This was measured rather than assumed: with two kernels over one home, `dueTriggers` tells both that the same trigger is due — a read is not a claim — and with the first parked inside its delivery, **the same check-in was delivered twice**. It is a direct consequence of a deliberate ordering recorded at `kernel.js`: the check-in stays due if the process dies mid-delivery, trading a rare duplicate for never losing one. Under one Host that trade is right; under two it made the duplicate routine.
  - *The guard:* `src/resident.js` is an atomic-create lease (`openSync(path, 'wx')`). The kernel is **not** locked out of starting — it stands down per tick and retries, so there is no state in which every Host declines and the assistant goes silent. A holder is reclaimed when it stops renewing *or* when its pid is gone, so a restart takes over on the first tick rather than waiting out the staleness window — with one bound: a pid-negative answer no longer authorises taking over a record younger than `TAKEOVER_GRACE_MS`, because that answer was measured being wrong. Status carries `residency`, and the panel shows it, so a standby Host is distinguishable from a broken one.
  - *Measured across processes, because in-process it cannot be.* `defaultIsAlive(pid)` asks the operating system whether the recorded owner still exists, and inside one process both owners are `process.pid` — so the check is a tautology that an implementation ignoring pid entirely would pass. `test/two-process.test.mjs` runs real children over one home, and each case is falsified rather than trusted: a second process takes residency once the first has exited (make `defaultIsAlive` always true and it fails — "a dead owner must not block the tree"); a second process stands down and names the live holder; two processes looking at one due check-in deliver it **once** (delete the lease and it fails — "and must stand down rather than deliver it"); and a process that is **killed** rather than disposed leaves its lease on disk and the next process recovers residency and delivers it with nobody watching, which is cold recovery with a real kill.
  - *The children used to run on a synthetic clock, and that is what hid the branch.* With one, the two processes' lease timestamps differ by a factor of thousands, so the record always reads as stale and freshness is never decided by whether the owner is alive — all four cases passed without ever asking. They use the real clock now, and the falsification above is what proves the branch is reached: neutering `defaultIsAlive` fails exactly the two dead-owner cases.
  - *The guard, audited in the direction nobody audits:* a gate gets examined for being too broad, and this one had been — an `edit` was refused for containing the text of a rule, twice. The opposite was never checked until the tool table was read against the Host's real registry. `web_search` is `allow` by decision, and the justification written into `test/gate-coverage.test.mjs` was that a credential is caught "whichever tool carries it". For that tool the justification was false: the path rules match *paths* (`.env`, `id_rsa`), so a credential **value** was invisible to them, and the outbound action rules never ran because a search does not push code anywhere. Pasting a key into a query was allowed, with no decision and no audit line, while the same key through a shell command that uploads a body stopped and was logged. The fix is not to make search ask — that removes a resident assistant's ability to search, and in a profile with approvals off `ask` is a silent refusal, which is the pressure that gets gates turned off. It is a **value** rule scoped to the tools whose arguments leave this machine, asking rather than denying because a shape is weaker evidence than a filename. Ordinary searching is untouched, and the scoping is pinned: a rule over shell text would have refused this repository's own credential scanner, because the scanner greps for the shape being looked for.
- *The same audit, run against the filesystem:* the tool table is checked against the Host's registry, and the secret-path table had no equivalent — which showed. Enumerating the credential stores **this machine actually has**, including every one the user's own home instructions name, found five that existed and that `read` was **allowed** on: their `codex/rules` file (which their instructions say carries a live token), `codex/.sandbox-secrets`, `tokenrouter.config.toml`, `kimi-code/credentials`, and the container registry config. Two rules guarded paths that do not exist here at all. The table had been written from what credential files generally look like, and a list built from recollection protects the recollection. `test/gate-coverage.test.mjs` now asserts the stores, so one appearing later fails a test instead of going unnoticed — and the audit caught its own author once more: the `gh` CLI location written from memory did not exist here, and the one that does is under `%APPDATA%`.
- *The platform the author was imagining:* the third instance of the same defect, and the largest. Every outbound rule was shaped like a Unix CLI tool, while this plugin ships to Windows and its shell is PowerShell. Measured: **twelve** distinct ways to move data off this machine — `Invoke-RestMethod`, `Invoke-WebRequest` and its aliases, BitsTransfer upload, a .NET `WebClient`, mail with an attachment, `certutil -urlcache`, `scp`, `rsync`, `ssh`, `nc`, PowerShell remoting — every one of them `allow`, while the same intent through `curl` asked. The control cases were allowed too, so the classifier was working; the table was written for somewhere else. The first fix was wrong in a way worth recording: it anchored the remote-host rules to the start of the text, and `flattenArgs` puts each argument's **key** in front of its value, so the rule matched nothing in production while a test that fed the pattern a bare command string passed. The rules now aim at remote-looking operands, tests go through `classifyCall` with real argument objects, and there is a test named for the trap so the next anchored rule fails loudly.
- *Where the credential guard stops, measured.* The gate matches patterns in tool-call **text**, so what it can and cannot close is worth stating as a measurement rather than a feeling. Naming a credential store — through `read`, through a shell `Get-Content`, or inlined into `node -e` — is `deny`. So is **`write` of a script whose body names one**, because the path rules run on every tool's argument text and a `write` body is argument text: the indirect path is closed at *both* ends, at the read or at the write, whichever comes first. What is **allowed** is `node <script>` itself, because a command line carries none of the text a rule could match — the gate cannot read the file. That is a boundary this repository pins with a test rather than pretends away: it is why DESIGN does not claim credentials can never leave the domain, only that the reflexive paths are closed and every decision is on the record.
- *Deliberate asymmetry:* anything that is not a lost race — an unwritable home, an unreadable record — keeps delivering and records why. A duplicate is recoverable and visible; a resident that silently stopped is neither. Two real defects were found by tests written for those sentences: a sub-millisecond timestamp rounding made a just-written record look like it came from the future and get reclaimed (the crash-window guard silently not guarding), and `mkdirSync` reporting `EEXIST` for a parent path that is a file was misread as a lost race, which would have left a Host standing down permanently.
  - *The mutual exclusion was an argument, and the first time it was measured it fell over.* The comment said create-if-absent **is** the mutual exclusion, so two Hosts reclaiming one stale lease resolve to exactly one. Four real processes released in the same instant over one empty lease produced **three simultaneous owners**. There are two independent causes, and the second one is the interesting one. First, `process.kill(pid, 0)` answers "no such process" for a process that is alive: 0 wrong answers in 24,000 probes from an idle parent, 590 in 48,000 (1.2%) from four siblings probing each other under load, 0 in 384,000 in another run — unreliable *and* condition-dependent, which is worse than a constant error, because it hides. Traced live: a holder one millisecond old was declared gone and its record deleted, while the holder itself went on to report `held: true`. Second, and independent of the probe: **delete-then-create is not mutual exclusion.** Two Hosts that judge the same record free both delete it, and the *second* delete removes the record the first Host just created — so both create successfully and both believe they built the lease. "Exactly one `open` succeeds" only holds if nobody deletes in between, and deleting is the first step of taking over. Both are fixed: the right to take over is itself a create-if-absent, on a name derived from the record being replaced, so every Host that judged *that* record computes the same name and only one proceeds; and a pid-negative answer no longer authorises taking over a young record. The cost of the second one is real and is stated rather than hidden — a holder that dies within a second of its last renew waits one heartbeat — which is why two cross-process tests changed to model a restart as it actually happens. The retry idea was measured and rejected: spaced retries (`Atomics.wait`, 5 ms, four attempts) still produced two owners in 8 of 8 runs, so it stays only as a cheap extra, not as a fix.
  - *And the verifiers had to be rebuilt, because the race tests were not reliable ones.* They **found** the defect, but with either fix removed a single run still passed — the bad interleaving needs a busy machine. Each fix therefore has a **deterministic** in-process verifier, and both were falsified by removal: take out the grace and `a record younger than the grace is not taken over on a liveness answer alone` fails; take out the takeover claim and `a second host cannot take over a record that has already been taken over` fails. A test that only fails when the machine is busy is not a test.
  - *Its route is ungated while the shell it lives in is not — by DSH design, and now on the record.*
- **"Verify passes" and "the running host is stale" were true at the same time.** `npm run check:deployment` exits 1: the host loaded at `2026-10-13T08:43:05.676Z` while `client/client.js` changed at `09:24:00`, so the plugin answering live requests was the code from before the fix — and live verification had been reported in between. The guard already existed and even documented this exact failure mode; it simply is not in `npm run verify`, because it needs a running host, so nothing that ran every round could see it. The running instance now judges itself (`status.freshness`, computed per request rather than cached at boot) and says so in the panel — *older than the tree, restart DSH*, naming the file — because the person who can restart it is the one looking at the panel, and a healthy-looking panel is a stale host's best cover. Two independent walks (the host's own loaded files, and this repository) are cross-checked, but only outside the tolerance, since agreement inside it is not evidence. See DESIGN 2.25.
- **The staleness guard existed; it was just not on the path a single probe takes.** `check-deployment.mjs` correctly reported the host was running code from before `client/client.js` was edited, while six `check:*` probes each exited 0 — they describe the running instance, and each was run on its own, so their passes described code that was not on disk. `verify:live` stops at step 1, but `npm run check:notices` had no gate at all. The guard now runs as its own process, chained in front of every live probe script with `&&`, which makes it inherited by every way of running one. Three outcomes and only one is a pass: loaded this tree, loaded older code, or cannot say — and "cannot say" is a refusal, because a probe describes a running host and there is nothing to describe. The pass path is verified against a synthetic host over a real socket, because a gate that refuses everything is a gate that gets turned off, and a structural test fails if a new live probe is added without the guard. See DESIGN 2.26.
- **The allow-list trap, a fourth time — and now with a test.** `src/panel-api.js` carries a comment saying a new `status()` field is a two-file change of which only one fails loudly. Adding `freshness` failed loudly in exactly that way. So `test/panel-payload-coverage.test.mjs` compares the real `status()` key set against the payload and requires every withheld field to carry a stated reason, with a control proving the check can fail — it found eight fields on its first run, one of which was being renamed rather than dropped.
- **The panel asked for a conversation in a seat that never had one.** The first pixel-level look at the panel came from a screenshot the user sent: it read *standing autonomy: unknown for this view* and *no active conversation* **while a conversation was open**, and its add-self-check button was greyed out. Three independent live measurements said why - the root main slot's own catalog states that only the reserved conversation key receives a Session binding and its standardProps carry no sessionId; the live sessions service has no current() and no ctiveId(); and across 21 plugins in the ecosystem the only occurrences of an ctiveId shape were my own code and my own test double. A unit test in this repo, *the bundle declares sessions, which it reads for the active conversation*, had been requiring the dead path to exist - a green test is not evidence that the thing it tests can run. The grant control and the self-check form now register into conversation.input.dock, whose live catalog lists sessionId among its standard props and which sits directly above the message box - which is where the minted token has to be pasted anyway. See DESIGN 2.24. Trying to screenshot the panel turned up the pair: same origin, same instant, `GET /` answers **401** with "dsh web authentication required" while `GET /dsh-den` answers **200** with the full status document. The host contract says why rather than leaving it to interpretation: `webServer.register(route)` takes no authentication argument, and the shell's token gate lives on a different service (`connection.authorizeIndex` / `requestRejection`), which the index passes through and a route does not. Severity, measured rather than feared: the host binds `127.0.0.1`, and everything this route reports comes from `~/.dsh/den/`, which any process running as this user can already read — so it exposes nothing the filesystem does not. The shell is gated because it carries every session's conversation. It is still worth stating, because a gate open on one side of an origin and shut on the other is surprising, so it is now a live assertion in `check-deployment.mjs`: the shell must be 401/403 and the route 200, and if DSH ever gates plugin routes that line fails and DESIGN 2.18 gets rewritten. Not done, and why: gating the route here would be unverifiable — the hook exists, but the panel `fetch`es from the browser and the authenticated page cannot be reached, because it lives in the desktop client's Electron process while browser automation drives Chrome.
  - *The panel's pixels are still unmeasured, but it is no longer only topology.* The client Inspect provider reads the **live page**: the `main` slot's occupants include `dsh-den` with key `dsh-den.status` and **`active: true`** — the client half is mounted and active in the real page, not only in the offline doubles. Reaching pixels needs the token the Electron process holds, or one authenticated load in Chrome.
  - *A stored trigger that cannot be scheduled used to be reported as healthy.* `isValidStored` checked the envelope — id, sessionId, kind, title, prompt, enabled, fireCount — and none of the fields `nextTriggerAt` reads. Measured with four such records (no `everySeconds`, no `atTime`, no `weekday`, no `at`): `listTriggers` reported `valid=5 invalid=0`, and a query ninety days out returned only the one healthy trigger. A reminder the human is relying on never fired while every surface called it fine — and the docstring already promised these would be "reported and skipped", which they were not, because they never failed validation. The new `isSchedulable` validates exactly what the schedule reads, deliberately no more: requiring a field here would retire every trigger written before it existed, the same harm pointing the other way. `invalid` was already surfaced by `status.triggers.invalid` and the panel's `invalidCount`, so fixing the judgement made them visible with no UI work. The test carries a reverse control (four well-formed shapes must stay valid and schedulable) or "reject everything" would pass it.
  - *And a claim in that file was stronger than the code.* The "catch up in whole steps so a host that was down resumes on the original cadence" branch only runs when the caller asks for a moment later than one step past the last fire. Both callers in this repo pass `lastFiredAt ?? 0` — the same value the arithmetic starts from — so `base + step > after` is always true and it never runs in the shipped system. Measured: `+600000ms` asked the way the callers ask, `+10800000ms` asked the way the unit test asks, a **170-minute** phase difference. That is deliberate for `dueTriggers` — asking "after now" would push a check-in missed during downtime into the future and skip it, the opposite of what capability 2 promises — and the cost is that the cadence re-anchors to the wake that actually ran. The comment says that now. The panel's judgement call (`nextCheckAt` can therefore render a past time) was left alone this round: for a `once` trigger, showing the moment it *should* have fired is also defensible, and UI semantics do not get changed on an unsettled judgement call.
  - *A rare failure was undiagnosable, and now is not.* One full-suite run failed with `timed out waiting for ...round-0-racer-2.json.ready` after 30,395 ms and `child exited 2147483651` — and those two messages between them say nothing, while every other run was 279/279 green. Three causes stacked: the child's stderr was discarded by `stdio: 'ignore'`; the wait polled only for a file, though readiness is announced *before* the racer's spin, so a missing file means the process died rather than that it is busy; and the exit promise's rejection was swallowed, so a fast informative failure became a thirty-second mystery. The child now logs to a file (a file redirect, not a pipe — the confined sandbox refuses pipes, and `ignore` discards the evidence), and the wait races against the children stopping. Pinned deterministically with a `--crash` mode rather than hoped for: **30036 ms → 147 ms**, and the message goes from a missing filename to `racer exited 3 — its log: deliberate startup failure…`. Three removal falsifications, each failing only its own new pin. What this does **not** claim: the underlying flake did not reproduce again this round, so the concurrency defect is not found — only made to arrive with its reason attached. DESIGN 2.20 and 2.21 have the numbers.
  - *The memory that got said twice was the first one to become unreachable.* `remember` refreshes a re-learned fact's `createdAt` in place — that is its documented contract — and `recall` scored `entries.slice(-200)`, the last two hundred in *file* order. So a memory kept its original position, could be the newest thing in the scenario (`entriesFor()[0]`) and still be invisible to recall forever, while `den_scenarios` went on reporting `entries: 250`. Measured on a 250-entry scenario: the needle was the newest by `createdAt` and at file position 0; `recall` found it **`false`**, `considered: 0`. After the fix: **`true`**, `considered: 200`. That direction is backwards for a 7×24 assistant — the memory a human bothered to repeat is the one that disappears first. The second half of the fix matters more than the first: candidates now come from `createdAt`, but the window still silently drops content, so `den_recall` reports `stored` / `considered` / `scored`, and `stored - considered` is exactly what it left out. `considered` had been `scored.length` — the match count under a name promising the looked-at count, which printed `0` when two hundred entries had in fact been scored. The window was **not** removed: scoring all five hundred is a cost bound, and the entries outside it are what eviction would drop next. So the test is pinned from both sides — the newest must be found *and* the oldest must not, using an entry with a token no filler shares and a query it matches perfectly, so only the window can explain its absence. Three removal falsifications, each failing only its own test. Also removed: a `recalls` field that both branches of `remember` wrote and that nothing in `src/`, `src/client/`, `test/` or `tools/` ever read — a field named for an event that never happens. DESIGN 2.22.
  - *And one falsifier of mine reported a false green, recorded because it is the failure mode this project keeps hunting.* All three removal falsifications "passed" on the first run, while the same mutation run on its own failed the very test it was supposed to break. The fault was in my command line: `--test-name-pattern=$pattern` unquoted, so PowerShell split a pattern containing spaces into several arguments. The test really did run, and really was the right one — and it reported success. A falsifier that turns green because the command was malformed is worse than no falsifier, because it manufactures the confidence it exists to remove. The rule now: apply the mutation, confirm it is on disk, and assert that **exactly one** test ran and that it is the intended one. Redone: `tests 1 / fail 1` each, one mutation each, source restored by sha256. DESIGN 2.23.
  - *Still not covered:* the lease is best-effort mutual exclusion, not a distributed lock. The grace bounds how much one wrong liveness answer can destroy; it is not a claim that the probe is trustworthy, and if a wrong answer outlives the grace the takeover still happens. Closing that would mean dropping liveness from the takeover decision entirely and letting a restart wait out `staleMs` — a trade this round did not make on the user's behalf. DESIGN 2.17 has the traces and the numbers.

## 7×24 in two stages

| Stage | Approach | Coverage |
|---|---|---|
| **A. This machine** | Supervise the Host so it restarts itself when killed; the den rides on it | Whenever the machine is on |
| **B. Always** | Run the Host on a server; the self-contained state tree moves wholesale | Including while your machine is off |

Stage B carries one hard prerequisite: `~/.dsh/.credentials.yaml` is **plaintext**. Long-lived credentials must not live on a remote host — use short-lived, explicitly scoped grants instead.

## Relationship to prior work

Built independently, with two projects read as read-only references for *mechanism and hard-won lessons* (no code is copied):

- [ttmouse/dsh-muse](https://github.com/ttmouse/dsh-muse) — human-bound autonomy, keeper re-arming, expiring mailbox
- [86cloudyun-afk/dsh-bot](https://github.com/86cloudyun-afk/dsh-bot) — multi-agent isolation, memory domains, workspace UI

Neither combines standing autonomy with multi-agent structure; that intersection is what this project is for.

This is an **honest positioning, not a green-field claim.** `dsh-muse` publishes its own `docs/gaps.md`, and the top items it lists — a memory seam, event-source ingress, daemonisation, and a mandatory outbound approval point so that credentials never leave the trust domain — are exactly the areas `dsh-den` implements. Read `dsh-den` as a more careful implementation of gaps a released competitor left open, not as a capability that did not previously exist.

**With the outbound point's scope stated rather than implied.** `dsh-den` implements the approval point; it does not implement "credentials never leave the trust domain", and it does not claim to. The gate classifies tool calls by matching patterns against their arguments, so it closes the reflexive and direct paths — a credential-shaped read is refused outright, an upload command is stopped and escalated — and it records every decision durably. It is not a boundary against an adversarial agent: the gate runs in the same process as the agent, which has filesystem and shell access, and a constructed path matches no pattern. Its value is that the costly actions stop and are seen, not that they are impossible. DESIGN 2.14 has the measured half and the unmeasurable half side by side.

## License

MIT
