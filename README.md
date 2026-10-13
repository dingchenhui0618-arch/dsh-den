# dsh-den

> A **7×24 resident personal assistant** for [DeepSeek Harness](https://github.com/deepseek-ai/dsh).
> Not another chat window — an assistant that stays on, keeps its own memory, works while you are away, and stops to ask before it acts outside your trust boundary.

Status: **the core is implemented, tested (235/235), and active in a real profile.** The plugin is loaded inside a real DSH 0.2.0-rc.2 desktop profile — it is in that profile's `dsh.profile.bundles`, and the running host reports it as `fiberPhase: active` — registering 11 model-facing tools, the approval guard, the heartbeat, and an interactive status panel. Verified against the *running* system rather than only in tests: the heartbeat ticks on its 60-second cadence, and the panel is an **active occupant** of both `sidebar.panellist` (`id: dsh-den.status`, order 245) and the `main` panel (`key: dsh-den.status`).

**And it reproduces from this repository alone.** A fresh `git clone` of the published repo — no `node_modules`, because the package declares **no dependencies at all** — runs the whole suite green:

```
node_modules present in clone: False
dependencies declared: (none)
ℹ tests 235   ℹ pass 235   ℹ fail 0
test exit: 0
```

That is the claim worth making precisely: not "it works on my machine", but *a third party with a Node binary and nothing else can check this*. It is also the check that would have caught the worst bug in this project's history — a `.gitignore` line reading bare `lib/` matched at any depth, so a source file that three live probes imported was **never committed**, and the pushed repo was broken while every local test passed. `npm run check:source-tracked` now asserts that every source file on disk is tracked by git, and names the ignore rule that hid it.


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

1. Enable approval prompts for the session. With them off, `ask` resolves to a denial and `den_set_autonomy` is refused automatically — which is the correct fail-closed behaviour, and also why an approval-disabled session can never complete this flow.
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

**What is *not* yet observed, stated precisely.** The panel's `call()` and the host's route handler are verified against each other end to end, in one process, by `test/roundtrip.test.mjs` — the request bytes, the response bytes, and the payload the panel receives. What has never run is that pair underneath the real Cordis client loader, over a real socket, in a real browser. The host process currently running still executes pre-fix code — the panel's new route is absent from it (`GET /dsh-den` answers 404 while its siblings `GET /dsh-warden` and `GET /dsh-vision-diff` answer 200 with full JSON) — and plugin changes are not hot-reloaded into a running host. So the remaining unknown is the loader and the socket, not the contract. `den_status` reports `transport.browserReachable` once a real request lands, which is how that last step reports itself. See [DESIGN.md](DESIGN.md) for the measurements.

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
3. **A notice has a shelf life.** Observation and reminder notices expire after 12 hours and are then *deliberately not delivered*. One recorded incident had calendar reminders queueing for 37–80 hours while their session was offline, then firing long after they mattered — **a reminder delivered too late is worse than one never delivered.** Ideas are exempt.
4. **Failure degrades, it does not throw.** A missing, stale, foreign, or corrupt authorization record resolves to "not authorized". Throwing would turn one bad file into a denial of service; trusting it would turn one bad file into a privilege escalation.

## Implemented so far

| Module | What it does |
|---|---|
| `src/atom.js` | Crash-safe JSON persistence: atomic publish, fsync barriers, content-addressed "publish once", validation-gated reads. Directory fsync degrades gracefully where the platform forbids it (Windows). |
| `src/grant.js` | Human-bound standing autonomy. Verifies the grant against the immutable session log; refuses to record authority for a caller that is not a live direct human driver. |
| `src/notices.js` | Durable notices with a 12-hour expiry for observations, no expiry for ideas, and content-hash deduplication. |
| `src/triggers.js` | Schedule definitions (`once` / `interval` / `daily` / `weekly`) with a 300-second interval floor, a bounded prompt, and cadence that survives a shutdown without replaying a backlog. A wake that was admitted but never reached the conversation is **retried** (15-minute throttle) instead of being charged and lost. |
| `src/kernel.js` | The heartbeat and the four gates: **authority → budget → quiet → pacing**. Re-entrancy guarded, every refusal recorded in a durable daily ledger, and the cadence advance committed only *after* a wake is delivered. |
| `src/memory.js` | Scenario-isolated long-term memory: one file per scenario, so personal context is structurally unable to surface while working in another domain. Deterministic keyword-plus-recency recall, no embeddings, corruption degrades to an empty store. |
| `src/gate.js` | The outbound approval gate: credentials refused, outbound actions questioned, unknown tools fail closed. Installed as *both* a pre-execute listener and a monotonic guard, and every tool this profile exposes is classified explicitly — an unlisted tool that falls to the fail-closed default becomes an automatic rejection wherever prompts are disabled. |
| `src/panel-api.js` | The panel's action surface: the status snapshot and the six named actions, with no transport in them. Read-only actions and authority-changing ones are deliberately separated — see below. |
| `src/panel-route.js` | One prefix route on the host web server at `/dsh-den`, exposing that surface as JSON. The same shape every other client plugin in this profile uses. |
| `src/client/client.js` | The browser half: a hand-written lazy-CJS bundle with no build step, registering the sidebar entry and the panel, and reaching the host with the browser's own `fetch('/dsh-den')`. Grants nothing on its own. |
| `src/index.js` | Plugin entry point, eleven model-facing tools, and the wiring. Zero external imports. |

All state lives in a **self-contained** `$DSH_HOME/den/` tree, so it can be packed and moved to another machine or a server without hunting through unrelated DSH storage.

```bash
npm test          # 229 unit + integration tests
npm run check:bundle   # 31 offline bundle-contract checks
npm run check:ui       # 41 panel interaction checks
npm run check:acceptance   # the two reliability goals, as one observable lifecycle
npm run check:package      # what a tarball install actually ships (static, offline)
npm run check:install      # packs a real tarball, installs it, loads what was installed
npm run verify         # all six, hermetic, no host required

# these three need the running host instead of a fixture, so they are not in `verify`
npm run verify:live    # after a restart: is the host serving this tree, end to end?
npm run check:deployment   # just the deployment half of the above
npm run check:tools        # disk evidence that den_* tools were really invoked
```

**`check:package` and `check:install` answer different questions, and both are needed.** The first reimplements npm's `files` rules so it can run offline — it answers *would these files ship?* The second runs `npm pack`, extracts the tarball into a directory with no access to this repository, and brings the plugin up from there — it answers *does what ships actually work?* Since the objective is a plugin that is **installed** on a real host, installability is a claim worth testing rather than assuming. It deletes its temp directory in a `finally`, including on failure.

**After restarting DSH, run `npm run verify:live`.** It is the scripted form of the acceptance this project is judged on, and it refuses to report success while the host is still running an older build. It first runs the deployment check as a falsification step — if `GET /dsh-den` is not 200, nothing after it would be evidence about this tree, so it stops.

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
| `check-live-notices` | PASS — the expiry rule holds in the host's own directory |
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
