# dsh-den

> A **7×24 resident personal assistant** for [DeepSeek Harness](https://github.com/deepseek-ai/dsh).
> Not another chat window — an assistant that stays on, keeps its own memory, works while you are away, and stops to ask before it acts outside your trust boundary.

Status: **the safety-critical core is implemented and tested (76/76).** The plugin is installed into a real DSH 0.2.0-rc.2 profile and resolves through the Host's own loader. Live activation is pending a Host restart; per-scenario memory and the status widget are next. See [DESIGN.md](DESIGN.md) for the architecture and acceptance criteria.

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
| `src/triggers.js` | Schedule definitions (`once` / `interval` / `daily` / `weekly`) with a 300-second interval floor, a bounded prompt, and cadence that survives a shutdown without replaying a backlog. |
| `src/kernel.js` | The heartbeat and the three gates: **quiet hours → pacing and budget → value**. Re-entrancy guarded, every refusal recorded in a durable daily ledger. |
| `src/gate.js` | The outbound approval gate: credentials refused, outbound actions questioned, unknown tools fail closed. Installed as *both* a pre-execute listener and a monotonic guard. |
| `src/index.js` | Plugin entry point, seven model-facing tools, and the wiring. Zero external imports. |

All state lives in a **self-contained** `$DSH_HOME/den/` tree, so it can be packed and moved to another machine or a server without hunting through unrelated DSH storage.

```bash
node --test test/primitives.test.mjs test/kernel.test.mjs test/gate.test.mjs test/mount.test.mjs
```

### Verified Host contracts

These were read out of the running Host rather than assumed, and two of them changed the implementation:

- `@deepseek-ai/cordis` is **not resolvable** from a profile's `node_modules`. A plugin that imports it fails to load, so `dsh-den` uses only the injected `ctx`.
- A lazily resolved `ctx.get('tools')` is **not** the same object as the injected `ctx.tools` property. Both the gate and the tool registration take the registry as an explicit parameter because of this.
- `PreToolDecision.displayReason` is a **localised object** (`{ en: string, [locale]: string }`), not a string. `info` exists only on the `deny` branch.
- `ToolExecution.agent` is **optional**; `signal` is required.
- `agent/status` carries exactly `'idle' | 'running'`, and `.status` is the state *just entered*.
- `ctx.tools.guard(...)` is documented as **monotonic**: no guard can force-allow what another guard denied. That is why the hard rules are installed there and not only on the waterfall.
- ASAR note for anyone reading the shipped packages: the archive contains **no `.d.ts` files at all**. The only verbatim TypeScript declarations live in the generated `dsh-tool-cordis/lib/types/api-catalog.js`.

## Roadmap

- **D1 skeleton** — installable plugin, durable state, status surface *(done: bundle registered in a real profile; entry resolves through the Host loader; activation pending a Host restart)*
- **D2 authority + notices** — grant binding, expiry, dedup *(done, tested)*
- **D3 autonomy kernel** — heartbeat, the three-gate decision, cold wake *(done, tested; delivery path is wired)*
- **D4 outbound approval gate** — pre-execute listener plus a monotonic guard, outside the assistant's own prompt *(done, tested)*
- **D5 memory + status UI** — per-scenario memory domains, resident status surface *(next)*
- **D6 7×24** — supervised survival: killed process recovers with no human intervention, verified over a long run

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

## License

MIT
