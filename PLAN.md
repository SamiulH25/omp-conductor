# omp-conductor roadmap

Goal: make omp-conductor a real subagent orchestrator. Phase 1 is `/btw`, so the orchestrator can ask a slow worker what it is doing without disturbing it. Later phases follow the feature list from the brainstorm.

## Phase 1: `/btw` and `pi_btw`

### Problem
A worker that runs long gives the orchestrator only `pi_status`/`pi_digest` (what it did) and `pi_send` (a steer that lands after the current turn, becomes part of the worker's context and can derail it). There is no way to ask "what is taking so long?" and get a live answer.

### Design
A Pi extension, `extensions/btw.ts`, loaded into every worker next to `guard.ts` (`-e`). It registers a `/btw <question>` command, and a new MCP tool `pi_btw` sends it.

Facts checked in the Pi docs (`rpc-commands.md`, `extensions.md`):
- A `prompt` that is an extension command executes immediately, even while the agent is streaming. This is what makes mid-run asking possible. `steer` and `follow_up` do not allow extension commands, so the plugin must use `prompt`.
- Extensions can make nested model calls with `ctx.modelRegistry.streamSimple()` and read the session with `ctx.sessionManager.getBranch()`.

How it works:
1. `/btw <q>` handler reads the worker's current branch (task, tool calls, results so far, the in-flight partial turn if available).
2. It makes a separate model call: same model, **no tools**, a short system prompt ("Answer the supervisor's side question about your own progress: what you are doing now, why it is slow, what is left, whether you are stuck. 5 sentences max."). The worker's context is not modified.
3. The answer is written to `$PI_BTW_DIR/<n>.json` (`{q, a, at}`), since it must not enter the worker's conversation.
4. The plugin sends `{type:"prompt", message:"/btw <q>"}` and waits for that file, up to 60 s.

Why a file and not a transcript message: `pi.sendMessage()` would add to the worker's context, which is exactly what `/btw` must avoid. If the docs show a cleaner side channel (the RPC extension UI protocol, `rpc-extension-ui.md`), use that instead. Verify before building.

### Orchestrator side (`register.tsx`)
- New tool `pi_btw { id, question?, wait? }`. Default question: "What exactly are you doing right now, why is it taking this long, what is left, and are you stuck?". Returns the answer plus the worker's last activity and elapsed time. Refuses for a worker that has no live process (use `pi_digest` or `pi_send`).
- New slash command `/btw <id> [question]` for the user, same behaviour.
- Add `w.btwDir` to the worker, create it in `startProc`, pass `PI_BTW_DIR` in env.
- Cost: each ask is one short model call with the full session as input. Record it in the worker's cost. Rate-limit to one ask per worker per 30 s, and cap at 5 per worker unless `force`.
- Skill update (`orchestrate-pi`): when `pi_wait` says a worker is quiet or over its expected time, call `pi_btw` before killing or re-steering it. A btw answer of "stuck" or a loop leads to `pi_send` with a steer or `pi_kill`.

### Auto-btw (optional, after the manual version works)
When a worker has had no progress for N minutes (no new files, same tool repeated), `pi_wait` calls `btw` itself and includes the answer in the wake-up line. This also seeds stuck/loop detection (Phase 4).

### Risks and checks
- The extension command must really run mid-stream. Test with `tests/fake-pi.mjs`-style harness and one real `pi --mode rpc` run with a long bash tool call.
- The nested call must not touch the worker's session file. Check the session file is unchanged after a btw.
- Guard against `/btw` being sent as a normal prompt to a Pi that lacks the extension (resumed old sessions): detect the `handled` disposition; if it comes back `started` or `queued`, abort that run and report that btw is unavailable.
- If the model call fails (rate limit, provider error), return the error text, never hang.

### Done when
- `pi_btw` on a worker mid-bash returns an answer in under 20 s while the worker keeps running.
- The worker's transcript and cost-per-turn are unchanged apart from the btw call being counted.
- `/btw` works from the Claude Code command line.

## Phase 2: scheduling and cost
1. Spawn queue: at `MAX_WORKERS`, queue instead of refusing.
2. Per-agent-type models: `/pi-model explore|dev|review <model>`; codex stays opt-in via `/codex-worker`.
3. Budgets: max cost/tokens per worker and per session, warn at 80%, kill at 100%.
4. Dependencies: `after: [ids]`, upstream digests injected into the downstream brief.

## Phase 3: quality and safety
5. Review chaining: `reviewBy` spawns a reviewer on the diff and feeds findings back through `fixRounds`.
6. File ownership: `owns: [globs]`, overlap rejected at spawn, enforced in `guard.ts`.
7. Merge queue: rebase on main, run required checks after the merge, auto-revert on failure.
8. Best-of-N: race N workers/models, pick by `verify` result or a reviewer.

## Phase 4: control and visibility
9. Persistence: worker registry on disk so `pi_status` can find and resume workers after a restart (`session.end` currently kills them all).
10. Interrupt: `pi_send interrupt:true` aborts a running worker and redirects it.
11. Stuck/loop detection, using btw answers as a signal.
12. `pi_log`: read a worker's event stream by range.

## Phase 5: extensibility
13. `pi_map`: one task template over N targets with a concurrency cap.
14. Planner agent type that outputs a task DAG for approval.
15. User-defined agent types in a config file instead of the `AGENTS` table.
16. Shared handoff notes between workers in a batch.

## Order
Phase 1 first (smallest, directly fixes the "why is it slow" problem). Then the spawn queue, per-type models and budgets from Phase 2, since they are small and cut cost. Persistence (item 9) is the largest change and goes after those. Each phase gets a plugin version bump and README/skill updates.

## Phase 6: manager workers (sub-orchestrators)

### Problem
The orchestrator hands a worker a whole feature and the worker grinds on it for too long. Fix: each feature goes to a **manager** worker that breaks it down and launches its own sub-workers, acting as a sub-orchestrator. The manager reports back to the main orchestrator for approval.

### Rules
- The main orchestrator talks only to its **direct children**: managers, and any plain workers it launched itself. It never addresses a manager's sub-workers.
- Only a `manager` can launch sub-workers. Plain workers (dev/general/explore/review/planner/custom) cannot, and a sub-worker can never be a manager (depth is exactly 2).
- A manager finishes -> state `done` with a report; the orchestrator reviews it (`pi_digest`, `pi_diff`) and approves with `pi_merge`, or sends corrections with `pi_send` (the manager keeps its context and its sub-workers).

### Shape
- `pi_spawn { agent: "manager", task: <feature>, maxSubWorkers?, maxCost?, ... }`. Built-in agent type `manager`: tools `read, grep, find, ls, bash` (no edit/write: it must delegate, not implement) plus the manager tools below. Own worktree + branch like a dev worker; it is the **integration branch** for the feature. Default `maxMinutes` 60, `effort` from the usual settings.
- Sub-workers are created from the manager's worktree HEAD, each in its own worktree/branch, so the manager merges them into its branch (`sub_merge`) and runs `check` there. The orchestrator then `pi_merge`s the manager's branch into main exactly as for any worker.
- Slots: running non-manager workers (top-level or sub) count against `MAX_WORKERS` (4) globally; managers do not (they mostly wait), but at most 4 managers run at once. A manager may have at most `maxSubWorkers` (default 3) running at a time; more are queued by the normal queue.
- Cost: a sub-worker's cost rolls up into its manager's cost, and the manager's `maxCost` / the session cap cover the whole subtree. Killing or cleaning up a manager cascades to its sub-workers.
- Visibility: `pi_status`/pane/`pi_wait` list managers and the orchestrator's own workers; sub-workers appear indented under their manager in `pi_status` (and nested in the pane) but are never targets for orchestrator tools (they are refused with "w7 belongs to manager w3; talk to w3"). A manager's digest includes a rollup of its sub-workers (state, files, cost, warnings) and its own final report. `pi_wait` wakes on direct children only (plus a manager's ⚠ when one of its sub-workers fails or is stuck).
- Stuck detection ignores a manager while it is blocked inside `sub_wait`.

### Manager tools (a Pi extension, `extensions/manager.ts`, loaded only into managers)
Registered with Pi's tool API; each tool call is a request over a file bridge to the plugin, which executes it with the **same internal functions** as the orchestrator tools, restricted to that manager's children:
`sub_spawn {task, agent?, title?, owns?, after?, maxMinutes?, effort?, skills?, checks?, verify?, codex?}` (agent is one of dev|general|explore|review|planner or custom, never manager; returns the id), `sub_wait {ids?, timeoutSec?(default 120, max 600), mode?: first|all}` (event-driven like `pi_wait`, returns digests of what changed), `sub_status {}`, `sub_digest {id, detail?}`, `sub_diff {id}`, `sub_send {id, message, interrupt?}`, `sub_merge {id, message?}` (merges the sub-worker branch into the manager's branch), `sub_cleanup {id, force?}`, `sub_kill {id}`, `sub_log {id, from?, count?}`, `sub_btw {id, question?}`.

### Bridge contract (exact)
- Env `PI_MGR_DIR` = absolute per-manager dir with subdirs `req/` and `res/` (plugin creates both; `${agentDir}/run/<stableKey>.mgr`).
- Tool call -> extension writes `req/<reqId>.json.tmp`, renames to `req/<reqId>.json`: `{"id": reqId, "tool": "sub_spawn", "args": {...}}`, then polls `res/<reqId>.json` every 300 ms until the tool's timeout (default 660 s; `sub_wait` uses its own timeoutSec + 30 s) and returns its `text` to the model; `ok:false` becomes a tool error.
- Plugin scans `req/` of every running manager about every 500 ms (only while a manager runs), handles each request once, writes `res/<reqId>.json.tmp` -> `res/<reqId>.json`: `{"id": reqId, "ok": boolean, "text": string}`, and deletes the request file. Requests from a non-manager or for a worker that is not the caller's child are answered `ok:false`. Handlers must never throw; unknown tools get `ok:false`.
- If the manager is aborted/killed, pending `sub_wait` requests are answered `ok:false, text: "manager stopped"`.

### Work split
1. **Plugin side** (`hooks/register.tsx`): `manager` agent type, `parent`/`children` on workers (persisted in the registry), bridge scanner + handlers refactored to share code with the pi_* tools, slot/cost/budget accounting, visibility rules, cascades, `/pi-status` tree, manager worktree-as-base for sub-workers, `maxSubWorkers`, manager role prompt.
2. **Pi side** (`extensions/manager.ts` + `tests/manager-smoke.mjs`): the extension and a smoke test against a real `pi --mode rpc` with a fake plugin responder.
3. Docs/skill (orchestrator): README + `orchestrate-pi` skill describing manager mode.
