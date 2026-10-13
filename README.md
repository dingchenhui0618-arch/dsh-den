# dsh-den

> A **7×24 resident personal assistant** for [DeepSeek Harness](https://github.com/deepseek-ai/dsh).
> Not another chat window — an assistant that stays on, keeps its own memory, works while you are away, and stops to ask before it acts outside your trust boundary.

Status: **the core is implemented, tested (226/226), and active in a real profile.** The plugin is loaded inside a real DSH 0.2.0-rc.2 desktop profile — it is in that profile's `dsh.profile.bundles`, and the running host reports it as `fiberPhase: active` — registering 11 model-facing tools, the approval guard, the heartbeat, and an interactive status panel. Verified against the *running* system rather than only in tests: the heartbeat ticks on its 60-second cadence, and the panel is an **active occupant** of both `sidebar.panellist` (`id: dsh-den.status`, order 245) and the `main` panel (`key: dsh-den.status`).

**The running host was serving an older build; it has since been restarted, and the same check that said so now says otherwise.** Before the restart, the `Tool` inspect provider reported a different tool count from this tree's source and `GET /dsh-den` answered 404. Afterwards, `npm run verify:live` reports:

- `GET /dsh-den` → **200** with a well-formed envelope
- `state.json` **written by this boot**, containing `cooldownSeconds`, `createdAt`, `dailyTurnBudget`, `displayName`, `quietHours`, `tickSeconds`, `updatedAt`, `version`
- **11 tools** through the `Tool` inspect provider, byte-for-byte the same names this tree registers
- `transport.browserReachable` **set** — a real browser reached the panel route, which is the one seam that had never been observed

The live status payload then reports the assistant actually running: `kernel.running: true`, `kernel.lastError: null`, a fresh `lastTickAt`, `gate.mounted: true`, and a ledger file on disk with `turns/spoken/skipped/refused` at zero. A scripted drill over the same real socket confirmed the write path end to end — `autonomy/request` minted a 32-character token, `schedules/create` → `schedules/list` → `schedules/delete` round-tripped, and a 10-second interval was correctly refused with `everySeconds must be at least 300`. Everything the drill created was deleted; `~/.dsh/den/triggers/` is empty again.

**The assistant speaking on its own has not happened, but the reason it has not is now measured rather than assumed.** `autonomy` is `null` with `autonomyKnown: false`, because no human has granted it — and `den_set_autonomy` is deliberately on the gate's `ask` tier (`den_explain_gate` reports `verdict: "ask"`, rule `unknown-tool`), so the agent cannot grant it to itself. That is capability 1 working.

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
npm test          # 226 unit + integration tests
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

**After restarting DSH, run `npm run verify:live`.** It is the scripted form of the acceptance this project is judged on, and it refuses to report success while the host is still running an older build. It first runs the deployment check as a falsification step — if `GET /dsh-den` is not 200, nothing after it would be evidence about this tree, so it stops. Then it reads `transport.browserReachable` **before** sending any probe of its own, so any movement it observes afterwards is attributable to something that is not the script.

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
human carries that token to the assistant in the conversation, and the normal
`den_set_autonomy` path performs the write with real human-message evidence behind
it. Schedules are a different risk class and are written directly, because a
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

- **D1 skeleton** — installable plugin, durable state, status surface *(done: bundle registered in a real profile; `fiberPhase: active` through the Host loader)*
- **D2 authority + notices** — grant binding, expiry, dedup *(done, tested)*
- **D3 autonomy kernel** — heartbeat, the four-gate decision, cold wake *(done, tested; the heartbeat resolves its own driver and reads the wake's reply back from the session log — see the three production-breaking defects in [DESIGN.md](DESIGN.md) §2.5)*
- **D4 outbound approval gate** — pre-execute listener plus a monotonic guard, outside the assistant's own prompt *(done, tested; §2.6 records a fourth defect found in the D6 panel half, where the stand-in was a fake runtime rather than a fake service)*
- **D5 memory + status UI** — scenario-isolated memory domains *(done, tested)*; interactive resident panel *(done: registers in the live sidebar, verified through 41 interaction checks and 22 route tests)*
- **D6 7×24** — supervised survival: killed process recovers with no human intervention, verified over a long run
  - *Progress:* the watchdog distinguishes a wedged Host from a healthy one (`StrictHttp`; a TCP-listening-but-HTTP-dead Host was previously logged as healthy), and the plugin's own heartbeat now self-heals instead of deferring permanently. What is still open is a **long unattended run** — the acceptance criterion is a kill-and-recover observed without a human, not a configuration.

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

## License

MIT
